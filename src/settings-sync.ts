/**
 * Settings sync, the account half: a member's nixamp settings as one snapshot
 * under a revision, kept on nixamp.com against the account like favourites
 * and layouts are.
 *
 * The rules (one digest both sides compute, a conflict rather than a merge
 * when two machines both saved, ten revisions kept) are @profullstack/synconfig's;
 * this file is the store over the directory's Postgres and the three routes,
 * answered the way the rest of the API answers.
 *
 *   GET  /api/v1/settings            the latest snapshot, or { empty: true }
 *   PUT  /api/v1/settings            { snapshot, ifRevision } → a revision, or 409
 *   GET  /api/v1/settings/revisions  what is kept
 */
import { KEEP_REVISIONS, handleGet, handlePut, handleRevisions, type HandlerReply, type Snapshot, type SnapshotStore, type StoredSnapshot } from "@profullstack/synconfig/server";
import type { Queryable } from "./follows.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings_snapshots (
    account_id  TEXT NOT NULL,
    revision    INTEGER NOT NULL,
    digest      TEXT NOT NULL,
    host        TEXT,
    version     TEXT,
    size        INTEGER NOT NULL,
    body        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, revision)
  );
`;

/** A snapshot PUT may be this large; the rest of the API reads 64 KB bodies. */
export const SETTINGS_BODY_LIMIT = 300 * 1024;

const shape = (row: Record<string, unknown>): StoredSnapshot => ({
  revision: Number(row["revision"]),
  digest: String(row["digest"]),
  host: (row["host"] as string | null) ?? null,
  version: (row["version"] as string | null) ?? null,
  size: Number(row["size"]),
  body: (typeof row["body"] === "string" ? JSON.parse(row["body"] as string) : row["body"]) as Snapshot,
  savedAt: new Date(row["created_at"] as string | Date).toISOString(),
});

export class SettingsSync {
  private ready: Promise<void> | null = null;
  readonly store: SnapshotStore;

  constructor(private readonly db: Queryable) {
    this.store = {
      latest: (accountId) => this.latest(accountId),
      insert: (accountId, entry, ifRevision) => this.insert(accountId, entry, ifRevision),
      list: (accountId, limit) => this.list(accountId, limit),
    };
  }

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async latest(accountId: string): Promise<StoredSnapshot | null> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT revision, digest, host, version, size, body, created_at FROM settings_snapshots
        WHERE account_id = $1 ORDER BY revision DESC LIMIT 1`,
      [accountId],
    );
    return rows[0] ? shape(rows[0]) : null;
  }

  /**
   * The revision is chosen inside the INSERT and the precondition is checked
   * there, by a HAVING on the same aggregate, so two machines saving at once
   * produce one revision and one conflict. The primary key is the backstop.
   */
  async insert(accountId: string, entry: { digest: string; host: string | null; version: string | null; size: number; body: Snapshot }, ifRevision: number | null) {
    await this.ensure();
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await this.db.query(
        `INSERT INTO settings_snapshots (account_id, revision, digest, host, version, size, body)
         SELECT $1, COALESCE(MAX(revision), 0) + 1, $2, $3, $4, $5, $6::jsonb
           FROM settings_snapshots WHERE account_id = $1
         HAVING $7::int IS NULL OR COALESCE(MAX(revision), 0) = $7::int
         RETURNING revision, created_at`,
        [accountId, entry.digest, entry.host, entry.version, entry.size, JSON.stringify(entry.body), ifRevision],
      ));
    } catch (error) {
      if (/duplicate key|unique/i.test(String((error as Error).message))) rows = [];
      else throw error;
    }
    if (!rows[0]) {
      const current = await this.latest(accountId);
      return { conflict: true as const, revision: current?.revision ?? 0 };
    }
    const revision = Number(rows[0]["revision"]);
    await this.db.query(`DELETE FROM settings_snapshots WHERE account_id = $1 AND revision <= $2`, [accountId, revision - KEEP_REVISIONS]);
    return { revision, savedAt: new Date(rows[0]["created_at"] as string | Date).toISOString() };
  }

  async list(accountId: string, limit: number) {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT revision, digest, host, version, size, created_at FROM settings_snapshots
        WHERE account_id = $1 ORDER BY revision DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((row) => {
      const { body: _body, ...rest } = shape({ ...row, body: "{}" });
      void _body;
      return rest;
    });
  }

  /** One request, once the account is known. Pure over the store, so the route test needs no socket. */
  async handle(method: string, path: string, accountId: string, body: unknown): Promise<HandlerReply> {
    if (path === "/api/v1/settings/revisions") {
      if (method !== "GET") return { status: 405, body: { error: "GET only" } };
      return handleRevisions(this.store, accountId);
    }
    if (method === "GET") return handleGet(this.store, accountId, { emptyStatus: 200 });
    if (method === "PUT") return handlePut(this.store, accountId, body);
    return { status: 405, body: { error: "GET or PUT" } };
  }
}

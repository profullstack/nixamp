/**
 * Open directories somebody found, kept as a list anyone can read.
 *
 * Deliberately not the stream directory. That one lists what is playing right
 * now: a heartbeat, a TTL, a room code, somebody at the other end. An open
 * directory is the opposite in every one of those respects. It is always there,
 * nobody is broadcasting it, and it is not the finder's to broadcast. Mixing
 * the two would put "chovy is playing this, dial in" next to "here is a link
 * to a stranger's file server" under one heading.
 *
 * Public to read and signed in to add, because a public list with nobody
 * accountable for its rows is a public list of whatever anybody felt like
 * putting there. What is shown against a row is the finder's handle, never the
 * address they signed up with.
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "./follows.ts";
import { cleanUrl } from "./servers.ts";

const TABLE = "nixamp_opendirs";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    added_by    TEXT NOT NULL,
    tracks      INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_url ON ${TABLE} (url);
  CREATE INDEX IF NOT EXISTS ${TABLE}_added ON ${TABLE} (created_at DESC);
`;

export interface OpenDir {
  id: string;
  url: string;
  name: string;
  /** How many playable files were on the page when it was added. */
  tracks: number;
  /** The finder's public handle. Never their address. */
  by: string;
  createdAt: number;
}

/**
 * The name to show for a folder nobody named.
 *
 * The last path segment, which for a folder of music is the album, written the
 * way a person wrote it rather than the way a URL spells it.
 */
export function nameOfDir(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last).slice(0, 120) : new URL(url).host;
  } catch {
    return "an open directory";
  }
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? 0 : at;
  }
  return typeof value === "number" ? value : 0;
}

export class OpenDirs {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /**
   * The list, newest first, in pages.
   *
   * Keyset on the row's own creation time rather than an offset, because a list
   * anybody may add to shifts under a reader who is paging through it, and an
   * offset in a shifting list repeats and skips rows.
   */
  async list(limit = 50, before = 0): Promise<{ rows: Omit<OpenDir, "by">[]; addedBy: string[]; next: number }> {
    await this.ensure();
    const size = Math.min(200, Math.max(1, limit));
    const { rows } = await this.db.query(
      `SELECT id, url, name, added_by, tracks, created_at FROM ${TABLE}
        ${before > 0 ? "WHERE created_at < $2" : ""}
        ORDER BY created_at DESC LIMIT $1`,
      before > 0 ? [size + 1, new Date(before).toISOString()] : [size + 1],
    );

    // One more than asked for, so "is there another page" is a fact rather
    // than a guess from a full one.
    const page = rows.slice(0, size);
    return {
      rows: page.map((row) => ({
        id: String(row["id"] ?? ""),
        url: String(row["url"] ?? ""),
        name: String(row["name"] ?? ""),
        tracks: Number(row["tracks"] ?? 0),
        createdAt: asTime(row["created_at"]),
      })),
      addedBy: page.map((row) => String(row["added_by"] ?? "")),
      next: rows.length > size ? asTime(page[page.length - 1]?.["created_at"]) : 0,
    };
  }

  /**
   * Publish one. `tracks` is what the finder's server actually saw on the page,
   * so a row nobody can play never reaches the list.
   */
  async add(userId: string, url: unknown, name: unknown, tracks: number): Promise<Omit<OpenDir, "by"> | null> {
    const clean = typeof url === "string" ? url.trim() : "";
    // Not cleanUrl's origin-only treatment: a folder is a path, and the path is
    // the whole point of the row.
    if (!/^https?:\/\//i.test(clean) || cleanUrl(clean) === "") return null;
    if (tracks <= 0) return null;

    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO ${TABLE} (id, url, name, added_by, tracks) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url) DO UPDATE SET name = EXCLUDED.name, tracks = EXCLUDED.tracks
       RETURNING id, url, name, tracks, created_at`,
      [
        randomBytes(8).toString("hex"),
        clean,
        (typeof name === "string" && name.trim() ? name.trim() : nameOfDir(clean)).slice(0, 120),
        userId,
        Math.min(100_000, tracks),
      ],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row["id"] ?? ""),
      url: String(row["url"] ?? ""),
      name: String(row["name"] ?? ""),
      tracks: Number(row["tracks"] ?? 0),
      createdAt: asTime(row["created_at"]),
    };
  }

  /** Only the finder takes their own row down. */
  async remove(userId: string, id: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      `DELETE FROM ${TABLE} WHERE id = $1 AND added_by = $2 RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  }
}

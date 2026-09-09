/**
 * The servers a person runs.
 *
 * A nixamp is a machine somewhere with an address and a key, and until now the
 * only record of one was the share link in whatever terminal printed it. Lose
 * the terminal and you have lost the server: the daemon is still playing, and
 * nothing anywhere can tell you where. This is the list, kept against the
 * account rather than the machine, so it reads the same from the CLI, the PWA
 * and the desktop app.
 *
 * The share key is optional and, when given, is the listen-or-control secret
 * for somebody else's machine sitting in our database. It is stored because a
 * list you cannot click is half a feature, and it is optional because that is
 * a choice which belongs to the person whose server it is.
 */
import { randomBytes } from "node:crypto";
import type { Account } from "./accounts.ts";
import type { Queryable } from "./follows.ts";

const TABLE = "nixamp_servers";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL,
    share_key    TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS ${TABLE}_user ON ${TABLE} (user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_user_url ON ${TABLE} (user_id, url);
`;

export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  /** Empty when the owner chose not to keep it here. */
  key: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

/** What a caller may set. Anything else is the server's business. */
export interface ServerInput {
  name?: string;
  url?: string;
  key?: string;
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return typeof value === "number" ? value : null;
}

function toEntry(row: Record<string, unknown>): ServerEntry {
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    url: String(row["url"] ?? ""),
    key: String(row["share_key"] ?? ""),
    createdAt: asTime(row["created_at"]) ?? 0,
    updatedAt: asTime(row["updated_at"]) ?? 0,
    lastSeenAt: asTime(row["last_seen_at"]),
  };
}

/**
 * An address a browser could open, with nothing else smuggled in.
 *
 * A stored URL is handed back to other clients and put in an href, so a
 * javascript: or data: entry here is a link somebody else clicks. Only http
 * and https, and nothing after the origin: a nixamp is a host and a port.
 */
export function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.origin;
}

/** A name is a label, not an essay, and never empty on screen. */
export function cleanName(value: unknown, url: string): string {
  const given = typeof value === "string" ? value.trim().slice(0, 60) : "";
  if (given) return given;
  // The host is a better default than "untitled", and it is what somebody
  // would have typed anyway.
  try {
    return new URL(url).host;
  } catch {
    return "a nixamp";
  }
}

export class Servers {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async list(userId: string): Promise<ServerEntry[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT id, name, url, share_key, created_at, updated_at, last_seen_at FROM ${TABLE}
        WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows.map(toEntry);
  }

  /**
   * Remember a server, or update the one already at that address.
   *
   * Upserted on the address rather than refused, because the common way to
   * call this twice is a daemon announcing itself after a restart, and that
   * should move the entry forward rather than fail.
   */
  async add(account: Account, input: ServerInput): Promise<ServerEntry | null> {
    const url = cleanUrl(input.url);
    if (!url) return null;
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO ${TABLE} (id, user_id, name, url, share_key, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, url) DO UPDATE
         SET name = EXCLUDED.name, share_key = EXCLUDED.share_key,
             updated_at = NOW(), last_seen_at = NOW()
       RETURNING id, name, url, share_key, created_at, updated_at, last_seen_at`,
      [
        randomBytes(8).toString("hex"),
        account.id,
        cleanName(input.name, url),
        url,
        typeof input.key === "string" ? input.key.slice(0, 200) : "",
      ],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  /** Scoped to the owner, so somebody else's id changes nothing. */
  async update(userId: string, id: string, input: ServerInput): Promise<ServerEntry | null> {
    await this.ensure();
    const url = input.url === undefined ? undefined : cleanUrl(input.url);
    if (input.url !== undefined && !url) return null;
    const { rows } = await this.db.query(
      `UPDATE ${TABLE}
          SET name = COALESCE($3, name),
              url = COALESCE($4, url),
              share_key = COALESCE($5, share_key),
              updated_at = NOW()
        WHERE user_id = $1 AND id = $2
        RETURNING id, name, url, share_key, created_at, updated_at, last_seen_at`,
      [
        userId,
        id,
        input.name === undefined ? null : cleanName(input.name, url ?? ""),
        url ?? null,
        input.key === undefined ? null : input.key.slice(0, 200),
      ],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      `DELETE FROM ${TABLE} WHERE user_id = $1 AND id = $2 RETURNING id`,
      [userId, id],
    );
    return rows.length > 0;
  }
}

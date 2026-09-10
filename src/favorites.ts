/**
 * The servers an account has hearted.
 *
 * Distinct from following, which is about a person -- being told when they go
 * live -- and from "your servers", which are the machines you run. A
 * favourite is a place you like to go back to: somebody else's server, kept by
 * its address, with the name it had when you hearted it so the list reads as
 * names rather than URLs.
 *
 * Kept on nixamp.com against the account, like follows, and reached by the
 * same session. Listening needs no account; remembering where you listened
 * does.
 */
import type { Queryable } from "./follows.ts";

export interface Favorite {
  url: string;
  name: string;
  addedAt: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS favorites (
    account_id  TEXT NOT NULL,
    url         TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, url)
  );
`;

const MAX_URL = 500;
const MAX_NAME = 60;

/** A server address worth keeping: http(s), and nothing a browser cannot open. */
export function favoriteUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim().slice(0, MAX_URL);
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return text;
  } catch {
    return "";
  }
}

export class Favorites {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /** Heart it. Hearting it again keeps the newer name. */
  async add(accountId: string, url: string, name: string): Promise<boolean> {
    const address = favoriteUrl(url);
    if (!accountId || !address) return false;
    await this.ensure();
    await this.db.query(
      `INSERT INTO favorites (account_id, url, name) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, url) DO UPDATE SET name = EXCLUDED.name`,
      [accountId, address, String(name ?? "").trim().slice(0, MAX_NAME)],
    );
    return true;
  }

  async remove(accountId: string, url: string): Promise<void> {
    await this.ensure();
    await this.db.query("DELETE FROM favorites WHERE account_id = $1 AND url = $2", [accountId, url]);
  }

  async list(accountId: string): Promise<Favorite[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT url, name, created_at FROM favorites WHERE account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return rows.map((row) => ({
      url: String(row["url"] ?? ""),
      name: String(row["name"] ?? ""),
      addedAt: new Date(String(row["created_at"] ?? 0)).getTime() || 0,
    }));
  }

  async has(accountId: string, url: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT 1 FROM favorites WHERE account_id = $1 AND url = $2",
      [accountId, url],
    );
    return rows.length > 0;
  }
}

/**
 * The name other people see.
 *
 * An account is keyed on an email address, because that is what the auth module
 * authenticates. An address is a credential and a way to reach somebody, and it
 * is not a name: putting it in a directory listing, an invite or a subdomain
 * publishes something the account holder gave us to log in with.
 *
 * So there are two names. The address stays private and does the linking, and a
 * handle is the one that appears in front of strangers. They are never the same
 * field and never travel in the same response.
 */
import type { Queryable } from "./follows.ts";

const TABLE = "nixamp_handles";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    user_id    TEXT PRIMARY KEY,
    handle     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_lower ON ${TABLE} (lower(handle));
`;

/**
 * What a handle may be.
 *
 * It ends up in a URL, a subdomain and a text message, so it is the intersection
 * of what all three tolerate: lowercase letters, digits and hyphens, not
 * starting or ending with one. Two to thirty characters, because a subdomain
 * label cannot exceed sixty-three and nobody types thirty.
 */
export function cleanHandle(value: unknown): string {
  if (typeof value !== "string") return "";
  const wanted = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(wanted)) return "";
  // Doubled hyphens are how punycode marks an encoded label, so a handle with
  // one in it can collide with an internationalised domain.
  return wanted.includes("--") ? "" : wanted;
}

/**
 * Names nobody may take, because a subdomain carrying one would impersonate the
 * service or reach a machine we run.
 */
const RESERVED = new Set([
  "www", "api", "admin", "root", "nixamp", "mail", "smtp", "imap", "ns1", "ns2",
  "static", "cdn", "assets", "app", "dev", "staging", "test", "support", "help",
  "status", "blog", "directory", "login", "signup", "account", "settings", "me",
]);

export function isReserved(handle: string): boolean {
  return RESERVED.has(handle);
}

/**
 * A handle for somebody who has not chosen one.
 *
 * Deliberately not derived from the address. "anthony@profullstack.com" turning
 * into "anthony" is exactly the leak this whole file exists to avoid, and it
 * would be a leak nobody noticed until it was already in a directory listing.
 */
export function anonymousHandle(random: (size: number) => Uint8Array): string {
  const bytes = random(4);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `nixamp-${out}`;
}

export class Handles {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async of(userId: string): Promise<string> {
    await this.ensure();
    const { rows } = await this.db.query(`SELECT handle FROM ${TABLE} WHERE user_id = $1`, [userId]);
    return rows[0] ? String(rows[0]["handle"] ?? "") : "";
  }

  /** Who holds this handle, so a listing can name somebody without their address. */
  async holder(handle: string): Promise<string> {
    const wanted = cleanHandle(handle);
    if (!wanted) return "";
    await this.ensure();
    const { rows } = await this.db.query(`SELECT user_id FROM ${TABLE} WHERE lower(handle) = $1`, [wanted]);
    return rows[0] ? String(rows[0]["user_id"] ?? "") : "";
  }

  /**
   * Claim one. Answers the reason it could not be taken rather than a boolean,
   * because "that is already somebody's" and "that is not a name" are different
   * things to tell a person.
   */
  async claim(userId: string, wanted: unknown): Promise<{ handle: string; error: string }> {
    const handle = cleanHandle(wanted);
    if (!handle) {
      return { handle: "", error: "letters, digits and hyphens, 2 to 30 characters" };
    }
    if (isReserved(handle)) return { handle: "", error: "that one is reserved" };

    await this.ensure();
    const taken = await this.holder(handle);
    if (taken && taken !== userId) return { handle: "", error: "somebody already has that one" };

    await this.db.query(
      `INSERT INTO ${TABLE} (user_id, handle) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET handle = EXCLUDED.handle, updated_at = NOW()`,
      [userId, handle],
    );
    return { handle, error: "" };
  }
}

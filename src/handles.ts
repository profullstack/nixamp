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
  ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS voice TEXT NOT NULL DEFAULT '';
  ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';
`;

/** What the room knows about somebody: the name, how they sound, where the rest is written. */
export interface Persona {
  handle: string;
  /** female, male, "" for whichever, or a provider voice id they named. */
  voice: string;
  /** The URL of their OpenProfile.md, or "". */
  profile: string;
}

/** A voice as it may be kept: a sex, nothing, or a provider's voice id. */
export function cleanVoice(value: unknown): { voice: string; error: string } {
  if (value === undefined || value === null) return { voice: "", error: "" };
  if (typeof value !== "string") return { voice: "", error: "a voice is a word" };
  const word = value.trim();
  if (word === "" || word === "any") return { voice: "", error: "" };
  const lower = word.toLowerCase();
  if (lower === "female" || lower === "male") return { voice: lower, error: "" };
  if (/^[A-Za-z][A-Za-z0-9_.-]{2,80}$/.test(word) && word.includes(".")) return { voice: word, error: "" };
  return { voice: "", error: "female, male, any, or a voice id like Telnyx.KokoroTTS.am_adam" };
}

/** An OpenProfile address as it may be kept: an http(s) URL, or nothing. */
export function cleanProfile(value: unknown): { profile: string; error: string } {
  if (value === undefined || value === null) return { profile: "", error: "" };
  if (typeof value !== "string") return { profile: "", error: "a profile is a URL" };
  const text = value.trim();
  if (text === "") return { profile: "", error: "" };
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { profile: "", error: "a profile is an http(s) URL" };
    if (url.href.length > 500) return { profile: "", error: "that URL is too long" };
    return { profile: url.href, error: "" };
  } catch {
    return { profile: "", error: "a profile is a URL, like https://you.example/.well-known/openprofile.md" };
  }
}

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
  // Two characters minimum, thirty maximum: the trailing character is required,
  // which is also what stops a handle ending in a hyphen.
  if (!/^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/.test(wanted)) return "";
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

  /** Everything the room knows about somebody. Empty strings for whatever they never said. */
  async persona(userId: string): Promise<Persona> {
    await this.ensure();
    const { rows } = await this.db.query(`SELECT handle, voice, profile FROM ${TABLE} WHERE user_id = $1`, [userId]);
    const row = rows[0];
    return {
      handle: row ? String(row["handle"] ?? "") : "",
      voice: row ? String(row["voice"] ?? "") : "",
      profile: row ? String(row["profile"] ?? "") : "",
    };
  }

  /**
   * How somebody sounds, and where their profile is. Either may be given
   * alone; what is not given is kept. A row exists only once a handle does,
   * so somebody who never picked one is given the fallback handle first.
   */
  async describe(userId: string, fallbackHandle: string, wanted: { voice?: unknown; profile?: unknown }): Promise<{ persona: Persona | null; error: string }> {
    const voice = wanted.voice === undefined ? null : cleanVoice(wanted.voice);
    if (voice?.error) return { persona: null, error: voice.error };
    const profile = wanted.profile === undefined ? null : cleanProfile(wanted.profile);
    if (profile?.error) return { persona: null, error: profile.error };
    await this.ensure();
    const had = await this.persona(userId);
    const handle = had.handle || cleanHandle(fallbackHandle) || fallbackHandle;
    await this.db.query(
      `INSERT INTO ${TABLE} (user_id, handle, voice, profile) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET voice = EXCLUDED.voice, profile = EXCLUDED.profile, updated_at = NOW()`,
      [userId, handle, voice ? voice.voice : had.voice, profile ? profile.profile : had.profile],
    );
    return { persona: await this.persona(userId), error: "" };
  }

  /**
   * Handles for a page of rows, in one query.
   *
   * A public listing names people, and naming them one query at a time is how a
   * list of fifty becomes fifty round trips. Anyone without a handle is absent
   * from the map rather than present as an empty string, so a caller decides
   * what to show for somebody who never picked one.
   */
  async many(userIds: string[]): Promise<Map<string, string>> {
    const wanted = [...new Set(userIds.filter(Boolean))];
    if (wanted.length === 0) return new Map();
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT user_id, handle FROM ${TABLE} WHERE user_id = ANY($1)`,
      [wanted],
    );
    return new Map(rows.map((row) => [String(row["user_id"] ?? ""), String(row["handle"] ?? "")]));
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

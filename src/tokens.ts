/**
 * Tokens that are not passwords.
 *
 * Two things arrive at the same door and are the same kind of thing on the
 * way in: the session a browser or a terminal gets after signing in, and the
 * token a person makes on purpose to paste into a CI job. Both are opaque
 * strings this server issued, both can be listed and revoked, and neither can
 * be turned back into a password.
 *
 * They are deliberately NOT the JWT the auth module hands out. A JWT cannot be
 * withdrawn before it expires -- nothing looks it up, that is the point of it
 * -- and a token somebody pasted into a build server is exactly the one you
 * want to be able to kill from a laptop. So the secret half is hashed like a
 * password, the row is what makes the token real, and deleting the row is what
 * makes it stop working.
 *
 * The shape is `nxa_<id>_<secret>`. The id is looked up; the secret is compared
 * against its hash in constant time. Carrying the id means a token is one index
 * hit rather than a scan over every hash on the site.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Account } from "./accounts.ts";
import type { Queryable } from "./follows.ts";

/** Prefixed so a leaked token is greppable, and obvious in a log. */
export const TOKEN_PREFIX = "nxa_";

/** How long a sign-in lasts. Long, because signing in on a television is work. */
export const SESSION_DAYS = 90;

/** A session ends; a token a person made for a script does not, unless asked. */
export type TokenKind = "session" | "cli";

export interface TokenRecord {
  id: string;
  name: string;
  kind: TokenKind;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface IssuedToken extends TokenRecord {
  /** The only time the whole token exists. It is never stored, so never shown twice. */
  token: string;
}

const TABLE = "nixamp_tokens";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    email        TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL DEFAULT 'session',
    name         TEXT NOT NULL DEFAULT '',
    secret_hash  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS ${TABLE}_user ON ${TABLE} (user_id);
`;

/** Make a token and the two halves it is made of. */
export function mintToken(): { id: string; secret: string; token: string } {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `${TOKEN_PREFIX}${id}_${secret}` };
}

/** Is this one of ours, rather than a JWT from the auth module? */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

/** Pull the id and the secret back out. Anything malformed is not a token. */
export function splitToken(value: string): { id: string; secret: string } | null {
  if (!looksLikeToken(value)) return null;
  const rest = value.slice(TOKEN_PREFIX.length);
  const cut = rest.indexOf("_");
  if (cut <= 0) return null;
  const id = rest.slice(0, cut);
  const secret = rest.slice(cut + 1);
  if (!/^[0-9a-f]+$/.test(id) || secret.length < 16) return null;
  return { id, secret };
}

export function hashSecret(secret: string): string {
  // A token secret is 32 random bytes, not a password: there is nothing to
  // guess by dictionary, so a slow KDF would only slow down every request.
  return createHash("sha256").update(secret).digest("hex");
}

/** Compare without letting the time taken say how much of it matched. */
function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  if (typeof value === "number") return value;
  return null;
}

function toRecord(row: Record<string, unknown>): TokenRecord {
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    kind: row["kind"] === "cli" ? "cli" : "session",
    createdAt: asTime(row["created_at"]) ?? 0,
    expiresAt: asTime(row["expires_at"]),
    lastUsedAt: asTime(row["last_used_at"]),
  };
}

export interface IssueOptions {
  account: Account;
  kind: TokenKind;
  /** What it is for, shown by `nixamp token list`. */
  name?: string;
  /** Milliseconds from now. Null never expires, which is the point of a CLI token. */
  ttlMs?: number | null;
}

export class Tokens {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Make the table, once per process, on first use. nixamp carries no
   * migration runner, and asking anybody to run SQL by hand before they can
   * sign in is a setup step too many.
   */
  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async issue(options: IssueOptions): Promise<IssuedToken> {
    await this.ensure();
    const { id, secret, token } = mintToken();
    const ttl = options.ttlMs === undefined ? SESSION_DAYS * 86_400_000 : options.ttlMs;
    const createdAt = this.now();
    const expiresAt = ttl === null ? null : createdAt + ttl;
    await this.db.query(
      `INSERT INTO ${TABLE} (id, user_id, email, kind, name, secret_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        options.account.id,
        options.account.email,
        options.kind,
        options.name ?? "",
        hashSecret(secret),
        new Date(createdAt).toISOString(),
        expiresAt === null ? null : new Date(expiresAt).toISOString(),
      ],
    );
    return {
      id,
      token,
      name: options.name ?? "",
      kind: options.kind,
      createdAt,
      expiresAt,
      lastUsedAt: null,
    };
  }

  /** The account a token belongs to, or null for one this server will not accept. */
  async verify(value: string): Promise<Account | null> {
    const parts = splitToken(value);
    if (parts === null) return null;
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT id, user_id, email, secret_hash, expires_at FROM ${TABLE} WHERE id = $1`,
      [parts.id],
    );
    const row = rows[0];
    if (!row) return null;
    if (!sameHash(String(row["secret_hash"] ?? ""), hashSecret(parts.secret))) return null;

    const expiresAt = asTime(row["expires_at"]);
    if (expiresAt !== null && expiresAt <= this.now()) {
      // Tidy it away on the way past rather than running a sweeper: an expired
      // token is only ever noticed when somebody tries to use it.
      await this.db.query(`DELETE FROM ${TABLE} WHERE id = $1`, [parts.id]).catch(() => {});
      return null;
    }

    // Last used is what makes `nixamp token list` worth reading -- it is how
    // you tell the token you forgot about from the one CI depends on.
    await this.db
      .query(`UPDATE ${TABLE} SET last_used_at = $2 WHERE id = $1`, [
        parts.id,
        new Date(this.now()).toISOString(),
      ])
      .catch(() => {});

    return { id: String(row["user_id"] ?? ""), email: String(row["email"] ?? "") };
  }

  /** Everything one account holds, newest first. Secrets are not in the table to leak. */
  async list(userId: string, kind?: TokenKind): Promise<TokenRecord[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT id, name, kind, created_at, expires_at, last_used_at FROM ${TABLE}
        WHERE user_id = $1 ${kind ? "AND kind = $2" : ""}
        ORDER BY created_at DESC`,
      kind ? [userId, kind] : [userId],
    );
    return rows.map(toRecord);
  }

  /** Scoped to the owner, so an id from somebody else's list revokes nothing. */
  async revoke(userId: string, id: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND id = $2 RETURNING id`, [
      userId,
      id,
    ]);
    return rows.length > 0;
  }

  /** Signing out of one place should not sign you out of the build server. */
  async revokeToken(value: string): Promise<boolean> {
    const parts = splitToken(value);
    if (parts === null) return false;
    await this.ensure();
    const { rows } = await this.db.query(
      `DELETE FROM ${TABLE} WHERE id = $1 AND kind = 'session' RETURNING id`,
      [parts.id],
    );
    return rows.length > 0;
  }
}

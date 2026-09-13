import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./follows.ts";
import type { Tokens } from "./tokens.ts";

export const RESET_MESSAGE = "If an account exists for that email, you’ll receive a password reset link shortly.";
export const RESET_INVALID = "This reset link is invalid, expired, or already used. Request a new link.";
const LIFETIME_MS = 30 * 60_000;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nixamp_password_resets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE,
    password_hash TEXT,
    expires_at TIMESTAMPTZ,
    reset_at TIMESTAMPTZ
  );
`;

interface Passwords {
  hashPassword(password: string): Promise<string>;
  validatePassword(password: string): { valid: boolean; message: string };
}

export type ResetMail = (email: string, link: string) => Promise<boolean>;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PasswordResets {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable & { initialize?(): Promise<void> },
    private readonly tokens: Tokens,
    private readonly passwords: Passwords,
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.db.initialize?.();
      await this.tokens.initialize();
      await this.db.query(SCHEMA);
    })().catch((error) => { this.ready = null; throw error; });
    await this.ready;
  }

  /** The public response is identical for registered and unknown addresses. */
  async request(email: string, site: string, deliver: ResetMail): Promise<void> {
    await this.ensure();
    const token = randomBytes(32).toString("base64url");
    const { rows } = await this.db.query(
      `INSERT INTO nixamp_password_resets (user_id, token_hash, password_hash, expires_at)
       SELECT id, $2, password, now() + interval '30 minutes' FROM users WHERE lower(email) = $1
       ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
         password_hash = EXCLUDED.password_hash, expires_at = EXCLUDED.expires_at
       RETURNING user_id`,
      [email.trim().toLowerCase(), digest(token)],
    );
    if (!rows.length) return;
    // Fragments never reach HTTP logs or referrers. Email delivery also never
    // changes the HTTP response (or its timing) according to account existence.
    const link = `${site.replace(/\/+$/, "")}/reset-password#token=${token}`;
    void Promise.resolve().then(() => deliver(email.trim().toLowerCase(), link)).then((sent) => {
      if (!sent) console.error("nixamp: password reset email delivery failed");
    }).catch(() => console.error("nixamp: password reset email delivery failed"));
  }

  /** Claim the link, change the password, and revoke sessions in one statement. */
  async confirm(token: unknown, password: unknown): Promise<string | null> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return RESET_INVALID;
    if (typeof password !== "string" || password.length > 200) return "Enter a password between 8 and 200 characters.";
    const validation = this.passwords.validatePassword(password);
    if (!validation.valid) return validation.message;
    await this.ensure();
    const tokenHash = digest(token);
    // Reject bad tokens before doing the deliberately expensive password hash.
    const candidate = await this.db.query(
      `SELECT user_id FROM nixamp_password_resets WHERE token_hash = $1 AND expires_at > now()`, [tokenHash],
    );
    if (!candidate.rows.length) return RESET_INVALID;
    const hashed = await this.passwords.hashPassword(password);
    const { rows } = await this.db.query(
      `WITH consumed AS (
         UPDATE nixamp_password_resets r SET token_hash = NULL, expires_at = NULL,
           password_hash = NULL, reset_at = clock_timestamp()
         FROM users u WHERE r.token_hash = $1 AND r.expires_at > now()
           AND u.id = r.user_id AND r.password_hash IS NOT DISTINCT FROM u.password
         RETURNING r.user_id
       ), changed AS (
         UPDATE users u SET password = $2, updated_at = now()
         FROM consumed c WHERE u.id = c.user_id RETURNING u.id
       ), revoked AS (
         DELETE FROM nixamp_tokens t USING changed c WHERE t.user_id = c.id RETURNING t.id
       ) SELECT id FROM changed`,
      [tokenHash, hashed],
    );
    return rows.length ? null : RESET_INVALID;
  }

  /** Older JWT sessions also stop working after recovery, across restarts. */
  async acceptsLegacyToken(userId: string, token: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT reset_at FROM nixamp_password_resets WHERE user_id = $1", [userId]);
    if (!rows[0]?.["reset_at"]) return true;
    try {
      // Called only after the auth library has verified the JWT signature.
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      const issued = claims.iat;
      const reset = rows[0]["reset_at"];
      const resetAt = reset instanceof Date ? reset.getTime() : new Date(String(reset)).getTime();
      return typeof issued === "number" && Number.isFinite(issued)
        && issued * 1000 >= resetAt;
    } catch { return false; }
  }
}

/** Transactional recovery mail has no follower footer and never logs a token. */
export function resendPasswordReset(options: {
  apiKey: string; from: string; fetch?: typeof globalThis.fetch;
}): ResetMail {
  return async (email, link) => {
    const host = new URL(link).hostname;
    const response = await (options.fetch ?? globalThis.fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        from: options.from, to: [email], subject: `Reset your ${host} password`,
        text: `Someone requested a password reset for your account on ${host}.\n\nChoose a new password using this link:\n${link}\n\nThis link expires in ${LIFETIME_MS / 60_000} minutes and works once. Resetting your password signs out existing sessions.\n\nIf you did not request this, you can ignore this email. Your password will stay the same.`,
      }),
    });
    return response.ok;
  };
}

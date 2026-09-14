/** Daily free access shared by Nixamp's paid panels and upgrades.
 * Claim only on explicit use, never from balance polling or provider chunks. */
import { createHash } from "node:crypto";
import type { Queryable } from "./follows.ts";
import { SpeechError } from "./speech.ts";

export const FREE_UPGRADE_SESSIONS = 10;
export const FREE_UPGRADE_RECONNECT_SECONDS = 90;
const DAY = 86_400_000;
export interface UpgradeAllowance {
  limit: number; remaining: number; reconnectSeconds: number; resets: string;
  activeUntil: string | null;
}

export class UpgradeAllowances {
  private schema: Promise<void> | null = null;
  constructor(private readonly db: Queryable, private readonly now: () => number = Date.now) {}
  async ensure(): Promise<void> {
    this.schema ??= this.db.query(`CREATE TABLE IF NOT EXISTS upgrade_daily_uses (
      by_account TEXT NOT NULL, day BIGINT NOT NULL,
      uses INTEGER NOT NULL CHECK (uses >= 1),
      sessions JSONB NOT NULL, PRIMARY KEY (by_account, day))`)
      .then(() => this.db.query(`ALTER TABLE upgrade_daily_uses DROP CONSTRAINT IF EXISTS upgrade_daily_uses_uses_check`))
      .then(() => this.db.query(`ALTER TABLE upgrade_daily_uses ADD CONSTRAINT upgrade_daily_uses_uses_check CHECK (uses BETWEEN 1 AND 10)`))
      .then(() => undefined)
      .catch(error => { this.schema = null; throw error; });
    await this.schema;
  }
  key(product: string, resource: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(product) || !/^[\w-]{1,80}$/.test(resource)) throw new SpeechError("Choose a panel session.", 400);
    return createHash("sha256").update(`${product}|${resource}`).digest("hex");
  }
  async access(by?: string): Promise<UpgradeAllowance> {
    await this.ensure();
    const now = this.now(), day = Math.floor(now / DAY);
    const rows = by ? (await this.db.query("SELECT uses, day, sessions FROM upgrade_daily_uses WHERE by_account = $1", [by])).rows : [];
    const today = rows.find(row => Number(row["day"]) === day);
    const active = Math.max(0, ...rows.flatMap(row => Object.values(row["sessions"] as Record<string, number>).map(Number)));
    return { limit: FREE_UPGRADE_SESSIONS, remaining: Math.max(0, FREE_UPGRADE_SESSIONS - Number(today?.["uses"] ?? 0)),
      reconnectSeconds: FREE_UPGRADE_RECONNECT_SECONDS, resets: new Date((day + 1) * DAY).toISOString(), activeUntil: active > now ? new Date(active).toISOString() : null };
  }

  /** One atomic row serializes concurrent starts across tabs, products and replicas.
   * Active use renews a short lease. Reconnecting reuses it; idle leases expire. */
  async begin(by: string, product: string, resource: string): Promise<boolean> {
    if (!by) throw new SpeechError("Sign in to use your free sessions.", 401);
    const key = this.key(product, resource);
    if ((await this.active([by], product, resource, true)).length) return true;
    await this.ensure();
    const now = this.now(), day = Math.floor(now / DAY), until = now + FREE_UPGRADE_RECONNECT_SECONDS * 1000;
    const result = await this.db.query(`INSERT INTO upgrade_daily_uses AS daily (by_account, day, uses, sessions)
      VALUES ($1, $2, 1, jsonb_build_object($3::text, $5::bigint))
      ON CONFLICT (by_account, day) DO UPDATE SET
        uses = CASE WHEN COALESCE((daily.sessions->>$3)::bigint, 0) > $4 THEN daily.uses ELSE daily.uses + 1 END,
        sessions = daily.sessions || EXCLUDED.sessions
      WHERE COALESCE((daily.sessions->>$3)::bigint, 0) > $4 OR daily.uses < $6
      RETURNING uses`, [by, day, key, now, until, FREE_UPGRADE_SESSIONS]);
    return result.rows.length > 0;
  }
  async active(accounts: string[], product: string, resource: string, renew = false): Promise<string[]> {
    if (!resource || !accounts.length) return [];
    const key = this.key(product, resource);
    await this.ensure();
    const now = this.now();
    const result = renew
      ? await this.db.query(`UPDATE upgrade_daily_uses SET sessions = sessions || jsonb_build_object($2::text, $4::bigint)
          WHERE by_account = ANY($1::text[]) AND (sessions->>$2)::bigint > $3 RETURNING by_account`, [accounts, key, now, now + FREE_UPGRADE_RECONNECT_SECONDS * 1000])
      : await this.db.query(`SELECT by_account FROM upgrade_daily_uses
          WHERE by_account = ANY($1::text[]) AND (sessions->>$2)::bigint > $3`, [accounts, key, now]);
    return result.rows.map(row => String(row["by_account"]));
  }
}

/**
 * The servers nixamp.com has seen listed lately, and who owns each, kept in
 * Postgres.
 *
 * The directory lives in memory and fills again only as servers heartbeat, so
 * for a minute after every deploy nixamp.com/music had no catalogue and a
 * label server's Veo or release call was refused as "not listed". This keeps
 * the last day's servers so both work straight away; a server still listed
 * always wins over what is remembered.
 */
import type { Queryable } from "./veo-studio.ts";

export interface KnownServer { base: string; ownerId: string; seenAt: number }

const DAY_MS = 24 * 60 * 60 * 1000;

export class KnownServers {
  private known = new Map<string, KnownServer>();
  private ready: Promise<unknown> | null = null;

  constructor(private readonly db: Queryable, private readonly now: () => number = Date.now) {}

  private ensure(): Promise<unknown> {
    return (this.ready ??= this.db.query("CREATE TABLE IF NOT EXISTS music_servers (base TEXT PRIMARY KEY, owner_id TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())").catch((error: unknown) => { this.ready = null; throw error; }));
  }

  /** What the last process saw in the last day. */
  async load(): Promise<void> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT base, owner_id, seen_at FROM music_servers WHERE seen_at > $1", [new Date(this.now() - DAY_MS)]);
    for (const row of rows) {
      const base = String(row["base"]);
      if (!this.known.has(base)) this.known.set(base, { base, ownerId: String(row["owner_id"]), seenAt: new Date(String(row["seen_at"])).getTime() });
    }
  }

  /** The servers listed now: remembered here and in the database. */
  async sync(listed: Array<{ base: string; ownerId: string }>): Promise<void> {
    await this.ensure();
    const at = this.now();
    for (const one of listed) {
      if (!one.base || !one.ownerId) continue;
      this.known.set(one.base, { base: one.base, ownerId: one.ownerId, seenAt: at });
      await this.db.query("INSERT INTO music_servers (base, owner_id, seen_at) VALUES ($1, $2, now()) ON CONFLICT (base) DO UPDATE SET owner_id = EXCLUDED.owner_id, seen_at = now()", [one.base, one.ownerId]);
    }
  }

  /** Servers seen in the last day. */
  list(): KnownServer[] {
    const since = this.now() - DAY_MS;
    return [...this.known.values()].filter((one) => one.seenAt > since);
  }
}

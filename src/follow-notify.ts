/**
 * Telling an artist's followers about new music.
 *
 * An artist is followed on nixamp.com as "artist:<name>" (follow-page.ts), but
 * the music is made on a nixamp server (the AI label, ai-label.ts). So the
 * server tells nixamp.com, signed in as its own account (its `nixamp login`,
 * the same session its directory heartbeat carries):
 *
 *   POST /api/v1/follows/notify  {target, title, body, url, key}
 *
 * and nixamp.com tells the followers, by mail, text and web push, as each of
 * them asked (notify.ts).
 *
 * Three rules keep that from being a way to spam people:
 *  - an artist belongs to the first account that announces for it; another
 *    account's notices for that artist are refused;
 *  - a notice is told once: `key` (an album's first song, an album finished)
 *    is remembered per artist, and the same key again is a no-op;
 *  - an artist gets at most a few notices a day, an account at most a few
 *    dozen, and the link must be one of ours (a /radio page on live.streaming
 *    or nixamp.com).
 */
import type { Queryable } from "./follows.ts";

export interface FollowNotice {
  /** "artist:<name>" */
  target: string;
  title: string;
  body: string;
  /** Where a click lands: a /radio page on one of our sites. */
  url: string;
  /** What makes it the same notice twice, e.g. "album:<name>:done". */
  key: string;
}

export const NOTICES_PER_ARTIST_PER_DAY = 4;
export const NOTICES_PER_ACCOUNT_PER_DAY = 40;

const TARGET = /^artist:[a-z0-9-]{1,90}$/;
const KEY = /^[a-z0-9:._-]{1,160}$/;

/** The hosts a notice may link to: NIXAMP_NOTIFY_HOSTS, else live.streaming and nixamp.com. */
export function noticeHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const listed = (env["NIXAMP_NOTIFY_HOSTS"] ?? "live.streaming.pit.world,nixamp.com").split(",");
  return new Set(listed.map((one) => one.trim().toLowerCase()).filter(Boolean));
}

const clean = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** A notice as sent, checked; null when any part of it is not one. */
export function noticeFrom(input: unknown, hosts: Set<string> = noticeHosts()): FollowNotice | null {
  if (typeof input !== "object" || input === null) return null;
  const one = input as Record<string, unknown>;
  const target = typeof one["target"] === "string" ? one["target"] : "";
  const key = typeof one["key"] === "string" ? one["key"] : "";
  const title = clean(one["title"], 140);
  const body = clean(one["body"], 400);
  if (!TARGET.test(target) || !KEY.test(key) || !title) return null;
  let url: URL;
  try {
    url = new URL(String(one["url"] ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !hosts.has(url.hostname.toLowerCase()) || !/^\/radio\//.test(url.pathname)) return null;
  return { target, title, body, url: url.href, key };
}

export type NoticeVerdict = "accepted" | "duplicate" | "not_yours" | "too_many";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS follow_claims (
    target      TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS follow_notices (
    target      TEXT NOT NULL,
    key         TEXT NOT NULL,
    account_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (target, key)
  );
  CREATE INDEX IF NOT EXISTS follow_notices_account ON follow_notices (account_id, created_at);
`;

export class FollowNotices {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined).catch((error: unknown) => { this.ready = null; throw error; });
    await this.ready;
  }

  /** Whether `sender` may tell `notice.target`'s followers this now; recorded when it may. */
  async accept(sender: string, notice: FollowNotice): Promise<NoticeVerdict> {
    await this.ensure();
    await this.db.query("INSERT INTO follow_claims (target, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [notice.target, sender]);
    const owner = (await this.db.query("SELECT account_id FROM follow_claims WHERE target = $1", [notice.target])).rows[0];
    if (String(owner?.["account_id"] ?? "") !== sender) return "not_yours";
    const seen = await this.db.query("SELECT 1 FROM follow_notices WHERE target = $1 AND key = $2", [notice.target, notice.key]);
    if (seen.rows.length > 0) return "duplicate";
    const counts = (await this.db.query(
      `SELECT COUNT(*) FILTER (WHERE target = $1)::int AS artist, COUNT(*) FILTER (WHERE account_id = $2)::int AS account
         FROM follow_notices WHERE created_at > now() - interval '1 day' AND (target = $1 OR account_id = $2)`,
      [notice.target, sender],
    )).rows[0];
    if (Number(counts?.["artist"] ?? 0) >= NOTICES_PER_ARTIST_PER_DAY || Number(counts?.["account"] ?? 0) >= NOTICES_PER_ACCOUNT_PER_DAY) return "too_many";
    const inserted = await this.db.query(
      "INSERT INTO follow_notices (target, key, account_id, title, url) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING 1",
      [notice.target, notice.key, sender, notice.title, notice.url],
    );
    return inserted.rows.length > 0 ? "accepted" : "duplicate";
  }
}

/**
 * On a nixamp server: tells nixamp.com, signed in as this server's account.
 * Never throws and never waits long; a missed notice is not worth a queue.
 */
export async function sendFollowNotice(
  options: { site: string; token: string; fetcher?: typeof fetch; log?: (line: string) => void },
  notice: FollowNotice,
): Promise<string> {
  if (!options.token) {
    options.log?.(`  follows: not signed in (nixamp login), so "${notice.title}" told nobody`);
    return "unsigned";
  }
  try {
    const answer = await (options.fetcher ?? fetch)(`${options.site}/api/v1/follows/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify(notice),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await answer.json().catch(() => ({}))) as { result?: string; told?: number; error?: string };
    const result = body.result ?? (answer.ok ? "accepted" : `http_${answer.status}`);
    options.log?.(`  follows: "${notice.title}" -> ${result}${typeof body.told === "number" ? ` (${body.told} followers)` : ""}${body.error ? `: ${body.error}` : ""}`);
    return result;
  } catch (error) {
    options.log?.(`  follows: could not reach ${options.site}: ${(error as Error).message}`);
    return "unreachable";
  }
}

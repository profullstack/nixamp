/**
 * Following a broadcaster, and where to reach the people who do.
 *
 * The phone line got here first, and its reminder is a different thing: you
 * key a code, press 1, and are told once when that particular stream comes
 * back. It is per-stream, one-shot, and tied to the handset you called from.
 * That is right for somebody who dialled a number, and useless for somebody
 * who wants to know whenever a person they like goes live, on whatever device
 * they happen to be holding.
 *
 * So a follow is account to account, and delivery is a set of addresses rather
 * than a phone number: an email, a phone if they gave one, and any number of
 * browsers that have granted permission. One person with a laptop, a phone and
 * a desktop app is three push subscriptions and one account.
 *
 * Unlike the rest of nixamp this is durable. The directory can afford to be a
 * four-minute TTL because a stream that stops is a stream nobody is listening
 * to; a follow has to outlive the stream by definition -- the whole point is
 * to be told about a broadcast that is not happening yet.
 *
 * The query function is injected rather than a Pool being constructed here, so
 * a test can describe a database instead of running one.
 */

/** The slice of `pg` this needs. Postgres in production, a fake in tests. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A browser, desktop app or phone that has granted notification permission. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Everywhere one follower can be reached. */
export interface Reachable {
  accountId: string;
  email: string;
  /** E.164, if they gave one. Empty when they never did. */
  phone: string;
  /** Whether each channel is on. A follower who wants none is still a follower. */
  wantsEmail: boolean;
  wantsSms: boolean;
  wantsWeb: boolean;
  push: PushTarget[];
}

/**
 * The tables.
 *
 * Created on demand rather than in a migration because the auth module owns
 * the schema this sits beside and there is no migration runner to hook into.
 * `IF NOT EXISTS` throughout, so starting a second instance is not a race that
 * takes the first one down.
 *
 * `follows` is keyed on the pair, which makes following twice a no-op rather
 * than a duplicate to deduplicate later. `push_subscriptions` is keyed on the
 * endpoint alone: an endpoint is issued by the browser vendor and is already
 * unique, and the same browser re-subscribing should replace its row rather
 * than accumulate one per sign-in.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS follows (
    follower_id  TEXT NOT NULL,
    streamer_id  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, streamer_id)
  );
  CREATE INDEX IF NOT EXISTS follows_streamer ON follows (streamer_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS push_account ON push_subscriptions (account_id);

  CREATE TABLE IF NOT EXISTS notify_prefs (
    account_id  TEXT PRIMARY KEY,
    phone       TEXT NOT NULL DEFAULT '',
    want_email  BOOLEAN NOT NULL DEFAULT TRUE,
    want_sms    BOOLEAN NOT NULL DEFAULT FALSE,
    want_web    BOOLEAN NOT NULL DEFAULT TRUE
  );
`;

/** E.164, or nothing. A number we cannot dial is not a number worth storing. */
export function phoneFrom(value: unknown): string {
  if (typeof value !== "string") return "";
  const digits = value.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  // A bare US ten-digit number is the common case and is unambiguous.
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return "";
}

export class Follows {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  /** Make the tables, once per process, on first use. */
  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async follow(followerId: string, streamerId: string): Promise<boolean> {
    // Following yourself is not an error worth an error, but it is not a
    // follow either: you do not need telling that you went live.
    if (!followerId || !streamerId || followerId === streamerId) return false;
    await this.ensure();
    await this.db.query(
      `INSERT INTO follows (follower_id, streamer_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [followerId, streamerId],
    );
    return true;
  }

  async unfollow(followerId: string, streamerId: string): Promise<void> {
    await this.ensure();
    await this.db.query(
      "DELETE FROM follows WHERE follower_id = $1 AND streamer_id = $2",
      [followerId, streamerId],
    );
  }

  /** Who this account follows. */
  async following(followerId: string): Promise<string[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT streamer_id FROM follows WHERE follower_id = $1 ORDER BY created_at",
      [followerId],
    );
    return rows.map((r) => String(r["streamer_id"]));
  }

  async isFollowing(followerId: string, streamerId: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT 1 FROM follows WHERE follower_id = $1 AND streamer_id = $2",
      [followerId, streamerId],
    );
    return rows.length > 0;
  }

  async followerCount(streamerId: string): Promise<number> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT COUNT(*)::int AS n FROM follows WHERE streamer_id = $1",
      [streamerId],
    );
    return Number(rows[0]?.["n"] ?? 0);
  }

  /** Remember a browser that has granted permission. */
  async addPush(accountId: string, target: PushTarget): Promise<void> {
    if (!accountId || !target.endpoint) return;
    await this.ensure();
    await this.db.query(
      `INSERT INTO push_subscriptions (endpoint, account_id, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth`,
      [target.endpoint, accountId, target.p256dh, target.auth],
    );
  }

  /**
   * Forget a browser.
   *
   * Called when somebody turns notifications off, and again when a push is
   * rejected as gone: a subscription outlives the browser that made it, and
   * pushing to a dead endpoint forever is how a table becomes mostly rubbish.
   */
  async removePush(endpoint: string): Promise<void> {
    if (!endpoint) return;
    await this.ensure();
    await this.db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  }

  async setPrefs(
    accountId: string,
    prefs: { phone?: string; wantsEmail?: boolean; wantsSms?: boolean; wantsWeb?: boolean },
  ): Promise<void> {
    if (!accountId) return;
    await this.ensure();
    // Every column is COALESCEd on the way IN as well as on conflict. A caller
    // setting only the switches sends no phone, and an unset field arrives as
    // null -- which the ON CONFLICT branch handles fine and the INSERT branch
    // does not, because these columns are NOT NULL. Saving preferences for the
    // first time was a 500 until this said so.
    //
    // The casts are not decoration either: Postgres cannot infer the type of a
    // parameter that is only ever seen inside COALESCE against a null.
    await this.db.query(
      `INSERT INTO notify_prefs (account_id, phone, want_email, want_sms, want_web)
       VALUES ($1,
               COALESCE($2::text, ''),
               COALESCE($3::boolean, TRUE),
               COALESCE($4::boolean, FALSE),
               COALESCE($5::boolean, TRUE))
       ON CONFLICT (account_id) DO UPDATE
         SET phone = COALESCE($2::text, notify_prefs.phone),
             want_email = COALESCE($3::boolean, notify_prefs.want_email),
             want_sms = COALESCE($4::boolean, notify_prefs.want_sms),
             want_web = COALESCE($5::boolean, notify_prefs.want_web)`,
      [
        accountId,
        prefs.phone === undefined ? null : phoneFrom(prefs.phone),
        prefs.wantsEmail ?? null,
        prefs.wantsSms ?? null,
        prefs.wantsWeb ?? null,
      ],
    );
  }

  async prefs(accountId: string): Promise<{ phone: string; wantsEmail: boolean; wantsSms: boolean; wantsWeb: boolean }> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT phone, want_email, want_sms, want_web FROM notify_prefs WHERE account_id = $1",
      [accountId],
    );
    const row = rows[0];
    // Defaults for somebody who has never opened the settings: mail yes, web
    // yes, texts no. A text costs them nothing but is the most intrusive of
    // the three, so it is the one you have to ask for.
    return {
      phone: String(row?.["phone"] ?? ""),
      wantsEmail: row === undefined ? true : row["want_email"] !== false,
      wantsSms: row === undefined ? false : row["want_sms"] === true,
      wantsWeb: row === undefined ? true : row["want_web"] !== false,
    };
  }

  /**
   * Everyone following this broadcaster, and every way to reach them.
   *
   * One query rather than one per follower. A broadcaster with a thousand
   * followers going live should not be a thousand round trips while the
   * publisher's heartbeat waits on the response.
   */
  async audience(streamerId: string): Promise<Reachable[]> {
    if (!streamerId) return [];
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT f.follower_id                     AS account_id,
              COALESCE(u.email, '')             AS email,
              COALESCE(p.phone, '')             AS phone,
              COALESCE(p.want_email, TRUE)      AS want_email,
              COALESCE(p.want_sms, FALSE)       AS want_sms,
              COALESCE(p.want_web, TRUE)        AS want_web,
              COALESCE(
                json_agg(json_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                  FILTER (WHERE s.endpoint IS NOT NULL),
                '[]'
              )                                 AS push
         FROM follows f
         LEFT JOIN users u              ON u.id = f.follower_id
         LEFT JOIN notify_prefs p       ON p.account_id = f.follower_id
         LEFT JOIN push_subscriptions s ON s.account_id = f.follower_id
        WHERE f.streamer_id = $1
        GROUP BY f.follower_id, u.email, p.phone, p.want_email, p.want_sms, p.want_web`,
      [streamerId],
    );

    return rows.map((r) => ({
      accountId: String(r["account_id"] ?? ""),
      email: String(r["email"] ?? ""),
      phone: String(r["phone"] ?? ""),
      wantsEmail: r["want_email"] !== false,
      wantsSms: r["want_sms"] === true,
      wantsWeb: r["want_web"] !== false,
      push: readPush(r["push"]),
    }));
  }
}

/** json_agg comes back as an array or as a string, depending on the driver. */
function readPush(value: unknown): PushTarget[] {
  const list = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((item) => typeof item["endpoint"] === "string" && item["endpoint"] !== "")
    .map((item) => ({
      endpoint: String(item["endpoint"]),
      p256dh: String(item["p256dh"] ?? ""),
      auth: String(item["auth"] ?? ""),
    }));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

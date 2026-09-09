/**
 * The two pieces of state that were promises, and were only in memory.
 *
 * Most of nixamp is deliberately ephemeral. The directory is a four-minute TTL
 * and a heartbeat, because a stream that stops is a stream nobody is hearing,
 * and a restart costs one heartbeat rather than a migration. That reasoning is
 * right for what is on. It is wrong for two things that outlived their stream
 * on purpose:
 *
 *   A caller who pressed 1 was told "we will text you when they are live
 *   again". That subscription lived in a Map, so a deploy dropped it and the
 *   text never came -- and nothing anywhere said so. A promise made on a phone
 *   call and quietly forgotten is worse than never offering it.
 *
 *   A stream that ended is what the phone line reads back ("ended at 9:27 PM
 *   Pacific") and what the directory offers to follow when nobody is on. After
 *   a deploy the code a caller had been told to key would find nothing and
 *   open an empty room instead.
 *
 * This is a mirror rather than a replacement. The in-memory maps stay exactly
 * as they were -- so every caller stays synchronous and every existing test
 * still describes the same object -- and each write is echoed here, with the
 * contents read back once at boot. The cost of that choice is that two
 * instances would each hold their own copy; nixamp.com runs one, and a second
 * would need this to become the source of truth rather than the mirror.
 */
import type { Queryable } from "./follows.ts";

export interface StoredEnded {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  url: string;
  nowPlaying: string;
  startedAt: number;
  endedAt: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ended_streams (
    id           TEXT PRIMARY KEY,
    code         TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    owner_id     TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL DEFAULT '',
    now_playing  TEXT NOT NULL DEFAULT '',
    started_at   BIGINT NOT NULL,
    ended_at     BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ended_streams_code ON ended_streams (code);

  CREATE TABLE IF NOT EXISTS stream_reminders (
    code        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (code, phone)
  );
`;

export class Durable {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly onEvent: (message: string) => void = () => {},
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /**
   * Nothing here is worth taking a request down for.
   *
   * These are all mirror writes: the in-memory copy is what the request is
   * answered from, so a database that is briefly unreachable should cost the
   * durability and not the feature.
   */
  private async quietly(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await this.ensure();
      await run();
    } catch (error) {
      this.onEvent(`  ${what} did not persist: ${(error as Error).message}`);
    }
  }

  async saveEnded(stream: StoredEnded): Promise<void> {
    await this.quietly("an ended stream", () =>
      this.db.query(
        `INSERT INTO ended_streams
           (id, code, name, owner_id, url, now_playing, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET code = EXCLUDED.code,
               name = EXCLUDED.name,
               owner_id = EXCLUDED.owner_id,
               url = EXCLUDED.url,
               now_playing = EXCLUDED.now_playing,
               started_at = EXCLUDED.started_at,
               ended_at = EXCLUDED.ended_at`,
        [
          stream.id,
          stream.code,
          stream.name,
          stream.ownerId,
          stream.url,
          stream.nowPlaying,
          stream.startedAt,
          stream.endedAt,
        ],
      ),
    );
  }

  /** A stream that came back, or one old enough to forget. */
  async dropEnded(id: string): Promise<void> {
    await this.quietly("dropping an ended stream", () =>
      this.db.query("DELETE FROM ended_streams WHERE id = $1", [id]),
    );
  }

  /** What ended since `since`, oldest first so replaying it rebuilds the order. */
  async loadEnded(since: number): Promise<StoredEnded[]> {
    try {
      await this.ensure();
      const { rows } = await this.db.query(
        "SELECT * FROM ended_streams WHERE ended_at >= $1 ORDER BY ended_at",
        [since],
      );
      return rows.map((r) => ({
        id: String(r["id"] ?? ""),
        code: String(r["code"] ?? ""),
        name: String(r["name"] ?? ""),
        ownerId: String(r["owner_id"] ?? ""),
        url: String(r["url"] ?? ""),
        nowPlaying: String(r["now_playing"] ?? ""),
        // BIGINT comes back as a string from pg, which sorts and compares
        // nothing like a number.
        startedAt: Number(r["started_at"] ?? 0),
        endedAt: Number(r["ended_at"] ?? 0),
      }));
    } catch (error) {
      this.onEvent(`  could not read ended streams: ${(error as Error).message}`);
      return [];
    }
  }

  async addReminder(code: string, phone: string): Promise<void> {
    if (!code || !phone) return;
    await this.quietly("a reminder", () =>
      this.db.query(
        `INSERT INTO stream_reminders (code, phone) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [code, phone],
      ),
    );
  }

  /**
   * Take everyone waiting on a code, and stop them waiting, in one statement.
   *
   * `DELETE ... RETURNING` rather than a select and then a delete: the rows
   * come back as they are removed, so two goings-live at once cannot both read
   * the same list and text everybody twice.
   */
  async takeReminders(code: string): Promise<string[]> {
    if (!code) return [];
    try {
      await this.ensure();
      const { rows } = await this.db.query(
        "DELETE FROM stream_reminders WHERE code = $1 RETURNING phone",
        [code],
      );
      return rows.map((r) => String(r["phone"] ?? "")).filter(Boolean);
    } catch (error) {
      this.onEvent(`  could not take reminders: ${(error as Error).message}`);
      return [];
    }
  }

  /** Everyone waiting, by code, to seed a process that has just started. */
  async loadReminders(): Promise<Map<string, Set<string>>> {
    const waiting = new Map<string, Set<string>>();
    try {
      await this.ensure();
      const { rows } = await this.db.query("SELECT code, phone FROM stream_reminders", []);
      for (const row of rows) {
        const code = String(row["code"] ?? "");
        const phone = String(row["phone"] ?? "");
        if (!code || !phone) continue;
        const set = waiting.get(code) ?? new Set<string>();
        set.add(phone);
        waiting.set(code, set);
      }
    } catch (error) {
      this.onEvent(`  could not read reminders: ${(error as Error).message}`);
    }
    return waiting;
  }

  /** Forget what is too old to be worth telling anybody about. */
  async sweep(endedBefore: number, remindersBefore: Date): Promise<void> {
    await this.quietly("sweeping", async () => {
      await this.db.query("DELETE FROM ended_streams WHERE ended_at < $1", [endedBefore]);
      // A reminder nobody has collected in a month is somebody who has long
      // since stopped expecting a text.
      await this.db.query("DELETE FROM stream_reminders WHERE created_at < $1", [
        remindersBefore.toISOString(),
      ]);
    });
  }
}

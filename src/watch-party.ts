/**
 * A watch party somewhere else, as a nixamp room.
 *
 * bittorrented.com has watch parties: a six-character code, a host, a list of
 * people, one piece of media and a playback position everybody is supposed to
 * be at. nixamp has live events, rooms, chat, hand raises, invitations and
 * five clients that can already open one. This is the join between them, so a
 * party started on bittorrented.com is a room every nixamp surface can see and
 * play, and a party started from nixamp is one bittorrented.com can host.
 *
 * The shape is deliberately thin. A bridged party is a `live_events` row like
 * any other -- so discovery, invitations, chat, the layout registry and the
 * /live/:slug page all work with no special case -- plus one row here saying
 * which external party it is, where to watch it and where playback had got to.
 * Nothing about torrents, HLS or WebRTC crosses over: the media stays on the
 * origin that has it, and what nixamp carries is the room.
 *
 * Playback position is kept because the point of a watch party is that
 * everybody is at the same second. It is advisory and cheap to write: the
 * host's client pushes it, and a client that joins late reads it once and
 * seeks. Nothing here tries to be a clock.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./follows.ts";
import { LiveEventError, type LiveEvent, type LiveEvents } from "./live-events.ts";

/** Which site a bridged party came from. `bittorrented` is the first. */
export type PartyOrigin = string;

export interface WatchParty {
  /** The nixamp event this party is. */
  eventId: string;
  /** The nixamp channel a client listens to, which is the event's room. */
  roomId: string;
  /** The slug that opens it at nixamp.com/live/<slug>. */
  slug: string;
  /** Which client bridged it, by OAuth client id. */
  origin: PartyOrigin;
  /** The party's own id over there, e.g. bittorrented's six characters. */
  partyCode: string;
  /** Where to watch it on the origin. */
  partyUrl: string;
  /** What is playing, as the origin describes it. */
  mediaTitle: string;
  /** Seconds into the media, as the host last said. */
  positionSeconds: number;
  playing: boolean;
  /** When that position was true, so a late joiner can add the drift. */
  positionAt: string;
  createdAt: string;
  updatedAt: string;
}

export class WatchPartyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TABLE = "nixamp_watch_parties";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    event_id         TEXT PRIMARY KEY REFERENCES live_events(id) ON DELETE CASCADE,
    origin           TEXT NOT NULL,
    party_code       TEXT NOT NULL,
    party_url        TEXT NOT NULL DEFAULT '',
    media_title      TEXT NOT NULL DEFAULT '',
    position_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    playing          BOOLEAN NOT NULL DEFAULT FALSE,
    position_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (origin, party_code)
  );
  CREATE INDEX IF NOT EXISTS ${TABLE}_origin ON ${TABLE} (origin, updated_at DESC);
`;

/**
 * The code as it will be matched.
 *
 * bittorrented prints six of A-Z0-9 and people retype them, so the match is
 * case-insensitive and rubbed of the spaces and dashes a person adds. The
 * stored form is the upper-case one, which makes the unique index the thing
 * that stops one party being bridged twice under two spellings.
 */
export function cleanPartyCode(value: unknown): string {
  if (typeof value !== "string") throw new WatchPartyError("a party code is required", 422);
  const cleaned = value.replace(/[\s_-]+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{4,32}$/.test(cleaned)) throw new WatchPartyError("that does not look like a party code", 422);
  return cleaned;
}

/** A watch link has to be a real https address on the origin's own site. */
export function cleanPartyUrl(value: unknown, allowedHosts: string[]): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new WatchPartyError("partyUrl must be a URL", 422);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WatchPartyError("partyUrl must be a URL", 422);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new WatchPartyError("partyUrl must be https", 422);
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname) && !local) {
    throw new WatchPartyError("partyUrl is not on this client's site", 403);
  }
  return url.toString();
}

function seconds(value: unknown, name: string): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400 * 7) {
    throw new WatchPartyError(`${name} must be a number of seconds`, 422);
  }
  return Math.round(value * 1000) / 1000;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function partyFrom(row: Record<string, unknown>, event: { roomId: string; slug: string }): WatchParty {
  return {
    eventId: String(row["event_id"] ?? ""),
    roomId: event.roomId,
    slug: event.slug,
    origin: String(row["origin"] ?? ""),
    partyCode: String(row["party_code"] ?? ""),
    partyUrl: String(row["party_url"] ?? ""),
    mediaTitle: String(row["media_title"] ?? ""),
    positionSeconds: Number(row["position_seconds"] ?? 0),
    playing: Boolean(row["playing"]),
    positionAt: iso(row["position_at"]),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

export interface BridgeInput {
  partyCode: unknown;
  title?: unknown;
  partyUrl?: unknown;
  mediaTitle?: unknown;
  visibility?: unknown;
  chatEnabled?: unknown;
  handRaiseEnabled?: unknown;
}

export interface PartyView {
  party: WatchParty;
  event: LiveEvent;
}

export interface WatchPartiesOptions {
  db: Queryable;
  events: LiveEvents;
  /** nixamp.com, for the links handed back to the client. */
  site: string;
  /** Hostnames a given client may point a watch link at. */
  hostsFor?: (origin: PartyOrigin) => string[];
  now?: () => number;
}

export class WatchParties {
  private ready: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WatchPartiesOptions) {
    this.now = options.now ?? Date.now;
  }

  private async ensure(): Promise<void> {
    this.ready ??= this.options.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  private get site(): string {
    return this.options.site.replace(/\/+$/, "");
  }

  /** Everything a client needs to send somebody to this party, either way. */
  links(party: WatchParty): { nixampUrl: string; roomUrl: string; partyUrl: string } {
    return {
      nixampUrl: `${this.site}/live/${encodeURIComponent(party.slug)}`,
      roomUrl: `${this.site}/api/channels/${encodeURIComponent(party.roomId)}`,
      partyUrl: party.partyUrl,
    };
  }

  /**
   * Bridge a party, or find the bridge it already has.
   *
   * Idempotent on purpose: a client calls this every time somebody opens the
   * party page, and the second call must answer the same room rather than
   * making a second event nobody is in. What it does update is the mutable
   * half -- the title, the media, the link -- because the host changing the
   * film should not need a new room.
   */
  async bridge(ownerId: string, origin: PartyOrigin, input: BridgeInput): Promise<PartyView> {
    if (!ownerId) throw new WatchPartyError("sign in to host a watch party", 401);
    await this.ensure();
    const code = cleanPartyCode(input.partyCode);
    const partyUrl = cleanPartyUrl(input.partyUrl, this.options.hostsFor?.(origin) ?? []);
    const mediaTitle = typeof input.mediaTitle === "string" ? input.mediaTitle.slice(0, 200).trim() : "";
    const title =
      (typeof input.title === "string" && input.title.trim() !== "" ? input.title.trim() : "") ||
      mediaTitle ||
      `Watch party ${code}`;

    const existing = await this.byCode(origin, code);
    if (existing) {
      // Already bridged. Only the host may change what it says it is, and the
      // event's own version check is what settles a race between two of them.
      if (existing.event.ownerId !== ownerId) return existing;
      const event = await this.options.events.update(existing.event.id, ownerId, {
        version: existing.event.version,
        title,
        ...(mediaTitle ? { description: mediaTitle } : {}),
      });
      const { rows } = await this.options.db.query(
        `UPDATE ${TABLE} SET party_url = COALESCE(NULLIF($2, ''), party_url),
                             media_title = COALESCE(NULLIF($3, ''), media_title),
                             updated_at = now()
          WHERE event_id = $1 RETURNING *`,
        [existing.event.id, partyUrl, mediaTitle],
      );
      const row = rows[0];
      return { party: row ? partyFrom(row, event) : existing.party, event };
    }

    // New. The event is created live rather than draft: a watch party exists
    // because people are watching it now, and a party that has to be started
    // twice -- once over there, once here -- is a party that is listed dead.
    const event = await this.options.events.create(ownerId, {
      title,
      description: mediaTitle,
      topic: "Watch party",
      visibility: input.visibility ?? "unlisted",
      chatEnabled: input.chatEnabled ?? true,
      handRaiseEnabled: input.handRaiseEnabled ?? false,
    });
    const live = await this.options.events.transition(event.id, ownerId, "live", event.version);
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await this.options.db.query(
        `INSERT INTO ${TABLE} (event_id, origin, party_code, party_url, media_title, position_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
        [live.id, origin, code, partyUrl, mediaTitle],
      ));
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      // Two requests bridged the same party at once. The loser drops its
      // event and answers the winner's, which is the same answer.
      await this.options.events.remove(live.id, ownerId).catch(() => {});
      const raced = await this.byCode(origin, code);
      if (raced) return raced;
      throw new WatchPartyError("could not bridge that party", 409);
    }
    const row = rows[0];
    if (!row) throw new WatchPartyError("could not bridge that party", 500);
    return { party: partyFrom(row, live), event: live };
  }

  async byCode(origin: PartyOrigin, partyCode: string): Promise<PartyView | null> {
    await this.ensure();
    const code = cleanPartyCode(partyCode);
    const { rows } = await this.options.db.query(
      `SELECT * FROM ${TABLE} WHERE origin = $1 AND party_code = $2 LIMIT 1`,
      [origin, code],
    );
    const row = rows[0];
    if (!row) return null;
    const event = await this.options.events.get(String(row["event_id"] ?? ""));
    if (!event) return null;
    return { party: partyFrom(row, event), event };
  }

  /** The party behind a nixamp room or slug, for a client that has only that. */
  async byEvent(reference: string): Promise<PartyView | null> {
    await this.ensure();
    const event = (await this.options.events.get(reference)) ?? (await this.options.events.byRoom(reference));
    if (!event) return null;
    const { rows } = await this.options.db.query(`SELECT * FROM ${TABLE} WHERE event_id = $1`, [event.id]);
    const row = rows[0];
    return row ? { party: partyFrom(row, event), event } : null;
  }

  /**
   * Parties anyone may join: public and unlisted ones that are still live.
   *
   * Unlisted is included here and not in the general event list on purpose.
   * A watch party code is already the thing you hand somebody, and this
   * endpoint is reached only with a token the account granted, so what it
   * lists is "the parties this person could join", not the public web.
   */
  async list(options: { origin?: PartyOrigin; limit?: number } = {}): Promise<PartyView[]> {
    await this.ensure();
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)));
    const values: unknown[] = [];
    let where = "";
    if (options.origin) {
      values.push(options.origin);
      where = `WHERE p.origin = $${values.length}`;
    }
    values.push(limit);
    const { rows } = await this.options.db.query(
      `SELECT p.* FROM ${TABLE} p
       JOIN live_events e ON e.id = p.event_id
       ${where}${where ? " AND" : "WHERE"} e.status = 'live' AND e.visibility <> 'private'
       ORDER BY p.updated_at DESC LIMIT $${values.length}`,
      values,
    );
    const found: PartyView[] = [];
    for (const row of rows) {
      const event = await this.options.events.get(String(row["event_id"] ?? ""));
      if (event) found.push({ party: partyFrom(row, event), event });
    }
    return found;
  }

  /**
   * Where the host says playback is.
   *
   * Only somebody who can manage the event may write it, because a listener
   * who could would be able to drag everybody else around the film. Reading
   * is open to whoever can see the event, which the API layer has already
   * decided by the time this is called.
   */
  async setPlayback(
    eventId: string,
    accountId: string,
    input: { positionSeconds?: unknown; playing?: unknown; mediaTitle?: unknown },
  ): Promise<WatchParty> {
    await this.ensure();
    const event = await this.options.events.get(eventId);
    if (!event) throw new WatchPartyError("watch party not found", 404);
    if (!this.options.events.canManage(event, accountId)) {
      throw new WatchPartyError("only the host can move everybody's playback", 403);
    }
    const position = seconds(input.positionSeconds, "positionSeconds");
    const playing = input.playing === undefined ? true : input.playing === true;
    const mediaTitle = typeof input.mediaTitle === "string" ? input.mediaTitle.slice(0, 200).trim() : "";
    const { rows } = await this.options.db.query(
      `UPDATE ${TABLE} SET position_seconds = $2, playing = $3,
                           media_title = COALESCE(NULLIF($4, ''), media_title),
                           position_at = $5, updated_at = now()
        WHERE event_id = $1 RETURNING *`,
      [eventId, position, playing, mediaTitle, new Date(this.now()).toISOString()],
    );
    const row = rows[0];
    if (!row) throw new WatchPartyError("watch party not found", 404);
    return partyFrom(row, event);
  }

  /**
   * Where playback is right now, which is not what was written down.
   *
   * A party that is playing has moved on since the host last said anything,
   * so the answer is the stored second plus the time since. A paused one has
   * not, and reporting drift on a paused film would make every client seek
   * away from the frame everybody is looking at.
   */
  positionNow(party: WatchParty): number {
    if (!party.playing) return party.positionSeconds;
    const since = (this.now() - Date.parse(party.positionAt)) / 1000;
    return Math.max(0, party.positionSeconds + (Number.isFinite(since) ? since : 0));
  }

  /** The party goes when the event does; ending it is the event's transition. */
  async end(eventId: string, accountId: string): Promise<LiveEvent> {
    const event = await this.options.events.get(eventId);
    if (!event) throw new WatchPartyError("watch party not found", 404);
    if (event.ownerId !== accountId) throw new WatchPartyError("only the host can end it", 403);
    try {
      return await this.options.events.transition(event.id, accountId, "ended", event.version);
    } catch (error) {
      if (error instanceof LiveEventError) throw new WatchPartyError(error.message, error.status);
      throw error;
    }
  }
}

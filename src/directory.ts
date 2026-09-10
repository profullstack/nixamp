import { randomInt } from "node:crypto";

/**
 * The public directory.
 *
 * A nixamp that agrees to be listed announces itself to nixamp.com every so
 * often and is forgotten when it stops. There is no database behind it: an
 * entry lives for a few minutes and a heartbeat renews it, so a restart of the
 * directory costs one heartbeat rather than a migration, and a stream that
 * dies falls out of the list without anyone having to notice.
 *
 * What is published is the *listen* link. The control key never leaves the
 * machine it was minted on.
 */

/** How long an entry survives without a heartbeat. */
export const TTL_MS = 4 * 60 * 1000;
/** How often a publisher renews. Comfortably inside the TTL. */
export const HEARTBEAT_MS = 90 * 1000;
export const DEFAULT_DIRECTORY = "https://nixamp.com";

export interface Listing {
  /** Assigned by the directory, so a publisher cannot claim someone else's. */
  id: string;
  /**
   * A six-digit code for this stream, stable across the whole run.
   *
   * This is what somebody keys into the phone line. It has to be short enough
   * to read out and survive being remembered, which the id is not.
   */
  code: string;
  name: string;
  /**
   * The account that announced it.
   *
   * Set from the signed-in publisher, never from the announcement body -- a
   * stream that could name its own owner could name somebody else's, and
   * followers would be told about a broadcast that person is not making.
   */
  ownerId: string;
  /** The listen link, which is what a browser opens. */
  url: string;
  /**
   * The same stream as bytes, for something that is not a browser.
   *
   * `url` is a share link: it answers 302, sets a cookie and redirects to the
   * player page. That is exactly right for a person and useless to anything
   * that cannot hold a cookie -- the phone line hands this address to Telnyx
   * to play into a call, and Telnyx fetches it once, anonymously, and expects
   * audio back. Handed the share link it gets a 401 in JSON and the caller
   * hears silence after being told the stream is about to start.
   *
   * So a publisher announces both: the link a person opens, and the address
   * that answers with audio/mpeg to a plain GET. Empty when the publisher is
   * an older nixamp that only knows about `url`.
   */
  audio: string;
  /**
   * The link that administers the server, as the publisher announced it.
   *
   * Kept so the owner can open their own machine as its administrator from
   * the directory, and handed out to nobody else: the listing route strips it
   * for anyone but the account that owns the listing.
   */
  admin: string;
  tracks: number;
  nowPlaying: string;
  /**
   * Whether the server's own player is running. A listing used to say only
   * what was loaded, so a stopped server read as a live stream of a film
   * nobody was watching.
   */
  playing: boolean;
  /** The live channels on it, by name: what a visitor could actually watch. */
  channels: string[];
  /**
   * A phone code for each of those channels, by name: its own room, so the
   * people calling about one live are not put in with the people calling
   * about another on the same server.
   */
  channelCodes: Record<string, string>;
  /** Set by the directory from the request, never by the publisher. */
  updatedAt: number;
  /** When this stream first announced itself: the "started at" a caller hears. */
  startedAt: number;
}

/**
 * A stream that has stopped, kept for a while after it fell out of the list.
 *
 * The directory proper forgets a stream the moment it stops renewing, which is
 * right for a list of what is on -- but it means there is nobody left to say
 * *when* it ended, and "call back later" with no time in it is not worth
 * saying. So an ended stream leaves this behind: enough to answer the phone
 * truthfully, and nothing anybody could listen to.
 */
export interface Ended {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  /** Kept so a stream returning on the same url is recognised as the same one. */
  url: string;
  nowPlaying: string;
  startedAt: number;
  /** The last heartbeat we saw, which is as close to "ended" as we can know. */
  endedAt: number;
}

/** How long an ended stream is still worth telling a caller about. */
export const ENDED_TTL_MS = 24 * 60 * 60 * 1000;

/** What a publisher sends. Everything else about a listing is ours to decide. */
export interface Announcement {
  id?: string;
  name: string;
  url: string;
  /** Where the audio actually is. See `Listing.audio`. */
  audio?: string;
  /** The admin share link, same origin as `url`. Kept for the owner alone. */
  admin?: string;
  tracks: number;
  nowPlaying: string;
  /** Absent from an older publisher, which is read as "unknown, say playing". */
  playing?: boolean;
  /** Names of the live channels on it. Absent from an older publisher. */
  channels?: string[];
}

const MAX_NAME = 60;
const MAX_TRACK = 120;
/** How many channel names a listing carries. A multiview is four; eight is plenty. */
const MAX_CHANNELS = 8;

/** Trim and flatten, so one publisher cannot draw a box in someone's terminal. */
export function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Control characters include the escape that starts an ANSI sequence, and
  // this text is rendered in a terminal as well as a browser.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/**
 * A URL we are willing to list. It has to be somewhere a browser can go, and
 * it must not be a loopback or link-local address: those are only reachable
 * from the machine that published them, so listing one is an entry nobody but
 * the publisher can ever open.
 */
export function publishable(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return null;
  if (/^127\./.test(host) || /^169\.254\./.test(host)) return null;
  return url;
}

export function parseAnnouncement(input: unknown): Announcement | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;

  const url = typeof record["url"] === "string" ? record["url"] : "";
  const listen = publishable(url);
  if (listen === null) return null;

  // The audio address has to be the same server as the listen link. This one
  // is played into a telephone call that somebody pays for by the minute, and
  // an announcement that could name any address on the internet could point
  // the phone line at any of them. Same origin, or we do not take it.
  const offered = typeof record["audio"] === "string" ? record["audio"] : "";
  const parsed = offered ? publishable(offered) : null;
  const audio = parsed !== null && parsed.origin === listen.origin ? offered : "";
  // The admin link is held to the same rule: it names this server or nothing.
  const adminOffered = typeof record["admin"] === "string" ? record["admin"] : "";
  const adminParsed = adminOffered ? publishable(adminOffered) : null;
  const admin = adminParsed !== null && adminParsed.origin === listen.origin ? adminOffered : "";

  const name = clean(record["name"], MAX_NAME);
  const tracks = Number(record["tracks"]);
  return {
    ...(typeof record["id"] === "string" ? { id: clean(record["id"], 40) } : {}),
    name: name || "a nixamp",
    url,
    ...(audio ? { audio } : {}),
    ...(admin ? { admin } : {}),
    tracks: Number.isFinite(tracks) && tracks >= 0 ? Math.min(1_000_000, Math.floor(tracks)) : 0,
    nowPlaying: clean(record["nowPlaying"], MAX_TRACK),
    ...(typeof record["playing"] === "boolean" ? { playing: record["playing"] } : {}),
    ...(Array.isArray(record["channels"])
      ? {
          channels: (record["channels"] as unknown[])
            .map((one) => clean(one, MAX_NAME))
            .filter((one) => one !== "")
            .slice(0, MAX_CHANNELS),
        }
      : {}),
  };
}

/**
 * The registry. In memory on purpose: see the note at the top of the file.
 * One entry per URL, so a publisher restarting does not leave a ghost of
 * itself behind next to the entry that replaced it.
 */
export class Directory {
  private readonly items = new Map<string, Listing>();
  /** Streams that stopped, so the phone line can say when. */
  private readonly ended = new Map<string, Ended>();
  private sequence = 0;
  /**
   * Somewhere to echo the ended list, so it survives a restart.
   *
   * Attached after construction rather than taken as a constructor argument:
   * this is a mirror, not a dependency, and the directory works exactly as it
   * did without one.
   */
  private mirror: { save: (item: Ended) => void; drop: (id: string) => void } | null = null;

  /** Start echoing ended streams somewhere durable. */
  persistTo(mirror: { save: (item: Ended) => void; drop: (id: string) => void }): void {
    this.mirror = mirror;
  }

  /**
   * Put back what a previous process knew.
   *
   * Only fills gaps: anything already here was announced since we started and
   * is newer than a row written before the restart.
   */
  seedEnded(items: readonly Ended[]): void {
    for (const item of items) {
      if (!this.ended.has(item.id) && !this.items.has(item.id)) this.ended.set(item.id, item);
    }
  }

  constructor(
    private readonly ttl = TTL_MS,
    private readonly now: () => number = Date.now,
    /** Injected so a test can make a code predictable rather than guess it. */
    private readonly randomCode: () => string = () =>
      String(randomInt(0, 1_000_000)).padStart(6, "0"),
    /**
     * Called when a stream starts, and only then.
     *
     * A publisher announces every ninety seconds for as long as it is up, so
     * "announced" is not "went live" -- telling followers on every heartbeat
     * would be telling them forty times an hour. This fires on the transition
     * and not on the renewals that follow it.
     */
    private readonly onLive: (listing: Listing) => void = () => {},
  ) {}

  announce(announcement: Announcement, ownerId = ""): Listing {
    this.sweep();
    const existing = [...this.items.values()].find((item) => item.url === announcement.url);

    // A stream coming back after a gap keeps the code it had, so a caller who
    // was told "call back later" can key the same six digits and get through.
    const previously = existing ?? this.endedByUrl(announcement.url);
    const id = previously?.id ?? `s${++this.sequence}${this.now().toString(36)}`;
    const code = previously?.code ?? this.freeCode();
    if (this.ended.has(id)) {
      this.ended.delete(id);
      this.mirror?.drop(id);
    }

    const listing: Listing = {
      id,
      code,
      name: announcement.name,
      // A returning stream keeps the owner it had, so a heartbeat that omits
      // it cannot orphan a listing people are following.
      ownerId: ownerId || existing?.ownerId || previously?.ownerId || "",
      url: announcement.url,
      // A heartbeat that omits it keeps what we had, the same as the owner: an
      // older publisher renewing an entry should not blank the address the
      // phone line is playing from.
      audio: announcement.audio ?? existing?.audio ?? "",
      admin: announcement.admin ?? existing?.admin ?? "",
      tracks: announcement.tracks,
      nowPlaying: announcement.nowPlaying,
      // An older publisher says nothing about either; "playing" keeps what a
      // listing always meant, and no channels is the honest empty list.
      playing: announcement.playing ?? true,
      channels: announcement.channels ?? [],
      channelCodes: this.codesFor(
        announcement.channels ?? [],
        existing?.channelCodes ?? (previously && "channelCodes" in previously ? previously.channelCodes : undefined),
        id,
      ),
      updatedAt: this.now(),
      // A stream that never stopped keeps its original start. One that did
      // starts again now, because that is what a caller is being told about.
      startedAt: existing?.startedAt ?? this.now(),
    };
    this.items.set(id, listing);
    // The transition, not the heartbeat: existing means it was already live.
    if (existing === undefined) this.onLive(listing);
    return listing;
  }

  withdraw(id: string): void {
    const item = this.items.get(id);
    if (item !== undefined) this.remember(item);
    this.items.delete(id);
  }

  list(): Listing[] {
    this.sweep();
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  /**
   * The live stream on this code, if there is one.
   *
   * A channel's code answers as the channel: the same listing, named for the
   * channel and playing nothing else, so the phone line says "the live room
   * for FIBA World Cup" rather than the server's name and whatever its own
   * player has on.
   */
  liveByCode(code: string): Listing | undefined {
    this.sweep();
    const own = [...this.items.values()].find((item) => item.code === code);
    if (own !== undefined) return own;
    for (const item of this.items.values()) {
      const channel = Object.entries(item.channelCodes).find(([, one]) => one === code)?.[0];
      if (channel !== undefined) return { ...item, code, name: channel, nowPlaying: "" };
    }
    return undefined;
  }

  /**
   * A code for each channel, kept while the channel stays on.
   *
   * One code per server meant every live on it shared a room: somebody
   * calling about the basketball landed with the people talking about the
   * film. Each live is its own room now, and a channel that is still there at
   * the next heartbeat keeps the code it was given.
   */
  private codesFor(channels: string[], had: Record<string, string> | undefined, own = ""): Record<string, string> {
    const codes: Record<string, string> = {};
    for (const name of channels) {
      if (codes[name] !== undefined) continue;
      const kept = had?.[name];
      codes[name] = kept !== undefined && !this.taken(kept, codes, own) ? kept : this.freeCode(codes, own);
    }
    return codes;
  }

  /**
   * Whether a code is somebody's already: a stream's own, a channel's on any
   * stream, or a recently-ended stream's. A listing renewing itself is not
   * "somebody else", or its channels would be re-coded every heartbeat.
   */
  private taken(code: string, besides: Record<string, string> = {}, own = ""): boolean {
    if (Object.values(besides).includes(code)) return true;
    for (const item of this.items.values()) {
      if (item.code === code) return true;
      if (item.id !== own && Object.values(item.channelCodes).includes(code)) return true;
    }
    return [...this.ended.values()].some((i) => i.code === code);
  }

  /**
   * Streams that stopped recently, most recent first.
   *
   * Kept for the phone line, which has to say when a stream ended -- but they
   * answer a second question the live list cannot: who is there to follow.
   * Following exists to hear about broadcasts you would otherwise miss, and a
   * directory that only lists what is on can only be used to follow somebody
   * during a broadcast you did not miss.
   */
  recentlyEnded(): Ended[] {
    this.sweep();
    const live = new Set([...this.items.values()].map((item) => item.id));
    return [...this.ended.values()]
      .filter((item) => !live.has(item.id))
      .sort((a, b) => b.endedAt - a.endedAt);
  }

  /** The name last used by an account, live or recently ended. */
  nameOf(ownerId: string): string {
    if (!ownerId) return "";
    this.sweep();
    const live = [...this.items.values()].find((item) => item.ownerId === ownerId);
    if (live) return live.name;
    const ended = [...this.ended.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => b.endedAt - a.endedAt)[0];
    return ended?.name ?? "";
  }

  /** Whether this account is streaming right now. */
  isLive(ownerId: string): boolean {
    if (!ownerId) return false;
    this.sweep();
    return [...this.items.values()].some((item) => item.ownerId === ownerId);
  }

  /** The stream that used to be on this code, if it stopped recently. */
  endedByCode(code: string): Ended | undefined {
    this.sweep();
    return [...this.ended.values()].find((item) => item.code === code);
  }

  private endedByUrl(url: string): Ended | undefined {
    return [...this.ended.values()].find((item) => item.url === url);
  }

  private remember(item: Listing): void {
    const record: Ended = {
      id: item.id,
      code: item.code,
      name: item.name,
      ownerId: item.ownerId,
      url: item.url,
      nowPlaying: item.nowPlaying,
      startedAt: item.startedAt,
      endedAt: item.updatedAt,
    };
    this.ended.set(item.id, record);
    this.mirror?.save(record);
  }

  /** A code no live stream, no channel on one, and no recently-ended stream is using. */
  private freeCode(besides: Record<string, string> = {}, own = ""): string {
    for (let tries = 0; tries < 40; tries += 1) {
      const code = this.randomCode();
      if (code.length !== 6) continue;
      if (!this.taken(code, besides, own)) return code;
    }
    return "";
  }

  /** Forget anything that stopped renewing, keeping a note of when it did. */
  private sweep(): void {
    const cutoff = this.now() - this.ttl;
    for (const [id, item] of this.items) {
      if (item.updatedAt < cutoff) {
        this.remember(item);
        this.items.delete(id);
      }
    }
    const forget = this.now() - ENDED_TTL_MS;
    for (const [id, item] of this.ended) {
      if (item.endedAt < forget) {
        this.ended.delete(id);
        this.mirror?.drop(id);
      }
    }
  }
}

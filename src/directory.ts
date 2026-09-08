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
  /** The listen link, which is what a browser opens. */
  url: string;
  tracks: number;
  nowPlaying: string;
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
  tracks: number;
  nowPlaying: string;
}

const MAX_NAME = 60;
const MAX_TRACK = 120;

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
  if (publishable(url) === null) return null;

  const name = clean(record["name"], MAX_NAME);
  const tracks = Number(record["tracks"]);
  return {
    ...(typeof record["id"] === "string" ? { id: clean(record["id"], 40) } : {}),
    name: name || "a nixamp",
    url,
    tracks: Number.isFinite(tracks) && tracks >= 0 ? Math.min(1_000_000, Math.floor(tracks)) : 0,
    nowPlaying: clean(record["nowPlaying"], MAX_TRACK),
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

  constructor(
    private readonly ttl = TTL_MS,
    private readonly now: () => number = Date.now,
    /** Injected so a test can make a code predictable rather than guess it. */
    private readonly randomCode: () => string = () =>
      String(randomInt(0, 1_000_000)).padStart(6, "0"),
  ) {}

  announce(announcement: Announcement): Listing {
    this.sweep();
    const existing = [...this.items.values()].find((item) => item.url === announcement.url);

    // A stream coming back after a gap keeps the code it had, so a caller who
    // was told "call back later" can key the same six digits and get through.
    const previously = existing ?? this.endedByUrl(announcement.url);
    const id = previously?.id ?? `s${++this.sequence}${this.now().toString(36)}`;
    const code = previously?.code ?? this.freeCode();
    if (this.ended.has(id)) this.ended.delete(id);

    const listing: Listing = {
      id,
      code,
      name: announcement.name,
      url: announcement.url,
      tracks: announcement.tracks,
      nowPlaying: announcement.nowPlaying,
      updatedAt: this.now(),
      // A stream that never stopped keeps its original start. One that did
      // starts again now, because that is what a caller is being told about.
      startedAt: existing?.startedAt ?? this.now(),
    };
    this.items.set(id, listing);
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

  /** The live stream on this code, if there is one. */
  liveByCode(code: string): Listing | undefined {
    this.sweep();
    return [...this.items.values()].find((item) => item.code === code);
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
    this.ended.set(item.id, {
      id: item.id,
      code: item.code,
      name: item.name,
      url: item.url,
      nowPlaying: item.nowPlaying,
      startedAt: item.startedAt,
      endedAt: item.updatedAt,
    });
  }

  /** A code no live and no recently-ended stream is using. */
  private freeCode(): string {
    for (let tries = 0; tries < 40; tries += 1) {
      const code = this.randomCode();
      if (code.length !== 6) continue;
      const taken =
        [...this.items.values()].some((i) => i.code === code) ||
        [...this.ended.values()].some((i) => i.code === code);
      if (!taken) return code;
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
      if (item.endedAt < forget) this.ended.delete(id);
    }
  }
}

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
  name: string;
  /** The listen link, which is what a browser opens. */
  url: string;
  tracks: number;
  nowPlaying: string;
  /** Set by the directory from the request, never by the publisher. */
  updatedAt: number;
}

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
  private sequence = 0;

  constructor(
    private readonly ttl = TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  announce(announcement: Announcement): Listing {
    this.sweep();
    const existing = [...this.items.values()].find((item) => item.url === announcement.url);
    const id = existing?.id ?? `s${++this.sequence}${this.now().toString(36)}`;
    const listing: Listing = {
      id,
      name: announcement.name,
      url: announcement.url,
      tracks: announcement.tracks,
      nowPlaying: announcement.nowPlaying,
      updatedAt: this.now(),
    };
    this.items.set(id, listing);
    return listing;
  }

  withdraw(id: string): void {
    this.items.delete(id);
  }

  list(): Listing[] {
    this.sweep();
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  /** Forget anything that stopped renewing. */
  private sweep(): void {
    const cutoff = this.now() - this.ttl;
    for (const [id, item] of this.items) if (item.updatedAt < cutoff) this.items.delete(id);
  }
}

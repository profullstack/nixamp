/**
 * The remote-control client: this browser driving a `nixamp serve` somewhere
 * else — the laptop by the speakers, usually, from the phone on the sofa.
 *
 * State arrives over Server-Sent Events, which reconnect by themselves when
 * the phone sleeps; commands go back as small POSTs.
 */
import { emptySnapshot, type Command, type Snapshot } from "../../src/protocol.ts";

export type Status = "idle" | "connecting" | "live" | "error";

/**
 * What a person types is rarely a URL. `192.168.1.7:4321`, a trailing slash,
 * a pasted `/api/state` — all of them mean the same server.
 */
export function normalizeBase(input: string): string {
  let text = input.trim();
  if (text === "") return "";
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Someone pasting an endpoint means the server it belongs to.
  path = path.replace(/\/api(\/.*)?$/, "");
  return `${url.origin}${path}`;
}

export function apiUrl(base: string, path: string, key = ""): string {
  const root = base === "" ? "" : normalizeBase(base);
  const url = `${root}${path.startsWith("/") ? path : `/${path}`}`;
  if (!key) return url;
  // The key goes in the query, which is the only place it can go from another
  // origin. A cookie is same-origin, and the server answers with
  // access-control-allow-origin: * -- which browsers refuse to send credentials
  // to at all -- so a header cannot carry it either.
  return `${url}${url.includes("?") ? "&" : "?"}k=${encodeURIComponent(key)}`;
}

/**
 * A share link split into the two things it is.
 *
 * People paste the link they were given, which is an address with a key on the
 * end of it: `https://host:4321/admin/KEY`. As a base that is useless -- there
 * is no /admin/KEY/api/state, and asking for one gets a 404 -- and thrown away it is
 * worse, because without the key every request from another origin is a 401.
 * So it is taken apart and both halves are kept.
 */
export function splitShareLink(input: string): { base: string; key: string } {
  const text = input.trim();
  if (text === "") return { base: "", key: "" };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { base: "", key: "" };
  }

  // Either shape a key arrives in: /admin/ administers, /view/ only views.
  const share = /^\/(?:admin|view)\/([^/]+)\/?$/.exec(url.pathname);
  const key = share?.[1] ?? url.searchParams.get("k") ?? "";
  if (share) url.pathname = "/";
  url.searchParams.delete("k");
  return { base: normalizeBase(`${url.origin}${url.pathname}`), key: decodeURIComponent(key) };
}

/** Where the browser fetches a track's bytes from, to play it here. */
export function mediaUrl(base: string, index: number, kbps = 0, key = ""): string {
  const path = kbps > 0 ? `/api/media/${index}?kbps=${Math.round(kbps)}` : `/api/media/${index}`;
  return apiUrl(base, path, key);
}

/** A snapshot off the wire is untrusted JSON; missing fields get defaults. */
export function parseSnapshot(input: unknown): Snapshot | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const base = emptySnapshot();
  const numeric = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const levels = Array.isArray(record.levels) ? record.levels : [];
  // A frame carries the library only when it has changed, so a frame without
  // one is ordinary rather than malformed. Refusing those would have thrown
  // away every frame but the first.
  const tracks = Array.isArray(record.tracks)
    ? record.tracks.map((raw) => {
        const t = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        return {
          title: typeof t.title === "string" ? t.title : "Untitled",
          artist: typeof t.artist === "string" ? t.artist : "",
          album: typeof t.album === "string" ? t.album : "",
          duration: numeric(t.duration, 0),
          // Rebuilding a track field by field drops anything not listed, and
          // this one is the difference between a film and its soundtrack.
          ...(t.video === true ? { video: true } : {}),
          // Which pile this track is in. Dropped here, the playlist goes back
          // to being one undifferentiated list of everything.
          ...(typeof t.group === "string" && t.group !== "" ? { group: t.group } : {}),
        };
      })
    : undefined;
  return {
    revision: numeric(record.revision, 0),
    ...(tracks ? { tracks } : {}),
    trackCount: numeric(record.trackCount, tracks?.length ?? 0),
    index: numeric(record.index, 0),
    playing: record.playing === true,
    position: numeric(record.position, 0),
    bars: Array.isArray(record.bars) ? record.bars.map((b) => numeric(b, 0)) : [],
    levels: [numeric(levels[0], 0), numeric(levels[1], 0)],
    silent: record.silent === true,
    note: typeof record.note === "string" ? record.note : "",
    root: typeof record.root === "string" ? record.root : base.root,
  };
}

export interface RemoteHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onStatus: (status: Status, detail?: string) => void;
}

export class RemoteClient {
  private source: EventSource | null = null;
  private base = "";
  /** The share key, when the address came with one. Empty is same-origin. */
  private key = "";
  /** Which door the key was handed over at: /a/ administers, /v/ only views. */
  private shape = "/admin/";
  private lastRevision = -1;

  constructor(private readonly handlers: RemoteHandlers) {}

  get address(): string {
    return this.base;
  }

  /** Any endpoint on the connected server, with the key already on it. */
  url(path: string): string {
    return apiUrl(this.base, path, this.key);
  }

  /**
   * The link that gets somebody else to this stream.
   *
   * Put back together from the two halves it was taken apart into, because
   * what a person passes on is the whole thing.
   */
  get shareLink(): string {
    if (this.base === "") return "";
    // The shape it came in, so an admin link stays an admin link and a view
    // link stays a view link rather than being quietly relabelled.
    return this.key === "" ? this.base : `${this.base}${this.shape}${this.key}`;
  }

  get connected(): boolean {
    return this.source !== null;
  }

  connect(input: string): void {
    // A pasted share link is an address and a key, and both are needed: the
    // address alone is a 401 from any other origin.
    const { base, key } = splitShareLink(input);
    this.close();
    this.base = base;
    this.key = key;
    this.shape = /\/view\/[^/]+\/?$/.test(input.trim()) ? "/view/" : "/admin/";
    this.lastRevision = -1;
    this.handlers.onStatus("connecting");
    const source = new EventSource(apiUrl(base, "/api/events", key));
    this.source = source;
    source.onopen = () => this.handlers.onStatus("live");
    source.onmessage = (event: MessageEvent<string>) => {
      const snapshot = parseSnapshot(safeJson(event.data));
      if (!snapshot) return;
      // SSE can redeliver on reconnect; an older frame must not undo a newer one.
      if (snapshot.revision < this.lastRevision) return;
      this.lastRevision = snapshot.revision;
      this.handlers.onStatus("live");
      this.handlers.onSnapshot(snapshot);
    };
    source.onerror = () => {
      // EventSource retries on its own — say so rather than tearing it down.
      this.handlers.onStatus("error", "reconnecting…");
    };
  }

  async send(command: Command): Promise<void> {
    if (this.base === "" && !this.connected) return;
    const response = await fetch(apiUrl(this.base, "/api/command", this.key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      this.handlers.onStatus("error", `command refused (${response.status})`);
      return;
    }
    const snapshot = parseSnapshot(await response.json());
    if (snapshot) this.handlers.onSnapshot(snapshot);
  }

  media(index: number, kbps = 0): string {
    return mediaUrl(this.base, index, kbps, this.key);
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** One snapshot, without opening a stream. */
export async function fetchSnapshot(base: string, signal?: AbortSignal, key = ""): Promise<Snapshot | null> {
  try {
    const response = await fetch(apiUrl(base, "/api/state", key), { signal });
    if (!response.ok) return null;
    return parseSnapshot(await response.json());
  } catch {
    return null;
  }
}

/**
 * Why an https link to a bare IP cannot work, when that is what it is.
 *
 * A certificate is issued for a name, so a browser handed `https://1.2.3.4`
 * has nothing to check it against and refuses before it asks anything. From
 * here that is indistinguishable from a machine that is switched off, and
 * telling somebody their running server is off is worse than saying nothing.
 */
export function needsAName(base: string): string {
  if (!/^https:\/\//i.test(base)) return "";
  let host: string;
  try {
    host = new URL(base).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (!isIp) return "";
  return (
    "That is an https address for a bare IP, and a certificate is issued for a name — " +
    "a browser refuses it before it asks anything. Use the server's name instead " +
    "(the address it printed first), or connect over http."
  );
}

/**
 * Why this server will not talk to us, if it will not. Empty means it will.
 *
 * `/api/health` answers to anybody, on purpose: it is how you check a port is
 * open. So a healthy answer is not permission, and the first request that
 * actually needed permission was the event stream -- which cannot report a
 * 401, only retry. The page said "reconnecting..." indefinitely about a server
 * that had already refused it, which is the least useful true thing it could
 * have said.
 */
export async function refusesUs(base: string, key = "", signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(apiUrl(base, "/api/state", key), { signal });
  } catch {
    // Unreachable is a different problem, and the caller has already found the
    // server answering, so this is not the place to guess about it.
    return "";
  }
  if (response.ok) return "";
  if (response.status === 401) {
    return key === ""
      ? "That server needs its share link. Paste the whole link — the one with /admin/ or /view/ in it — or sign in as its owner."
      : "That share link is not accepted by that server. It may have been restarted, which gives it a new one.";
  }
  if (response.status === 403) return "That link can listen but not drive this server.";
  if (response.status === 429) return "That server is asking us to slow down. Try again in a moment.";
  return "";
}

/** Is there a nixamp at this address? Used before committing to a connection. */
export async function probeServer(base: string, signal?: AbortSignal, key = ""): Promise<string | null> {
  try {
    const response = await fetch(apiUrl(base, "/api/health", key), { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { name?: string; version?: string };
    return body.name === "nixamp" ? (body.version ?? "unknown") : null;
  } catch {
    return null;
  }
}

/**
 * Why this page cannot reach that address, when the reason is the page itself.
 *
 * A browser refuses every request from an https page to an http one -- fetch,
 * event stream, and audio and video alike, which it upgrades to https and then
 * gives up on. Nothing on either server lifts that, so a nixamp opened from
 * nixamp.com cannot talk to a nixamp on plain http however healthy both are.
 * Saying so beats a spinner that never resolves.
 */
export function blockedAsMixedContent(base: string, pageProtocol = globalThis.location?.protocol): string {
  if (pageProtocol !== "https:" || !/^http:\/\//i.test(base.trim())) return "";
  return (
    "This page is https, and a browser refuses every request from an https page to an http one. " +
    "Open that address directly, or give the server a certificate: nixamp serve --tls-cert cert.pem --tls-key key.pem."
  );
}

/**
 * The rungs a stream can be asked for, largest first.
 *
 * Not an HLS ladder: producing several renditions at once needs a machine that
 * can encode several at once, and the ones people run nixamp on cannot. This is
 * one rendition at a time, chosen to fit, which is what actually matters when a
 * film will not play at all.
 *
 * 0 means the original, untouched and unencoded, which is free for the server
 * and right whenever the link can carry it.
 */
export const LADDER = [0, 6000, 3000, 1500, 700] as const;

/**
 * The next rung down, or null at the bottom.
 *
 * Stepping rather than calculating, because the useful signal from a browser is
 * "this stalled again", not a number. Two stalls is the threshold: one is a
 * seek, a hiccup, or a laptop waking up.
 */
export function stepDown(current: number): number | null {
  const at = LADDER.indexOf(current as (typeof LADDER)[number]);
  const next = LADDER[(at === -1 ? 0 : at) + 1];
  return next === undefined ? null : next;
}

/** A rung a person chose, as it reads on a button. */
export function rungName(kbps: number): string {
  if (kbps === 0) return "Original";
  return kbps >= 1000 ? `${kbps / 1000} Mbps` : `${kbps} kbps`;
}

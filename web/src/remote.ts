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

export function apiUrl(base: string, path: string): string {
  const root = base === "" ? "" : normalizeBase(base);
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Where the browser fetches a track's bytes from, to play it here. */
export function mediaUrl(base: string, index: number): string {
  return apiUrl(base, `/api/media/${index}`);
}

/** A snapshot off the wire is untrusted JSON; missing fields get defaults. */
export function parseSnapshot(input: unknown): Snapshot | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.tracks)) return null;
  const base = emptySnapshot();
  const numeric = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const levels = Array.isArray(record.levels) ? record.levels : [];
  return {
    revision: numeric(record.revision, 0),
    tracks: record.tracks.map((raw) => {
      const t = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      return {
        title: typeof t.title === "string" ? t.title : "Untitled",
        artist: typeof t.artist === "string" ? t.artist : "",
        album: typeof t.album === "string" ? t.album : "",
        duration: numeric(t.duration, 0),
      };
    }),
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
  private lastRevision = -1;

  constructor(private readonly handlers: RemoteHandlers) {}

  get address(): string {
    return this.base;
  }

  get connected(): boolean {
    return this.source !== null;
  }

  connect(input: string): void {
    const base = normalizeBase(input);
    this.close();
    this.base = base;
    this.lastRevision = -1;
    this.handlers.onStatus("connecting");
    const source = new EventSource(apiUrl(base, "/api/events"));
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
    const response = await fetch(apiUrl(this.base, "/api/command"), {
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

  media(index: number): string {
    return mediaUrl(this.base, index);
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
export async function fetchSnapshot(base: string, signal?: AbortSignal): Promise<Snapshot | null> {
  try {
    const response = await fetch(apiUrl(base, "/api/state"), { signal });
    if (!response.ok) return null;
    return parseSnapshot(await response.json());
  } catch {
    return null;
  }
}

/** Is there a nixamp at this address? Used before committing to a connection. */
export async function probeServer(base: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(apiUrl(base, "/api/health"), { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { name?: string; version?: string };
    return body.name === "nixamp" ? (body.version ?? "unknown") : null;
  } catch {
    return null;
  }
}

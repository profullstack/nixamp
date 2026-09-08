/**
 * Server mode: nixamp keeps playing on this machine and hands out a remote.
 *
 *   nixamp serve ~/Music --port 4321
 *
 * The same decode that feeds the speakers feeds the analyser, exactly as in the
 * terminal app; the HTTP layer only reads the state it produces and writes the
 * commands a remote sends. State is pushed over Server-Sent Events rather than
 * a WebSocket because SSE is plain HTTP: no dependency, and it reconnects on
 * its own when the laptop running the remote goes to sleep.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Connections, type Kind } from "./connections.ts";
import {
  Broadcaster,
  DEFAULT_ENCODER,
  type Destination,
  type EncoderSettings,
  PRESETS,
  redact,
} from "./broadcast.ts";
import { Ingest, normaliseFormat } from "./ingest.ts";
import { Accounts, clearedCookie, sessionCookie, tokenFrom } from "./accounts.ts";
import { Directory, parseAnnouncement } from "./directory.ts";
import { confirm, DEFAULT_DIRECTORY, Publisher } from "./publish.ts";
import {
  applyRemoteConfig,
  createPaywall,
  FREE_LISTENERS,
  type PaywallConfig,
  paywallFromEnv,
} from "./paywall.ts";
import { isRemote } from "./sources.ts";
import {
  allowedForListening,
  elevate,
  firewallInUse,
  keyCookie,
  keyFrom,
  keysMatch,
  newKey,
  portCommands,
  reachableAddresses,
  scopeOf,
  shareLink,
} from "./share.ts";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectTools, peaks, RATE, Stream, toMono,
  type Tools, type Track,
} from "./audio.ts";
import { Analyser, bandEdges, bands, decay } from "./fft.ts";
import { loadSource } from "./playlist.ts";
import {
  emptySnapshot, parseCommand,
  type Command, type RemoteTrack, type Snapshot,
} from "./protocol.ts";

const FFT_SIZE = 2048;
export const SERVE_BAND_COUNT = 24;
export const DEFAULT_PORT = 4321;

export interface ServeOptions {
  root: string;
  port: number;
  host: string;
  /** Directory of built PWA files to serve at `/`, when there is one. */
  web: string | null;
  /** Stream the library's bytes to remotes. Off keeps the audio on this box. */
  media: boolean;
  /**
   * Require the key from the share link. Off serves to anyone who can reach the
   * port, which is what the public deployment wants and no private one does.
   */
  key: boolean;
  /**
   * Ask the local firewall to let the port through, and put it back on the way
   * out. Off by default because it changes the machine, not just this process.
   */
  openPort: boolean;
  /**
   * Print one JSON line once listening. `nixamp daemon start` reads it rather
   * than sleeping and hoping, so a daemon that failed to bind is reported as
   * failed instead of started.
   */
  announce: boolean;
  /** Host the public directory. Only the deployment behind nixamp.com does. */
  directory: boolean;
  /**
   * List this stream at nixamp.com/directory. "ask" prompts, and is the
   * default: publishing an address without being asked is not something a
   * player gets to decide for you.
   */
  publish: "ask" | "yes" | "no";
  /** What to call it in the list. Defaults to this machine's hostname. */
  name: string;
  /**
   * Charge for listening once the stream is busy. Off unless asked for, and
   * useless without somewhere to pay: see NIXAMP_PAY_TO.
   */
  x402: boolean;
  /** Accept a live stream from a phone or a desktop, over HTTP. */
  ingest: boolean;
  /**
   * Also listen for RTMP publishers on this port, which is what OBS, Larix and
   * anything else native speaks. 0 means do not.
   */
  rtmpIn: number;
  /**
   * RTMP destinations, as `name=rtmp://host/app/key` or `youtube=key` for one
   * of the presets. Repeatable.
   */
  rtmp: string[];
}

/**
 * Flags are parsed by hand: three of them do not justify a dependency, and the
 * failure mode of a wrong `--port` should be a message rather than NaN.
 */
export function parseServeArgs(argv: string[]): ServeOptions {
  // A platform that hands out the port does it through PORT; a flag still wins.
  const fromEnv = Number(process.env.PORT);
  const options: ServeOptions = {
    root: ".",
    port: Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535 ? fromEnv : DEFAULT_PORT,
    // Every interface, because a player nobody else can reach is not much of a
    // remote. The key in the link is what makes that safe; --no-key gives up
    // both at once, and --host pins it back to one address.
    host: "0.0.0.0",
    web: null,
    media: true,
    key: true,
    openPort: false,
    announce: false,
    directory: false,
    publish: "ask",
    name: "",
    x402: false,
    ingest: false,
    rtmpIn: 0,
    rtmp: [],
  };
  let sawRoot = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`nixamp serve: ${arg} needs a value`);
      i++;
      return next;
    };
    if (arg === "--port" || arg === "-p") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("nixamp serve: --port must be a port number");
      }
      options.port = port;
    } else if (arg === "--host" || arg === "-h") {
      options.host = value();
    } else if (arg === "--web") {
      options.web = value();
    } else if (arg === "--no-media") {
      options.media = false;
    } else if (arg === "--no-key") {
      options.key = false;
    } else if (arg === "--open-port") {
      options.openPort = true;
    } else if (arg === "--announce") {
      options.announce = true;
    } else if (arg === "--directory") {
      options.directory = true;
    } else if (arg === "--publish") {
      options.publish = "yes";
    } else if (arg === "--no-publish") {
      options.publish = "no";
    } else if (arg === "--name") {
      options.name = value();
    } else if (arg === "--ingest") {
      options.ingest = true;
    } else if (arg === "--rtmp-in") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("nixamp serve: --rtmp-in must be a port number");
      }
      options.rtmpIn = port;
      // Listening for RTMP is accepting a live stream, so it implies --ingest.
      options.ingest = true;
    } else if (arg === "--rtmp") {
      options.rtmp.push(value());
    } else if (arg === "--x402") {
      options.x402 = true;
    } else if (arg === "--no-x402") {
      options.x402 = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`nixamp serve: unknown option ${arg}`);
    } else if (!sawRoot) {
      options.root = arg;
      sawRoot = true;
    }
  }
  return options;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  // The installer, so `curl https://nixamp.com/install.sh` is readable rather
  // than a download prompt.
  ".sh": "text/x-shellscript; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".alac": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * `Range: bytes=0-` and friends. Anything malformed, unsatisfiable or
 * multi-range is a null, which the caller answers with the whole file —
 * the behaviour a browser expects when it cannot have the range it asked for.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Resolve a URL path inside a directory, or null when it escapes.
 * `..` in a request path is the oldest bug in static file serving.
 */
export function safeJoin(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(rootDir);
  const full = resolve(base, "." + normalize(decoded.startsWith("/") ? decoded : `/${decoded}`));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/** What the HTTP layer needs from a player. Tests hand it a fake. */
export interface Engine {
  snapshot(): Snapshot;
  command(command: Command): void;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  /** Absolute path of a track, or undefined when the index is not one. */
  trackPath(index: number): string | undefined;
  /**
   * Play something else instead. Re-streaming is the whole reason the admin
   * view exists: point a running server at a URL without restarting it and
   * dropping every listener.
   */
  replace(tracks: Track[], root: string): void;
  stop(): void;
}

export function toRemoteTracks(tracks: Track[]): RemoteTrack[] {
  return tracks.map((t) => ({
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
  }));
}

/**
 * The headless player: the terminal app's engine without the terminal.
 * One ffmpeg decodes, ffplay makes the sound, and every sample is measured on
 * its way past so a remote can draw the same spectrum the TUI would.
 */
export class PlayerEngine implements Engine {
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private readonly analyser = new Analyser(FFT_SIZE, RATE);
  private readonly edges = bandEdges(SERVE_BAND_COUNT, RATE, FFT_SIZE);
  private readonly stream: Stream;
  private pending = new Float32Array(0);
  private revision = 0;
  /** Pushes are coalesced: the analyser fires far faster than a remote can draw. */
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  private state = {
    index: 0,
    playing: false,
    position: 0,
    bars: new Array<number>(SERVE_BAND_COUNT).fill(0),
    levels: [0, 0] as [number, number],
    note: "",
  };

  constructor(
    private tracks: Track[],
    private root: string,
    tools: Tools,
    /** Frames a second pushed to remotes. */
    private readonly fps = 12,
  ) {
    if (tools.play === null) {
      this.state.note = "No audio output found (install ffplay) — analyser only.";
    }
    this.silent = tools.play === null;
    this.stream = new Stream(tools, {
      onSamples: (pcm) => this.consume(pcm),
      onEnd: (error) => {
        if (error) {
          this.state.note = error;
          this.state.playing = false;
          this.push();
          return;
        }
        this.command({ type: "next" });
      },
    });
  }

  private readonly silent: boolean;

  private consume(pcm: Float32Array): void {
    this.state.levels = peaks(pcm);
    this.state.position = this.stream.position;
    const mono = toMono(pcm);
    const joined = new Float32Array(this.pending.length + mono.length);
    joined.set(this.pending);
    joined.set(mono, this.pending.length);
    let at = 0;
    while (joined.length - at >= FFT_SIZE) {
      this.analyser.run(joined.subarray(at, at + FFT_SIZE));
      this.state.bars = decay(this.state.bars, bands(this.analyser.magnitudes, this.edges));
      at += FFT_SIZE;
    }
    this.pending = joined.subarray(at);
    this.dirty = true;
  }

  snapshot(): Snapshot {
    return {
      revision: this.revision,
      tracks: toRemoteTracks(this.tracks),
      index: this.state.index,
      playing: this.state.playing,
      position: this.state.position,
      bars: [...this.state.bars],
      levels: [this.state.levels[0], this.state.levels[1]],
      silent: this.silent,
      note: this.state.note,
      root: this.root,
    };
  }

  trackPath(index: number): string | undefined {
    return this.tracks[index]?.path;
  }

  command(command: Command): void {
    switch (command.type) {
      case "play":
        if (command.index !== undefined) this.state.index = this.clamp(command.index);
        this.start();
        break;
      case "toggle":
        if (this.state.playing) this.halt(); else this.start();
        break;
      case "stop":
        this.halt();
        break;
      case "next":
        this.step(1);
        break;
      case "prev":
        this.step(-1);
        break;
      case "select":
        this.state.index = this.clamp(command.index);
        if (this.state.playing) this.start();
        break;
    }
    this.push();
  }

  private clamp(index: number): number {
    if (this.tracks.length === 0) return 0;
    return Math.max(0, Math.min(this.tracks.length - 1, index));
  }

  private step(delta: number): void {
    if (this.tracks.length === 0) return;
    this.state.index = (this.state.index + delta + this.tracks.length) % this.tracks.length;
    if (this.state.playing) this.start(); else this.state.position = 0;
  }

  private start(): void {
    const track = this.tracks[this.state.index];
    if (!track) return;
    this.pending = new Float32Array(0);
    this.state.position = 0;
    this.state.playing = true;
    this.stream.start(track);
  }

  private halt(): void {
    this.stream.stop();
    this.state.playing = false;
    this.state.position = 0;
    this.state.bars = new Array<number>(SERVE_BAND_COUNT).fill(0);
    this.state.levels = [0, 0];
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    if (this.timer === null && this.listeners.size > 0) {
      this.timer = setInterval(() => {
        if (!this.dirty) return;
        this.dirty = false;
        this.push();
      }, Math.max(1, Math.round(1000 / this.fps)));
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private push(): void {
    this.revision++;
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  stop(): void {
    this.halt();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  replace(tracks: Track[], root: string): void {
    this.stop();
    this.tracks = tracks;
    this.root = root;
    this.state.index = 0;
    this.state.position = 0;
    this.state.note = "";
    this.push();
  }
}

/** An engine with no library behind it, for the hosted PWA. */
export class EmptyEngine implements Engine {
  constructor(private readonly note = "No library on this server — open files, or point this remote at your own nixamp.") {}
  snapshot(): Snapshot {
    return { ...emptySnapshot(), note: this.note };
  }
  command(): void {}
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    listener(this.snapshot());
    return () => {};
  }
  trackPath(): undefined {
    return undefined;
  }
  replace(): void {}
  stop(): void {}
}

const CORS: Record<string, string> = {
  // A remote is a browser on another device on the same network, so the
  // control API has to be reachable cross-origin. It exposes no filesystem
  // paths and takes six commands; binding to 127.0.0.1 is what keeps it shut.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(response: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(code, {
    ...CORS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface HandlerOptions {
  web: string | null;
  media: boolean;
  version: string;
  /** The key from the share link, or null to serve to anyone who can connect. */
  key?: string | null;
  /**
   * A second key that may listen but not drive. The public directory hands
   * this one out: a link that lets a stranger pause your music is not a link
   * you can publish.
   */
  listenKey?: string | null;
  /** How to run ffmpeg, for the sources a browser cannot play by itself. */
  ffmpeg?: string[];
  /** Who is listening, for the admin view. */
  connections?: Connections;
  /**
   * How to turn a source into tracks, for re-streaming. Injected rather than
   * imported so the handler stays a plain function of a request.
   */
  load: (source: string) => Promise<Track[]>;
  /**
   * The public directory, on the instance that hosts one. Only nixamp.com
   * passes this; a nixamp on your laptop is a publisher, not a registry.
   */
  directory?: Directory;
  /** Answers a request itself when listening has to be paid for. */
  paywall?: (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>;
  /** Live audio coming in from a phone or a desktop. */
  ingest?: Ingest;
  /** Live audio going out to RTMP. */
  broadcaster?: Broadcaster;
  /** Where a broadcast should send, and what it should look like. */
  broadcast?: () => { destinations: Destination[]; settings: EncoderSettings };
  /** Accounts, on the instance that keeps them. Only nixamp.com passes this. */
  accounts?: Accounts;
  /** True when this instance is reached over https, for the cookie's Secure. */
  secureCookies?: boolean;
}

/**
 * The whole HTTP surface, as a plain function of a request — so a test can
 * drive it with a real socket and no ffmpeg in sight.
 */
export function createHandler(engine: Engine, options: HandlerOptions) {
  const tracker = options.connections ?? new Connections();
  const started = Date.now();

  /** Count a request in, count its bytes, and close it out exactly once. */
  const watch = (
    request: IncomingMessage,
    response: ServerResponse,
    kind: Kind,
    track: string,
  ): void => {
    const { id } = tracker.open(request, kind, track);
    const write = response.write.bind(response);
    response.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        tracker.add(id, typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength);
      }
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof response.write;
    // 'close' fires for a finished response and for a listener that walked
    // away, which are the same thing as far as "is it still going" goes.
    response.once("close", () => tracker.close(id));
  };

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const key = options.key ?? null;
    const listenKey = options.listenKey ?? null;

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    // Opening a share link is what hands a browser its key. It comes back as a
    // cookie, so every later fetch, EventSource and <audio src> carries it
    // without the page knowing anything about keys. Either key works here, and
    // which one was used decides what the browser can then do.
    if (key !== null && path.startsWith("/s/")) {
      const offered = decodeURIComponent(path.slice("/s/".length));
      if (scopeOf(offered, key, listenKey) === null) {
        json(response, 404, { error: "not found" });
        return;
      }
      response.writeHead(302, { ...CORS, "set-cookie": keyCookie(offered), location: "/" });
      response.end();
      return;
    }

    // /api/health answers unauthenticated on purpose: it is how you check the
    // port is open from another device before wondering whether the link is
    // wrong, and it says nothing about the library.
    if (
      key !== null &&
      path !== "/api/health" &&
      path !== "/api/directory" &&
      !path.startsWith("/api/v1/auth/")
    ) {
      const scope = scopeOf(keyFrom(request, url), key, listenKey);
      if (scope === null) {
        json(response, 401, { error: "this nixamp needs the key from its share link" });
        return;
      }
      if (scope === "listen" && !allowedForListening(path)) {
        json(response, 403, { error: "this link can listen, not drive" });
        return;
      }
    }

    if (path === "/api/health") {
      json(response, 200, { name: "nixamp", version: options.version, media: options.media });
      return;
    }

    // --- accounts ---------------------------------------------------------
    //
    // Before the share-key check, because signing in is how somebody without a
    // key becomes somebody with one. The API is versioned and namespaced the
    // way the rest of the fleet's is.
    if (path.startsWith("/api/v1/auth/") && options.accounts) {
      const accounts = options.accounts;
      const secure = options.secureCookies ?? false;

      if (path === "/api/v1/auth/me") {
        const who = await accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }
        json(response, 200, { account: who });
        return;
      }

      if (path === "/api/v1/auth/logout") {
        response.writeHead(200, {
          ...CORS,
          "content-type": "application/json; charset=utf-8",
          "set-cookie": clearedCookie(),
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      const signingUp = path === "/api/v1/auth/signup";
      if (!signingUp && path !== "/api/v1/auth/login") {
        json(response, 404, { error: "no such endpoint" });
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }

      let body: { email?: unknown; password?: unknown };
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }

      const result = signingUp
        ? await accounts.signUp(body.email, body.password)
        : await accounts.signIn(body.email, body.password);

      if (!result.ok) {
        // 409 for an address that is taken, 401 for credentials that are not.
        json(response, signingUp ? 409 : 401, { error: result.error });
        return;
      }

      // The token goes back in the body for the CLI and the desktop app, and
      // as a cookie for the browser, which then needs to know nothing about it.
      response.writeHead(200, {
        ...CORS,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookie(result.token, secure),
      });
      response.end(JSON.stringify({ account: result.account, token: result.token }));
      return;
    }

    // The directory is public in both directions: anyone may read the list,
    // and anyone running a nixamp may add themselves to it. It is answered
    // before the key check, because a visitor to nixamp.com has no key and is
    // exactly who it is for.
    if (path === "/api/directory" && options.directory) {
      if (request.method === "GET") {
        json(response, 200, { streams: options.directory.list(), now: Date.now() });
        return;
      }
      if (request.method === "POST") {
        let announcement;
        try {
          announcement = parseAnnouncement(JSON.parse(await readBody(request)));
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        if (announcement === null) {
          json(response, 422, { error: "a listing needs a name and a URL a browser can reach" });
          return;
        }
        json(response, 200, options.directory.announce(announcement));
        return;
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (id) options.directory.withdraw(id);
        json(response, 200, { ok: true });
        return;
      }
      json(response, 405, { error: "GET, POST or DELETE" });
      return;
    }

    // After the key check: a paying listener still needs the link, and a 402
    // is a worse answer than a 401 to someone who has neither.
    if (options.paywall && (await options.paywall(request, response, path))) return;

    // --- streaming in ---------------------------------------------------
    //
    // Both shapes write into the same ffmpeg, so everything downstream cannot
    // tell which one a sender used.
    if (path === "/api/ingest" && options.ingest) {
      if (request.method === "GET") {
        json(response, 200, options.ingest.status());
        return;
      }
      if (request.method === "DELETE") {
        options.ingest.close();
        json(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "GET, POST or DELETE" });
        return;
      }

      const format = normaliseFormat(url.searchParams.get("format") ?? request.headers["content-type"]);
      if (format === null) {
        json(response, 415, { error: "give a container ffmpeg knows: webm, ogg, mp4, mp3, wav" });
        return;
      }

      const session = options.ingest.open(url.searchParams.get("name") ?? "", format);
      if (session === null) {
        // Somebody else is already broadcasting, which is a different problem
        // from the request being wrong.
        json(response, 409, { error: "something is already streaming in" });
        return;
      }

      try {
        await options.ingest.pump(request);
      } catch {
        // A sender that hung up is not an error worth a 500.
      }
      options.ingest.close();
      json(response, 200, { ok: true, bytes: session.bytes });
      return;
    }

    // A browser cannot stream a request body over plain HTTP/1.1, so a phone
    // sends its recording a chunk at a time instead.
    if (path === "/api/ingest/chunk" && options.ingest) {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      if (!options.ingest.live) {
        const format = normaliseFormat(url.searchParams.get("format") ?? request.headers["content-type"]);
        if (format === null) {
          json(response, 415, { error: "give a container ffmpeg knows: webm, ogg, mp4, mp3, wav" });
          return;
        }
        if (options.ingest.open(url.searchParams.get("name") ?? "", format) === null) {
          json(response, 409, { error: "something is already streaming in" });
          return;
        }
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      options.ingest.write(Buffer.concat(chunks));
      json(response, 200, options.ingest.status());
      return;
    }

    // --- broadcasting out -------------------------------------------------
    if (path === "/api/broadcast" && options.broadcaster) {
      if (request.method === "GET") {
        json(response, 200, options.broadcaster.status());
        return;
      }
      if (request.method === "DELETE") {
        options.broadcaster.stop();
        json(response, 200, options.broadcaster.status());
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "GET, POST or DELETE" });
        return;
      }

      let source = "";
      try {
        source = String((JSON.parse(await readBody(request)) as { source?: unknown }).source ?? "");
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      const current = engine.snapshot();
      const chosen = source || engine.trackPath(current.index) || "";
      if (!chosen) {
        json(response, 422, { error: "nothing to broadcast" });
        return;
      }

      const plan = options.broadcast?.() ?? { destinations: [], settings: DEFAULT_ENCODER };
      const started = options.broadcaster.start({
        source: chosen,
        destinations: plan.destinations,
        settings: plan.settings,
        webAudio: false,
        // Music has no picture, and RTMP platforms insist on a video track.
        needsVideo: true,
      });
      if (!started.ok) {
        json(response, 422, { error: started.error });
        return;
      }
      json(response, 200, options.broadcaster.status());
      return;
    }

    // Names and URLs, never a key.
    if (path === "/api/broadcast/destinations" && options.broadcast) {
      json(response, 200, { destinations: options.broadcast().destinations.map(redact) });
      return;
    }

    if (path === "/api/state") {
      json(response, 200, engine.snapshot());
      return;
    }

    // Everything the admin view draws, in one request: who is connected, and
    // what this server is.
    if (path === "/api/connections") {
      json(response, 200, {
        connections: tracker.list(),
        active: tracker.active,
        startedAt: started,
        now: Date.now(),
      });
      return;
    }

    if (path === "/api/events") {
      watch(request, response, "events", "");
      response.writeHead(200, {
        ...CORS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        // nginx and friends buffer text/event-stream into uselessness.
        "x-accel-buffering": "no",
      });
      const send = (snapshot: Snapshot): void => {
        response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      };
      const unsubscribe = engine.subscribe(send);
      // A comment line keeps proxies from closing an idle stream.
      const beat = setInterval(() => response.write(": beat\n\n"), 20_000);
      beat.unref?.();
      const done = (): void => {
        clearInterval(beat);
        unsubscribe();
      };
      request.on("close", done);
      response.on("close", done);
      return;
    }

    if (path === "/api/command") {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(request)) as unknown;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      const command = parseCommand(parsed);
      if (!command) {
        json(response, 400, { error: "unknown command" });
        return;
      }
      engine.command(command);
      json(response, 200, engine.snapshot());
      return;
    }

    // Re-stream: hand the running server a different source. The listeners
    // stay connected; what they are listening to changes under them.
    if (path === "/api/source") {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      let source = "";
      try {
        source = String((JSON.parse(await readBody(request)) as { source?: unknown }).source ?? "");
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      if (!source) {
        json(response, 400, { error: "no source given" });
        return;
      }
      try {
        const tracks = await options.load(source);
        if (tracks.length === 0) {
          json(response, 422, { error: `nothing to play at ${source}` });
          return;
        }
        engine.replace(tracks, source);
        json(response, 200, engine.snapshot());
      } catch (error) {
        json(response, 422, { error: (error as Error).message.replace(/^nixamp: /, "") });
      }
      return;
    }

    if (path.startsWith("/api/media/")) {
      if (!options.media) {
        json(response, 403, { error: "media streaming is off" });
        return;
      }
      const index = Number(path.slice("/api/media/".length));
      const file = Number.isInteger(index) ? engine.trackPath(index) : undefined;
      if (file === undefined) {
        json(response, 404, { error: "no such track" });
        return;
      }
      watch(request, response, "media", engine.snapshot().tracks[index]?.title ?? file);
      sendFile(request, response, file);
      return;
    }

    // Whatever the source is, this comes back as MP3 a browser will play:
    // a flac, a wma, a URL, an HLS stream. ffmpeg reads them all and we hand
    // the bytes on as they arrive, so a live stream starts immediately rather
    // than after it ends, which for a live stream is never.
    if (path.startsWith("/api/stream/")) {
      const index = Number(path.slice("/api/stream/".length));
      const source = Number.isInteger(index) ? engine.trackPath(index) : undefined;
      if (source === undefined) {
        json(response, 404, { error: "no such track" });
        return;
      }
      if (!options.media) {
        json(response, 403, { error: "media streaming is off" });
        return;
      }
      watch(request, response, "stream", engine.snapshot().tracks[index]?.title ?? source);
      transcode(request, response, source, options.ffmpeg ?? ["ffmpeg"]);
      return;
    }

    if (path.startsWith("/api/")) {
      json(response, 404, { error: "no such endpoint" });
      return;
    }

    if (options.web !== null) {
      const direct = safeJoin(options.web, path);
      if (direct === null) {
        json(response, 400, { error: "bad path" });
        return;
      }
      let file: string | null = null;
      if (isFile(direct)) file = direct;
      else if (isFile(join(direct, "index.html"))) file = join(direct, "index.html");
      // A single-page app: any unknown path is the shell, and the client routes.
      else if (isFile(join(options.web, "index.html"))) file = join(options.web, "index.html");
      if (file !== null) {
        sendFile(request, response, file);
        return;
      }
    }

    json(response, 404, { error: "not found" });
  };
}

/** Read a file, or null. The firewall probe asks about files it may not have. */
function readIfPossible(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Decode anything and hand back MP3, as it is produced.
 *
 * No seeking: this is a pipe, and the length is not known until it ends. The
 * player falls back to /api/media for a local file it can seek, and uses this
 * for everything else.
 */
function transcode(
  request: IncomingMessage,
  response: ServerResponse,
  source: string,
  ffmpeg: string[],
): void {
  const [command, ...prefix] = ffmpeg as [string, ...string[]];
  const child = spawn(
    command,
    [
      ...prefix,
      "-hide_banner",
      "-loglevel", "error",
      // Reconnect through the sort of hiccup a long stream runs into. These
      // belong to the http protocol, and ffmpeg rejects the whole command
      // when they are handed to it for a file on disk.
      ...(isRemote(source) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []),
      "-i", source,
      "-vn",
      "-f", "mp3",
      "-b:a", "192k",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let failed = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // Keep the tail: ffmpeg says what went wrong on its last line.
    failed = (failed + chunk.toString()).slice(-2000);
  });

  let started = false;
  const begin = (): void => {
    if (started) return;
    started = true;
    response.writeHead(200, {
      ...CORS,
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      // Length is unknowable up front, and a browser is happy without it.
      "transfer-encoding": "chunked",
    });
  };
  // Wait for a first byte before promising success. ffmpeg rejects a bad option
  // or a missing input immediately, and answering 200 with nothing looks the
  // same from a player as a track that is simply silent.
  child.stdout.once("data", begin);
  // Both ends can fail: a listener closing the tab breaks the socket under the
  // pipe, and an EPIPE nobody is listening for takes the process down.
  child.stdout.on("error", () => child.kill("SIGKILL"));
  response.on("error", () => child.kill("SIGKILL"));
  child.stdout.pipe(response);

  child.on("error", (error) => {
    console.error(`nixamp: ffmpeg could not start: ${error.message}`);
    if (!response.headersSent) json(response, 500, { error: "ffmpeg could not start" });
    else response.end();
  });
  child.on("close", (code) => {
    const message = failed.trim();
    if (code !== 0 && code !== null) console.error(`nixamp: ffmpeg exited ${code}: ${message}`);
    if (!started) {
      // Nothing was ever produced, so the status can still tell the truth.
      json(response, 502, { error: "could not decode that source", detail: message.split("\n").pop() ?? "" });
      return;
    }
    response.end();
  });

  // A listener that closes the tab should not leave an ffmpeg decoding into
  // nothing for the rest of the album.
  const stop = (): void => {
    child.kill("SIGKILL");
  };
  request.on("close", stop);
  response.on("close", stop);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendFile(request: IncomingMessage, response: ServerResponse, file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    json(response, 404, { error: "not found" });
    return;
  }
  const type = contentType(file);
  const range = parseRange(request.headers.range, size);
  const headers: Record<string, string> = {
    ...CORS,
    "content-type": type,
    "accept-ranges": "bytes",
  };
  // The shell must never be cached by a service worker's fetch fallback, but
  // hashed assets and audio can be.
  headers["cache-control"] = type.startsWith("text/html") ? "no-cache" : "public, max-age=3600";

  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    response.writeHead(206, headers);
  } else {
    headers["content-length"] = String(size);
    response.writeHead(200, headers);
  }
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = range
    ? createReadStream(file, { start: range.start, end: range.end })
    : createReadStream(file);
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export function createServer(engine: Engine, options: HandlerOptions): Server {
  const handle = createHandler(engine, options);
  return createHttpServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "server error" });
      else response.end();
    });
  });
}


export async function serve(argv: string[], version = "0.1.0"): Promise<void> {
  const options = parseServeArgs(argv);
  const root = isRemote(options.root) ? options.root : resolve(options.root);
  const tools = detectTools();
  const tracks = await loadSource(tools, root);
  const engine: Engine = tracks.length > 0
    ? new PlayerEngine(tracks, root, tools)
    : new EmptyEngine(`No audio files under ${root}.`);

  const web = options.web !== null ? resolve(options.web) : defaultWebDir();
  const key = options.key ? newKey() : null;
  // Minted whether or not it is published, so `nixamp admin` and the operator
  // both have a link they can hand out without handing over the controls.
  const listenKey = key === null ? null : newKey();
  // Configuration can arrive from the directory later, so it is a box the
  // paywall reads rather than a value it was handed once.
  let paywallConfig: PaywallConfig = { ...paywallFromEnv(), enabled: options.x402 || paywallFromEnv().enabled };
  const connections = new Connections();
  const paywall = createPaywall({
    config: () => paywallConfig,
    liveListeners: () => connections.listening,
    // The address a payer can actually reach: the public one where there is
    // one, since a quote pointing at 192.168.1.5 is one they cannot pay from.
    siteUrl: () => {
      const bound = server.address();
      const live = typeof bound === "object" && bound !== null ? bound.port : options.port;
      const reachable = reachableAddresses(options.host, live);
      return (reachable.find((a) => a.label === "on the internet") ?? reachable[0])?.url
        ?? `http://127.0.0.1:${live}`;
    },
    // The operator drives with the control key, and is not a customer.
    exempt: (request) =>
      key !== null && scopeOf(keyFrom(request, new URL(request.url ?? "/", "http://localhost")), key, null) === "control",
  });

  const destinations = parseDestinations(options.rtmp);
  const broadcaster = new Broadcaster(tools.ffmpeg);
  const ingest = options.ingest
    ? new Ingest({
        ffmpeg: tools.ffmpeg,
        sink: "pipe:1",
        onStart: (session) => console.log(`  ${session.name} started streaming in (${session.format}).`),
        onEnd: (session, error) =>
          console.log(`  ${session.name} stopped streaming in${error ? `: ${error}` : ""}.`),
      })
    : undefined;

  const server = createServer(engine, {
    web,
    media: options.media,
    ...(ingest ? { ingest } : {}),
    broadcaster,
    broadcast: () => ({ destinations, settings: DEFAULT_ENCODER }),
    version,
    key,
    listenKey,
    connections,
    paywall,
    ffmpeg: tools.ffmpeg,
    load: (next) => loadSource(tools, next),
    ...(options.directory ? { directory: new Directory() } : {}),
    // Accounts live where the directory lives, and only there: a nixamp on a
    // laptop has nobody to be an account of.
    ...(options.directory && process.env["DATABASE_URL"]
      ? {
          accounts: new Accounts({
            connectionString: process.env["DATABASE_URL"],
            secret: process.env["NIXAMP_JWT_SECRET"] ?? "",
          }),
          secureCookies: (process.env["NIXAMP_SITE"] ?? "").startsWith("https://"),
        }
      : {}),
  });

  // A port already in use is the most ordinary failure there is, and it
  // arrives as an unhandled 'error' event that takes the process down with a
  // stack trace nobody reads.
  await new Promise<void>((done, fail) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      fail(
        new Error(
          error.code === "EADDRINUSE"
            ? `nixamp: port ${options.port} is already in use. Pass --port to pick another.`
            : error.code === "EACCES"
              ? `nixamp: not allowed to listen on port ${options.port}. Ports below 1024 need root.`
              : `nixamp: could not listen on ${options.host}:${options.port}: ${error.message}`,
        ),
      );
    });
    server.listen(options.port, options.host, done);
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;

  const io = {
    read: readIfPossible,
    run: (command: string, args: string[]) => {
      const done = spawnSync(command, args, { encoding: "utf8" });
      return { status: done.status, stdout: done.stdout ?? "" };
    },
  };

  if (options.announce) {
    console.log(JSON.stringify({ nixamp: "listening", host: options.host, port, key, source: root }));
  }

  console.log(`nixamp serve — ${tracks.length} tracks under ${root}`);
  console.log("");

  // The link, not the address. Without the key the address is a 401, so
  // printing a bare host:port would be printing something that does not work.
  const addresses = reachableAddresses(options.host, port);
  const width = Math.max(...addresses.map((a) => a.label.length));
  for (const { label, url } of addresses) {
    console.log(`  ${label.padEnd(width)}  ${shareLink(url, key)}`);
  }

  console.log("");
  if (key === null) {
    console.log("  No key: anyone who can reach this port can drive it and hear it.");
  } else {
    console.log("  Open that link once on a phone or a laptop and it stays signed in.");
    console.log(`  Anything without the key gets a 401. Key: ${key}`);
    if (listenKey !== null) {
      console.log("");
      console.log("  A listen-only link, for someone you want to hear it but not drive it:");
      for (const { label, url } of addresses) {
        if (label === "here") continue;
        console.log(`    ${shareLink(url, listenKey)}`);
      }
    }
  }
  if (addresses.some((a) => a.label === "on the internet")) {
    console.log("");
    console.log(
      key === null
        ? "  The public address is open to anyone: --no-key means no key. --host 127.0.0.1 keeps it here."
        : "  The public address works from anywhere, for anyone with the key. --host 127.0.0.1 keeps it here.",
    );
  }
  if (!options.media) console.log("  Audio stays on this machine: --no-media is set.");
  if (options.ingest) console.log("  Accepting a live stream in at POST /api/ingest.");
  if (options.rtmpIn > 0 && ingest) {
    const publish = addresses.find((a) => a.label !== "here") ?? addresses[0];
    const host = publish ? new URL(publish.url).hostname : "127.0.0.1";
    ingest.listenRtmp(options.rtmpIn, listenKey ?? "live");
    console.log(`  Or publish to it from OBS, Larix or ffmpeg:`);
    console.log(`    rtmp://${host}:${options.rtmpIn}/live/${listenKey ?? "live"}`);
  }
  if (destinations.length > 0) {
    console.log(`  Ready to broadcast to ${destinations.map((d) => d.name).join(", ")}.`);
  }
  if (web === null) console.log("  No built PWA found, so / has nothing to serve: run `bun run web:build`.");

  // Listening on every interface proves the socket is open here and nothing
  // about the path between here and the phone.
  const listening = options.host === "0.0.0.0" || options.host === "::";
  const firewall = listening ? firewallInUse(io) : null;
  let closePort: (() => void) | null = null;

  if (firewall !== null) {
    const { open, close } = portCommands(firewall, port);
    if (!options.openPort) {
      console.log("");
      console.log(`  ${firewall} is running, so other devices cannot reach this port yet:`);
      console.log(`    sudo ${open.join(" ")}`);
      console.log("  or start with --open-port and nixamp will do it, and undo it on exit.");
    } else {
      const elevated = elevate(io, open);
      if (elevated === null) {
        console.log("");
        console.log(`  --open-port needs root or passwordless sudo. Run this yourself:`);
        console.log(`    sudo ${open.join(" ")}`);
      } else {
        const done = spawnSync(elevated[0] as string, elevated.slice(1), { encoding: "utf8" });
        if (done.status === 0) {
          console.log("");
          console.log(`  Opened ${port}/tcp in ${firewall}. It closes again when this exits.`);
          // Leave the machine as it was found. A player should not be the
          // reason a port is still open next week.
          closePort = () => {
            const undo = elevate(io, close);
            if (undo) spawnSync(undo[0] as string, undo.slice(1), { stdio: "ignore" });
          };
        } else {
          console.log("");
          console.log(`  Could not open the port: ${(done.stderr || done.stdout || "").trim() || "unknown error"}`);
        }
      }
    }
  }

  // The listing carries the listen link, and only ever a public address: an
  // entry pointing at 192.168.1.5 is one nobody outside that house can open.
  const publishable_ = addresses.find((a) => a.label === "on the internet")
    ?? addresses.find((a) => a.label === "on tailscale");
  let publisher: Publisher | null = null;

  if (options.publish !== "no" && publishable_) {
    const listen = shareLink(publishable_.url, listenKey);
    const wanted = options.publish === "yes"
      ? true
      : await confirm(`\n  List this stream at ${DEFAULT_DIRECTORY}/directory so anyone can find it?\n  It publishes ${listen} — listen only, not the controls.`);

    if (wanted) {
      publisher = new Publisher({
        directory: DEFAULT_DIRECTORY,
        name: options.name || hostname(),
        url: listen,
        tracks: tracks.length,
        nowPlaying: () => {
          const snapshot = engine.snapshot();
          return snapshot.tracks[snapshot.index]?.title ?? "";
        },
        onConfig: (remote) => {
          const next = applyRemoteConfig(paywallConfig, (remote as { x402?: unknown })?.x402);
          if (JSON.stringify(next) === JSON.stringify(paywallConfig)) return;
          paywallConfig = next;
          console.log(next.enabled
            ? `  nixamp.com turned paid listening on: $${(next.priceCents / 100).toFixed(2)} for ${next.passMinutes} minutes, over ${FREE_LISTENERS} listeners.`
            : "  nixamp.com turned paid listening off.");
        },
      });
      const listing = await publisher.start();
      console.log("");
      console.log(listing
        ? `  Listed at ${DEFAULT_DIRECTORY}/directory as "${listing.name}". It leaves the list when this stops.`
        : `  Could not reach ${DEFAULT_DIRECTORY}; not listed.`);
    }
  } else if (options.publish === "yes" && !publishable_) {
    console.log("");
    console.log("  --publish needs an address the world can reach. This machine has none.");
  }

  const shutdown = (): void => {
    ingest?.stopRtmp();
    ingest?.close();
    broadcaster.stop();
    void publisher?.stop();
    closePort?.();
    engine.stop();
    server.close(() => process.exit(0));
    // A hung keep-alive should not outlive a ctrl-c.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * `--rtmp youtube=<key>` or `--rtmp name=rtmp://host/app/key`.
 *
 * A key is a password, so it is taken from the command line or the environment
 * and never from a request: a client that could name its own destination could
 * point your broadcast at itself.
 */
export function parseDestinations(specs: string[]): Destination[] {
  const out: Destination[] = [];
  for (const [index, spec] of specs.entries()) {
    const at = spec.indexOf("=");
    if (at <= 0) continue;
    const name = spec.slice(0, at).trim();
    const rest = spec.slice(at + 1).trim();
    if (!name || !rest) continue;

    const preset = PRESETS[name.toLowerCase()];
    if (preset && !/^rtmps?:\/\//i.test(rest)) {
      out.push({ id: String(index + 1), name, url: preset, key: rest, enabled: true });
      continue;
    }
    if (!/^rtmps?:\/\//i.test(rest)) continue;

    // A full URL: the last path segment is the key.
    const cut = rest.lastIndexOf("/");
    if (cut <= "rtmp://".length) continue;
    out.push({
      id: String(index + 1),
      name,
      url: rest.slice(0, cut),
      key: rest.slice(cut + 1),
      enabled: true,
    });
  }
  return out;
}

/** The built PWA, when it is sitting next to us in the same install. */
function defaultWebDir(): string | null {
  const fromEnv = process.env.NIXAMP_WEB_DIR;
  if (fromEnv && isFile(join(fromEnv, "index.html"))) return fromEnv;
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const guess of [
    join(here, "..", "web", "dist"),
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "web"),
  ]) {
    if (isFile(join(guess, "index.html"))) return resolve(guess);
  }
  return null;
}

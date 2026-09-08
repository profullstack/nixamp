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
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  detectTools, peaks, RATE, Stream, toMono,
  type Tools, type Track,
} from "./audio.ts";
import { Analyser, bandEdges, bands, decay } from "./fft.ts";
import { loadPlaylist } from "./playlist.ts";
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
    host: "127.0.0.1",
    web: null,
    media: true,
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
    private readonly tracks: Track[],
    private readonly root: string,
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
}

/**
 * The whole HTTP surface, as a plain function of a request — so a test can
 * drive it with a real socket and no ffmpeg in sight.
 */
export function createHandler(engine: Engine, options: HandlerOptions) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    if (path === "/api/health") {
      json(response, 200, { name: "nixamp", version: options.version, media: options.media });
      return;
    }

    if (path === "/api/state") {
      json(response, 200, engine.snapshot());
      return;
    }

    if (path === "/api/events") {
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
      sendFile(request, response, file);
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

/** Where a remote on another device should point its browser. */
export function addressesFor(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}`];
  const out = [`http://localhost:${port}`];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(`http://${entry.address}:${port}`);
    }
  }
  return out;
}

export async function serve(argv: string[], version = "0.1.0"): Promise<void> {
  const options = parseServeArgs(argv);
  const root = resolve(options.root);
  const tools = detectTools();
  const tracks = loadPlaylist(tools, root);
  const engine: Engine = tracks.length > 0
    ? new PlayerEngine(tracks, root, tools)
    : new EmptyEngine(`No audio files under ${root}.`);

  const web = options.web !== null ? resolve(options.web) : defaultWebDir();
  const server = createServer(engine, { web, media: options.media, version });

  await new Promise<void>((done) => server.listen(options.port, options.host, done));
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;
  console.log(`nixamp serve — ${tracks.length} tracks under ${root}`);
  for (const address of addressesFor(options.host, port)) console.log(`  ${address}`);
  if (web === null) console.log("  (no built PWA found — run `bun run web:build` to serve one)");

  const shutdown = (): void => {
    engine.stop();
    server.close(() => process.exit(0));
    // A hung keep-alive should not outlive a ctrl-c.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** The built PWA, when it is sitting next to us in the same install. */
function defaultWebDir(): string | null {
  const fromEnv = process.env.NIXAMP_WEB_DIR;
  if (fromEnv && isFile(join(fromEnv, "index.html"))) return fromEnv;
  const here = new URL(".", import.meta.url).pathname;
  for (const guess of [
    join(here, "..", "web", "dist"),
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "web"),
  ]) {
    if (isFile(join(guess, "index.html"))) return resolve(guess);
  }
  return null;
}

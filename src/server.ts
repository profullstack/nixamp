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
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
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
import { Channels, cleanId } from "./channels.ts";
import { RtmpListeners } from "./rtmp-in.ts";
import { Accounts, clearedCookie, sessionCookie, tokenFrom } from "./accounts.ts";
import { anonymousHandle, Handles } from "./handles.ts";
import { Servers } from "./servers.ts";
import { DeviceGrants } from "./device.ts";
import { BAD_KEY_LIMIT, callerOf, Guard, SIGN_IN_LIMIT } from "./guard.ts";
import {
  deviceDonePage,
  devicePage,
  exchangeCode,
  providersFrom,
  signInFailedPage,
  SignIn,
} from "./oauth.ts";
import { needsAdmin, Owner } from "./owner.ts";
import { readSession } from "./session.ts";
import { Directory, ENDED_TTL_MS, parseAnnouncement, type Listing } from "./directory.ts";
import { PartyLine, telnyxSms } from "./partyline.ts";
import { CALL_IN_NUMBER, OPT_IN_PATH, optInPage } from "./optin.ts";
import pg from "pg";
import { Follows, phoneFrom } from "./follows.ts";
import { Durable } from "./durable.ts";
import { notifyAll, resendEmail, webPush, type Notification } from "./notify.ts";
import { confirm, DEFAULT_DIRECTORY, Publisher } from "./publish.ts";
import {
  applyRemoteConfig,
  createPaywall,
  FREE_LISTENERS,
  type PaywallConfig,
  paywallFromEnv,
} from "./paywall.ts";
import { isRemote, playsInBrowser } from "./sources.ts";
import { codecsOf, videoArgs } from "./audio.ts";
import {
  allowedForListening,
  elevate,
  firewallInUse,
  keyCookie,
  keyFrom,
  keysMatch,
  lookupPublicIp,
  newKey,
  portCommands,
  reachableAddresses,
  scopeOf,
  shareLink,
  audioLink,
} from "./share.ts";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectTools, peaks, RATE, Stream, toMono,
  type Tools, type Track,
} from "./audio.ts";
import { Analyser, bandEdges, bands, decay } from "./fft.ts";
import { loadSource, loadTagged } from "./playlist.ts";
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
   * The address this server is reachable at from outside, when that is not one
   * of its own interfaces: a tunnel, a reverse proxy, a forwarded port.
   *
   * Without it a machine behind NAT has nothing to publish -- every address it
   * can see is a 192.168 one that is no use to anybody else -- so the directory
   * listing is skipped and the printed links only work inside the house.
   */
  publicUrl: string;
  /**
   * A certificate and its key, to serve https rather than http.
   *
   * Needed by anybody whose nixamp is opened from a page that is itself https:
   * a browser refuses every request from an https page to an http one --
   * fetch, event stream and media alike -- and no header on either side lifts
   * that. It is deliberately not required: a nixamp on 192.168.1.5 cannot have
   * a certificate for that address, and forcing one would put a browser
   * warning in front of everybody at home to fix a problem they do not have.
   */
  tlsCert: string;
  tlsKey: string;
  /**
   * Ask an outside service what this machine's public address is, when no
   * interface holds one and none was given. Behind NAT that is the only way to
   * learn it, and it is one short request at startup.
   */
  lookup: boolean;
  /**
   * Charge for listening once the stream is busy. Off unless asked for, and
   * useless without somewhere to pay: see NIXAMP_PAY_TO.
   */
  x402: boolean;
  /** The account id that may administer this server, if not the signed-in one. */
  owner: string;
  /** Accept a live stream from a phone or a desktop, over HTTP. */
  ingest: boolean;
  /**
   * Also listen for RTMP publishers on this port, which is what OBS, Larix and
   * anything else native speaks. 0 means do not.
   */
  rtmpIn: number;
  /**
   * How many RTMP publishers may be live at once. ffmpeg's listener serves one
   * connection per process, so this is a port and a process each: 1935, 1936,
   * and so on. HTTP publishers are not limited by this.
   */
  rtmpStreams: number;
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
    publicUrl: process.env["NIXAMP_PUBLIC_URL"] ?? "",
    lookup: true,
    tlsCert: process.env["NIXAMP_TLS_CERT"] ?? "",
    tlsKey: process.env["NIXAMP_TLS_KEY"] ?? "",
    x402: false,
    owner: "",
    ingest: false,
    rtmpIn: 0,
    rtmpStreams: 3,
    rtmp: [],
  };
  let sawRoot = false;
  const bothOrNeither = (): void => {
    if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) {
      throw new Error("nixamp serve: --tls-cert and --tls-key go together");
    }
  };
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
    } else if (arg === "--public-url") {
      const given = value().trim();
      // A hostname on its own is the likely typo, and it fails much later --
      // as a directory listing nobody can open -- so it is refused here.
      if (!/^https?:\/\/[^\s/]+/i.test(given)) {
        throw new Error("nixamp serve: --public-url must be a URL, e.g. https://nixamp.example.com");
      }
      options.publicUrl = given.replace(/\/+$/, "");
    } else if (arg === "--tls-cert") {
      options.tlsCert = value();
    } else if (arg === "--tls-key") {
      options.tlsKey = value();
    } else if (arg === "--no-lookup") {
      options.lookup = false;
    } else if (arg === "--name") {
      options.name = value();
    } else if (arg === "--owner") {
      options.owner = value();
    } else if (arg === "--ingest") {
      options.ingest = true;
    } else if (arg === "--rtmp-streams") {
      const count = Number(value());
      if (!Number.isInteger(count) || count < 1 || count > 16) {
        throw new Error("nixamp serve: --rtmp-streams must be between 1 and 16");
      }
      options.rtmpStreams = count;
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
  bothOrNeither();
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
  /** `withTracks` false leaves the library out, for a frame that is only motion. */
  snapshot(withTracks?: boolean): Snapshot;
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
  /**
   * The same tracks, now with their tags.
   *
   * Startup lists filenames and begins serving immediately, because an ffprobe
   * per file over a real library takes minutes; the tags arrive afterwards and
   * land here. Unlike `replace` this must not disturb anything -- whoever is
   * listening keeps listening, and the only visible change is that the titles
   * fill in.
   */
  retag(tracks: Track[], root: string): void;
  stop(): void;
}

export function toRemoteTracks(tracks: Track[]): RemoteTrack[] {
  return tracks.map((t) => ({
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    // Said out loud, because a remote cannot see the path and had been sending
    // every track to the audio element -- a film's soundtrack over a blank
    // panel, which is exactly what it looked like.
    ...(hasPicture(t.path) ? { video: true } : {}),
  }));
}

/** Video containers, as opposed to the songs that are most of a library. */
const PICTURE = new Set([".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".mpg", ".mpeg", ".wmv", ".flv"]);

export function hasPicture(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && PICTURE.has(path.slice(dot).toLowerCase());
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

  /**
   * The current state. `withTracks` carries the library, which is worth half a
   * megabyte on a real one and is only news when it has changed.
   */
  snapshot(withTracks = true): Snapshot {
    return {
      revision: this.revision,
      ...(withTracks ? { tracks: toRemoteTracks(this.tracks) } : {}),
      trackCount: this.tracks.length,
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

  /**
   * Send the state to everyone watching.
   *
   * The library goes only when `listChanged` says it has, which is what turned
   * five megabytes a second into a few kilobytes: an analyser tick has nothing
   * to say about the track list, and it fires twelve times a second.
   */
  private push(listChanged = false): void {
    this.revision++;
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot(listChanged);
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
    this.push(true);
  }

  retag(tracks: Track[], root: string): void {
    // Dropped rather than applied if the library moved underneath: somebody
    // re-streamed while the tagging was still running, and these tags describe
    // something nobody is playing any more.
    if (root !== this.root || tracks.length !== this.tracks.length) return;
    if (tracks.some((track, at) => track.path !== this.tracks[at]?.path)) return;
    this.tracks = tracks;
    // No stop, no index reset: the only thing that changes is what the titles
    // say, and every remote finds out because a snapshot goes out -- carrying
    // the list, since the titles are the whole point of this one.
    this.push(true);
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
  retag(): void {}
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

/** /api/v1/<provider>/oauth/start and .../callback, the house callback shape. */
const OAUTH_ROUTE = /^\/api\/v1\/([a-z0-9-]+)\/oauth\/(start|callback)$/;

/**
 * Paths that are how somebody without a key gets one, so they answer before
 * the share-key check rather than behind it.
 */
export function isSignInPath(path: string): boolean {
  return (
    path.startsWith("/api/v1/auth/") ||
    // The account's own server list: nixamp.com's API, gated by the session
    // rather than by a share key it has nothing to do with.
    path === "/api/v1/servers" ||
    path.startsWith("/api/v1/servers/") ||
    path === "/api/v1/me/handle" ||
    OAUTH_ROUTE.test(path)
  );
}

function html(response: ServerResponse, code: number, body: string): void {
  response.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

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
  /** Where ffprobe is, for asking what is inside a file before re-encoding it. */
  ffprobe?: string[];
  /** Who is listening, for the admin view. */
  connections?: Connections;
  /**
   * How to turn a source into tracks, for re-streaming. Injected rather than
   * imported so the handler stays a plain function of a request.
   */
  load: (source: string) => Promise<Track[]>;
  /**
   * The same source, with its tags, read without holding the event loop. Called
   * after `load` and never awaited: the titles arrive into a player that is
   * already playing.
   */
  tag?: (source: string) => Promise<Track[]>;
  /**
   * The public directory, on the instance that hosts one. Only nixamp.com
   * passes this; a nixamp on your laptop is a publisher, not a registry.
   */
  directory?: Directory;
  /** Answers a request itself when listening has to be paid for. */
  paywall?: (request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>;
  /** Live audio coming in from a phone or a desktop. */
  ingest?: Ingest;
  /** Several live streams at once, each with its own audience. */
  channels?: Channels;
  /** Live audio going out to RTMP. */
  broadcaster?: Broadcaster;
  /** Where a broadcast should send, and what it should look like. */
  broadcast?: () => { destinations: Destination[]; settings: EncoderSettings };
  /** Accounts, on the instance that keeps them. Only nixamp.com passes this. */
  accounts?: Accounts;
  /** Providers to sign in with, and the terminals waiting to be connected. */
  signIn?: SignIn;
  /** The servers each account runs, on the instance that keeps accounts. */
  servers?: Servers;
  /** The name other people see, which is never the address they signed up with. */
  handles?: Handles;
  /** True when this instance is reached over https, for the cookie's Secure. */
  secureCookies?: boolean;
  /** A certificate and key in PEM, when this server is to speak https itself. */
  tls?: { cert: string; key: string };
  /**
   * True when a proxy sits in front, so `x-forwarded-for` names the caller.
   * False everywhere else on purpose: the header is trivially forged, and
   * believing it from a direct caller hands them a fresh identity per request
   * and with it an unlimited number of password attempts.
   */
  behindProxy?: boolean;
  /** Who may administer this server. */
  owner?: Owner;
  /**
   * The dial-in party line, on the instance that answers the phone number.
   * Only nixamp.com passes this; a nixamp on a laptop has no number.
   */
  partyLine?: PartyLine;
  /**
   * Following broadcasters, and where to reach the people who do. Durable,
   * unlike everything else here, because the point of a follow is to outlive
   * the stream.
   */
  follows?: Follows;
  /** The VAPID public key a browser needs before it can subscribe. */
  vapidPublicKey?: string;
}

/**
 * The whole HTTP surface, as a plain function of a request — so a test can
 * drive it with a real socket and no ffmpeg in sight.
 */
export function createHandler(engine: Engine, options: HandlerOptions) {
  // One per server, so the counters survive between requests and die with it.
  const guard = new Guard();

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
    const behindProxy = options.behindProxy ?? false;
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

    // The page explaining the reminder texts. Public for the same reason the
    // webhook is: the reader is a carrier reviewing the number, or somebody
    // who just got a message and wants it to stop. Neither has a share link.
    if (path === OPT_IN_PATH && options.partyLine) {
      const body = optInPage();
      response.writeHead(200, {
        ...CORS,
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    // --- following a broadcaster ------------------------------------------
    //
    // Behind the sign-in rather than the share key: a follow belongs to an
    // account, and an account is the only thing that makes "notify me on my
    // other device" mean anything.
    if (path.startsWith("/api/v1/follows") && options.follows && options.accounts) {
      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in to follow" });
        return;
      }
      const follows = options.follows;

      if (path === "/api/v1/follows" && request.method === "GET") {
        const ids = await follows.following(me.id);
        // An id is not a name. The directory is the only thing that knows what
        // an account calls itself, from the last stream it announced -- which
        // is empty for somebody who has never streamed, and the caller decides
        // what to show for that rather than being handed a blank.
        json(response, 200, {
          following: ids.map((id) => ({
            id,
            name: options.directory?.nameOf(id) ?? "",
            live: options.directory?.isLive(id) ?? false,
          })),
        });
        return;
      }

      const streamer = path.slice("/api/v1/follows/".length);
      if (!path.startsWith("/api/v1/follows/") || !streamer) {
        json(response, 404, { error: "no such endpoint" });
        return;
      }

      if (request.method === "PUT" || request.method === "POST") {
        const added = await follows.follow(me.id, decodeURIComponent(streamer));
        // Following yourself is refused rather than silently stored: you do
        // not need telling that you went live.
        json(response, added ? 200 : 422, added
          ? { following: true, followers: await follows.followerCount(decodeURIComponent(streamer)) }
          : { error: "you cannot follow yourself" });
        return;
      }
      if (request.method === "DELETE") {
        await follows.unfollow(me.id, decodeURIComponent(streamer));
        json(response, 200, { following: false });
        return;
      }
      if (request.method === "GET") {
        json(response, 200, { following: await follows.isFollowing(me.id, decodeURIComponent(streamer)) });
        return;
      }
      json(response, 405, { error: "PUT, DELETE or GET" });
      return;
    }

    // --- where to reach a follower ----------------------------------------
    if (path.startsWith("/api/v1/notify") && options.follows && options.accounts) {
      // The key is public by design: it is what a browser needs before it can
      // ask permission, and it is useless without the private half.
      if (path === "/api/v1/notify/key" && request.method === "GET") {
        json(response, 200, { publicKey: options.vapidPublicKey ?? "" });
        return;
      }

      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in first" });
        return;
      }
      const follows = options.follows;

      if (path === "/api/v1/notify/prefs") {
        if (request.method === "GET") {
          json(response, 200, await follows.prefs(me.id));
          return;
        }
        if (request.method !== "PUT" && request.method !== "POST") {
          json(response, 405, { error: "GET or PUT" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        // A number we cannot dial is worse than no number: it is a text that
        // silently goes nowhere for as long as nobody checks.
        if (body["phone"] !== undefined && body["phone"] !== "" && !phoneFrom(body["phone"])) {
          json(response, 422, { error: "that does not look like a phone number" });
          return;
        }
        await follows.setPrefs(me.id, {
          ...(body["phone"] === undefined ? {} : { phone: String(body["phone"]) }),
          ...(typeof body["wantsEmail"] === "boolean" ? { wantsEmail: body["wantsEmail"] } : {}),
          ...(typeof body["wantsSms"] === "boolean" ? { wantsSms: body["wantsSms"] } : {}),
          ...(typeof body["wantsWeb"] === "boolean" ? { wantsWeb: body["wantsWeb"] } : {}),
        });
        json(response, 200, await follows.prefs(me.id));
        return;
      }

      if (path === "/api/v1/notify/subscribe") {
        if (request.method === "DELETE") {
          const endpoint = url.searchParams.get("endpoint") ?? "";
          await follows.removePush(endpoint);
          json(response, 200, { ok: true });
          return;
        }
        if (request.method !== "POST" && request.method !== "PUT") {
          json(response, 405, { error: "POST or DELETE" });
          return;
        }
        let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        try {
          body = JSON.parse(await readBody(request)) as typeof body;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
        const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
        const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
        if (!endpoint || !p256dh || !auth) {
          json(response, 422, { error: "a subscription needs an endpoint and both keys" });
          return;
        }
        await follows.addPush(me.id, { endpoint, p256dh, auth });
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { error: "no such endpoint" });
      return;
    }

    // --- the party line ---------------------------------------------------
    //
    // Ahead of the share-key check because the caller is a telephone. Telnyx
    // has no cookie and no link; what it has is an ed25519 signature over the
    // body, which is a stronger claim than a key in a URL anyway.
    if (path.startsWith("/api/v1/partyline/") && options.partyLine) {
      const partyLine = options.partyLine;

      if (path === "/api/v1/partyline/rooms") {
        json(response, 200, { rooms: partyLine.list() });
        return;
      }

      if (path !== "/api/v1/partyline/webhook") {
        json(response, 404, { error: "no such endpoint" });
        return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }

      // The bytes as they arrived. Parsing first and reserialising would
      // change the whitespace the signature was computed over.
      let raw: string;
      try {
        raw = await readBody(request);
      } catch {
        json(response, 413, { error: "body too large" });
        return;
      }

      const signature = request.headers["telnyx-signature-ed25519"];
      const timestamp = request.headers["telnyx-timestamp"];
      const ok = partyLine.verify(
        raw,
        typeof signature === "string" ? signature : undefined,
        typeof timestamp === "string" ? timestamp : undefined,
      );
      if (!ok) {
        json(response, 401, { error: "bad signature" });
        return;
      }

      let event: { data?: { event_type?: string; payload?: Record<string, unknown> } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }

      // Answer first, act second. Telnyx retries anything it does not hear
      // back about quickly, and a retried call.answered would ask the caller
      // which room they wanted twice.
      json(response, 200, { ok: true });
      void partyLine.handle(event.data ?? {}).catch(() => {});
      return;
    }

    // /api/health answers unauthenticated on purpose: it is how you check the
    // port is open from another device before wondering whether the link is
    // wrong, and it says nothing about the library.
    if (
      key !== null &&
      path !== "/api/health" &&
      path !== "/api/directory" &&
      !isSignInPath(path)
    ) {
      const scope = scopeOf(keyFrom(request, url), key, listenKey);
      if (scope === null) {
        // Counted, not because a 128-bit key falls to guessing, but because
        // somebody hammering one should stop costing this server anything.
        const who = callerOf(request.headers, request.socket.remoteAddress, behindProxy);
        const verdict = guard.check(`key:${who}`, BAD_KEY_LIMIT);
        if (!verdict.ok) {
          response.writeHead(429, { ...CORS, "content-type": "application/json; charset=utf-8", "retry-after": String(verdict.retryAfter) });
          response.end(JSON.stringify({ error: "too many attempts; wait a moment" }));
          return;
        }
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
        // The cookie going is what the browser notices; the token going is
        // what makes it stop working on a machine you no longer have.
        await accounts.endSession(tokenFrom(request.headers));
        response.writeHead(200, {
          ...CORS,
          "content-type": "application/json; charset=utf-8",
          "set-cookie": clearedCookie(),
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      // What this deployment will accept, so the CLI offers the ways in that
      // exist here rather than a menu built from what it hopes is configured.
      if (path === "/api/v1/auth/providers") {
        json(response, 200, {
          password: true,
          device: options.signIn !== undefined,
          providers: options.signIn?.offered ?? [],
        });
        return;
      }

      // --- the device grant, for a terminal with no browser ---------------
      if (path.startsWith("/api/v1/auth/device") && options.signIn) {
        const signIn = options.signIn;

        // A terminal asks for a code to show, and starts polling.
        if (path === "/api/v1/auth/device/code" && request.method === "POST") {
          const grant = signIn.device.start();
          const where = `${signIn.site}/api/v1/auth/device`;
          json(response, 200, {
            device_code: grant.deviceCode,
            user_code: grant.userCode,
            verification_uri: where,
            // The pre-filled link is what makes this one click on a phone.
            verification_uri_complete: `${where}?code=${encodeURIComponent(grant.userCode)}`,
            expires_in: Math.round((grant.expiresAt - Date.now()) / 1000),
            interval: signIn.device.interval,
          });
          return;
        }

        // ... and asks, at that interval, whether anybody has approved it yet.
        if (path === "/api/v1/auth/device/token" && request.method === "POST") {
          let body: { device_code?: unknown };
          try {
            body = JSON.parse(await readBody(request)) as typeof body;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return;
          }
          const status = signIn.device.poll(String(body.device_code ?? ""));
          if (status.status === "ok") {
            json(response, 200, { token: status.token, email: status.email });
            return;
          }
          // The names are RFC 8628's, because that is what a client waiting on
          // a device grant already knows how to read.
          const named = {
            pending: "authorization_pending",
            slow_down: "slow_down",
            expired: "expired_token",
            denied: "access_denied",
          } as const;
          json(response, 400, { error: named[status.status] });
          return;
        }

        // The page somebody opens on a device that has a keyboard.
        if (path === "/api/v1/auth/device" && (request.method === "GET" || request.method === "HEAD")) {
          const who = await accounts.whoIs(tokenFrom(request.headers));
          html(response, 200, devicePage(signIn, url.searchParams.get("code") ?? "", who?.email ?? ""));
          return;
        }

        if (path === "/api/v1/auth/device" && request.method === "POST") {
          const form = new URLSearchParams(await readBody(request));
          const code = form.get("code") ?? "";
          const grant = signIn.device.find(code);
          if (grant === null) {
            html(response, 404, signInFailedPage("That code has expired or was already used. Ask your terminal for another."));
            return;
          }

          // Empty means "approve as the account this browser is already signed
          // in as"; anything else names a provider to go and ask.
          //
          // A form on somebody else's site posting here is what would make
          // this dangerous, and is what SameSite=Lax on the session cookie
          // prevents: a cross-site POST arrives with no cookie, so it is
          // nobody, so it approves nothing.
          const chosen = form.get("with") ?? "";
          if (chosen === "") {
            const who = await accounts.whoIs(tokenFrom(request.headers));
            if (who === null) {
              html(response, 401, signInFailedPage("Sign in first, then approve the terminal."));
              return;
            }
            const token = await accounts.sessionFor(who);
            if (!token || !signIn.device.approve(grant.userCode, { token, email: who.email })) {
              html(response, 500, signInFailedPage("Could not start a session for that terminal."));
              return;
            }
            html(response, 200, deviceDonePage(who.email));
            return;
          }

          const provider = signIn.provider(chosen);
          if (provider === null) {
            html(response, 404, signInFailedPage("This nixamp cannot sign you in with that."));
            return;
          }
          // The user code rides along in the state, so the callback knows it
          // is approving a terminal rather than signing this browser in.
          response.writeHead(302, { location: signIn.begin(provider, grant.userCode) });
          response.end();
          return;
        }

        json(response, 404, { error: "no such endpoint" });
        return;
      }

      // --- the name other people see ---------------------------------------
      //
      // Separate from the address on purpose. The address is a credential and
      // a way to reach somebody; publishing it in a directory listing or an
      // invite would be publishing what they log in with.
      if (path === "/api/v1/me/handle" && options.handles) {
        const handles = options.handles;
        const who = await accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }

        if (request.method === "GET") {
          json(response, 200, { handle: await handles.of(who.id) });
          return;
        }
        if (request.method === "PUT" || request.method === "POST") {
          let body: { handle?: unknown };
          try {
            body = JSON.parse(await readBody(request)) as typeof body;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return;
          }
          const claimed = await handles.claim(who.id, body.handle);
          if (claimed.error) {
            json(response, 409, { error: claimed.error });
            return;
          }
          json(response, 200, { handle: claimed.handle });
          return;
        }
        json(response, 405, { error: "GET or PUT" });
        return;
      }

      // --- the servers this account runs ----------------------------------
      //
      // Kept against the account rather than the machine, so the list reads the
      // same from the CLI, the PWA and the desktop app -- which is the whole
      // point: a share link in a terminal you closed is a server you have lost.
      if ((path === "/api/v1/servers" || path.startsWith("/api/v1/servers/")) && options.servers) {
        const servers = options.servers;
        const who = await accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }

        if (path === "/api/v1/servers" && request.method === "GET") {
          json(response, 200, { servers: await servers.list(who.id) });
          return;
        }

        if (path === "/api/v1/servers" && request.method === "POST") {
          let body: { name?: unknown; url?: unknown; key?: unknown };
          try {
            body = JSON.parse(await readBody(request)) as typeof body;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return;
          }
          const made = await servers.add(who, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.url === "string" ? { url: body.url } : {}),
            ...(typeof body.key === "string" ? { key: body.key } : {}),
          });
          if (made === null) {
            json(response, 422, { error: "that needs an http or https address" });
            return;
          }
          json(response, 201, { server: made });
          return;
        }

        const id = path.slice("/api/v1/servers/".length);
        if (id && request.method === "DELETE") {
          const gone = await servers.remove(who.id, id);
          json(response, gone ? 200 : 404, gone ? { ok: true } : { error: "no such server" });
          return;
        }

        if (id && (request.method === "PATCH" || request.method === "PUT")) {
          let body: { name?: unknown; url?: unknown; key?: unknown };
          try {
            body = JSON.parse(await readBody(request)) as typeof body;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return;
          }
          const changed = await servers.update(who.id, id, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.url === "string" ? { url: body.url } : {}),
            ...(typeof body.key === "string" ? { key: body.key } : {}),
          });
          if (changed === null) {
            json(response, 404, { error: "no such server, or a bad address" });
            return;
          }
          json(response, 200, { server: changed });
          return;
        }

        json(response, 405, { error: "GET, POST, PATCH or DELETE" });
        return;
      }

      // --- tokens a person made on purpose --------------------------------
      if (path === "/api/v1/auth/tokens" || path.startsWith("/api/v1/auth/tokens/")) {
        const who = await accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }

        if (path === "/api/v1/auth/tokens" && request.method === "GET") {
          json(response, 200, { tokens: await accounts.listTokens(who.id, "cli") });
          return;
        }

        if (path === "/api/v1/auth/tokens" && request.method === "POST") {
          let body: { name?: unknown };
          try {
            body = JSON.parse(await readBody(request)) as typeof body;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return;
          }
          const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
          const made = await accounts.mintCliToken(who, name);
          if (made === null) {
            json(response, 501, { error: "this nixamp does not keep tokens" });
            return;
          }
          // The whole token is in this answer and in no other: it is not
          // stored, so there is nowhere to show it again from.
          json(response, 201, { token: made.token, id: made.id, name: made.name });
          return;
        }

        const id = path.slice("/api/v1/auth/tokens/".length);
        if (id && request.method === "DELETE") {
          const gone = await accounts.revokeToken(who.id, id);
          json(response, gone ? 200 : 404, gone ? { ok: true } : { error: "no such token" });
          return;
        }

        json(response, 405, { error: "GET, POST or DELETE" });
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

      // A password is the one secret here small enough to guess, so the
      // attempts are counted per caller and per address being tried: one
      // machine working through a word list and a thousand machines trying one
      // address are the same attack, and each is stopped by its own counter.
      const who = callerOf(request.headers, request.socket.remoteAddress, behindProxy);
      const target = typeof body.email === "string" ? body.email.toLowerCase().slice(0, 200) : "";
      const buckets = [`signin:${who}`, `signin:${target}`];
      for (const bucket of buckets) {
        const verdict = guard.check(bucket, SIGN_IN_LIMIT);
        if (!verdict.ok) {
          response.writeHead(429, {
            ...CORS,
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(verdict.retryAfter),
          });
          response.end(JSON.stringify({ error: "too many attempts; try again later" }));
          return;
        }
      }

      const result = signingUp
        ? await accounts.signUp(body.email, body.password)
        : await accounts.signIn(body.email, body.password);

      // A handle asked for at sign-up, or one nobody has to think about. Never
      // derived from the address: turning anthony@… into "anthony" is the leak
      // this whole idea exists to avoid, and it is one nobody would notice
      // until it was already in a directory listing.
      if (signingUp && result.ok && result.account && options.handles) {
        const asked = (body as { handle?: unknown }).handle;
        const claimed = await options.handles.claim(result.account.id, asked);
        if (claimed.error) {
          await options.handles.claim(result.account.id, anonymousHandle((size) => randomBytes(size)));
        }
      }

      // Getting it right costs nothing: the counters only exist to stop people
      // who keep getting it wrong.
      if (result.ok) for (const bucket of buckets) guard.forget(bucket);

      if (!result.ok) {
        // 409 for an address that is taken, 401 for credentials that are not.
        json(response, signingUp ? 409 : 401, { error: result.error });
        return;
      }

      // A password sign-in ends in the same revocable token an OAuth one does,
      // falling back to the module's JWT where there is no storage to keep one
      // in. Every way in should be a session that can be listed and ended.
      const token = result.account
        ? await accounts.sessionFor(result.account, result.token)
        : result.token;

      // The token goes back in the body for the CLI and the desktop app, and
      // as a cookie for the browser, which then needs to know nothing about it.
      response.writeHead(200, {
        ...CORS,
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookie(token, secure),
      });
      response.end(JSON.stringify({ account: result.account, token }));
      return;
    }

    // --- coming back from a provider ---------------------------------------
    //
    // /api/v1/<provider>/oauth/start sends a browser away, and .../callback is
    // what the provider was told to send it back to. Both are outside the
    // /api/v1/auth/ block because that is the URL shape registered with GitHub
    // and Google, and a redirect URI is not something to change lightly.
    const oauthRoute = OAUTH_ROUTE.exec(path);
    if (oauthRoute && options.accounts && options.signIn) {
      const accounts = options.accounts;
      const signIn = options.signIn;
      const secure = options.secureCookies ?? false;
      const provider = signIn.provider(oauthRoute[1]);
      if (provider === null) {
        json(response, 404, { error: "this nixamp cannot sign you in with that" });
        return;
      }

      if (oauthRoute[2] === "start") {
        // A terminal can link straight here with the code it is showing, which
        // is one hop shorter than the page for somebody who followed the link.
        const grant = signIn.device.find(url.searchParams.get("device") ?? "");
        response.writeHead(302, { location: signIn.begin(provider, grant?.userCode ?? "") });
        response.end();
        return;
      }

      // A callback carrying no state, or one whose state was already spent, is
      // not a sign-in: it is somebody replaying a URL they found.
      const pending = signIn.claim(url.searchParams.get("state"));
      if (pending === null || pending.provider !== provider.id) {
        html(response, 400, signInFailedPage("That sign-in link has expired. Start again."));
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      if (!code) {
        html(response, 400, signInFailedPage(url.searchParams.get("error") ?? "The provider sent no code."));
        return;
      }

      const access = await exchangeCode(provider, code, signIn.site).catch(() => "");
      const identity = access ? await provider.identify(access, fetch).catch(() => null) : null;
      if (identity === null) {
        html(response, 401, signInFailedPage(`${provider.name} did not confirm a verified email address.`));
        return;
      }

      const result = await accounts.signInWith(identity);
      if (!result.ok || result.account === null) {
        html(response, 401, signInFailedPage(result.error || "Could not sign in."));
        return;
      }

      if (pending.userCode) {
        // This round trip was approving a terminal. The browser is finished;
        // the session belongs to whatever is polling.
        if (!signIn.device.approve(pending.userCode, { token: result.token, email: result.account.email })) {
          html(response, 410, signInFailedPage("That terminal stopped waiting. Run `nixamp login` again."));
          return;
        }
        html(response, 200, deviceDonePage(result.account.email));
        return;
      }

      response.writeHead(302, {
        "set-cookie": sessionCookie(result.token, secure),
        location: "/",
      });
      response.end();
      return;
    }

    // The directory is public to read and answered before the key check,
    // because a visitor to nixamp.com has no key and is exactly who it is for.
    //
    // Announcing is not public any more. A listing now carries a phone number
    // people dial and minutes we pay for, so it has to be attributable to
    // somebody: broadcasters register, and a caller just dials. Reading stays
    // open to everyone -- the whole point is a directory a stranger can browse.
    if (path === "/api/directory" && options.directory) {
      if (request.method === "GET") {
        // Each stream carries its call-in code and how many people are on the
        // phone for it. The code is published on purpose: it is a public
        // call-in line, and a listing you cannot dial is a listing of nothing.
        const onThePhone = options.partyLine;
        const streams = options.directory.list().map((stream) => ({
          ...stream,
          callers: onThePhone ? onThePhone.listenersOn(stream.code) : 0,
        }));
        // Recently ended too, because following exists to hear about
        // broadcasts you would otherwise miss -- and a list of only what is on
        // can only be used to follow somebody during a broadcast you did not
        // miss. No url and no code: there is nothing to listen to.
        const recent = options.directory.recentlyEnded().map((stream) => ({
          name: stream.name,
          ownerId: stream.ownerId,
          nowPlaying: stream.nowPlaying,
          endedAt: stream.endedAt,
        }));
        json(response, 200, { streams, recent, callIn: CALL_IN_NUMBER, now: Date.now() });
        return;
      }
      if (request.method === "POST") {
        // Only where there are accounts to check against. An instance with no
        // Accounts is somebody's laptop, which has no registration to demand.
        let ownerId = "";
        if (options.accounts) {
          const who = await options.accounts.whoIs(tokenFrom(request.headers));
          if (who === null) {
            json(response, 401, {
              error: "sign in to list a stream: nixamp login, then nixamp serve --directory",
            });
            return;
          }
          // From the token, never the body. A stream that could name its own
          // owner could name somebody else's, and their followers would be
          // told about a broadcast that person is not making.
          ownerId = who.id;
        }

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
        const listing = options.directory.announce(announcement, ownerId);
        // A stream reappearing is the event somebody asked to be told about.
        // Answered first and texted after, because the publisher's heartbeat
        // should not wait on an SMS gateway.
        json(response, 200, listing);
        if (options.partyLine) {
          void options.partyLine
            .wentLive({ code: listing.code, name: listing.name, nowPlaying: listing.nowPlaying })
            .catch(() => {});
        }
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

    // Administering is a different question from listening, and it is asked
    // after the share key: the control key answers both, but a listen key or a
    // nixamp.com session answers only one of them.
    if (options.owner && needsAdmin(path, request.method ?? "GET")) {
      // A server started with --no-key has said that anyone who can reach the
      // port may drive it, and prints exactly that. Locking administration to
      // nobody would contradict it and leave such a server unadministrable.
      const holdsControl =
        key === null || scopeOf(keyFrom(request, url), key, null) === "control";
      const check = await options.owner.check(holdsControl, tokenFrom(request.headers));

      if (path === "/api/admin") {
        // Always answered, and honestly: the page has to know whether to draw
        // an admin panel at all, and "no" is a real answer rather than a 403.
        json(response, 200, { allowed: check.allowed, as: check.as, claimed: options.owner.claimed });
        return;
      }
      if (!check.allowed) {
        json(response, 403, {
          error: options.owner.claimed
            ? "sign in to nixamp.com as this server's owner, or use its control link"
            : "this server has no owner signed in; use its control link",
        });
        return;
      }
    }

    // After the key check: a paying listener still needs the link, and a 402
    // is a worse answer than a 401 to someone who has neither.
    if (options.paywall && (await options.paywall(request, response, path))) return;

    // --- several streams at once ------------------------------------------
    //
    // A channel is one publisher and everybody listening to them. Two or three
    // devices can publish at once, each to their own channel, and a listener
    // picks which to hear.
    if (path === "/api/channels" && options.channels) {
      json(response, 200, { channels: options.channels.list(), listeners: options.channels.listeners });
      return;
    }

    // Publishing. Anyone with the control link may; listening to the result is
    // open to whoever has the share link, like the rest of the audio.
    if (path.startsWith("/api/channels/") && options.channels) {
      const channels = options.channels;
      const rest = path.slice("/api/channels/".length);
      const [rawId, action] = rest.split("/");
      const id = cleanId(rawId);

      if (action === undefined && request.method === "GET") {
        // Listening. The response is the fan-out target: whatever ffmpeg
        // produces for this channel is written to it until one end goes away.
        const detach = channels.listen(id, response);
        if (detach === null) {
          json(response, 404, { error: "nothing is playing on that channel" });
          return;
        }
        watch(request, response, "stream", id);
        response.writeHead(200, {
          ...CORS,
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
        });
        const leave = (): void => detach();
        request.on("close", leave);
        response.on("close", leave);
        return;
      }

      if (action === undefined && request.method === "DELETE") {
        // Asked once: the second call would answer false, having just stopped
        // the thing it was asking about.
        const stopped = channels.stop(id);
        json(response, stopped ? 200 : 404, { ok: stopped });
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
      const name = url.searchParams.get("name") ?? "";

      // A chunked publisher sends many requests to one channel, so the first
      // claims it and the rest feed what is already there.
      if (action === "chunk") {
        if (!channels.has(id) && channels.publish(id, name, format, "http") === null) {
          json(response, 409, { error: "that channel is already being published to" });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        channels.writeTo(id, Buffer.concat(chunks));
        json(response, 200, { ok: true });
        return;
      }

      const claimed = channels.publish(id, name, format, "http");
      if (claimed === null) {
        json(response, 409, { error: "that channel is already being published to" });
        return;
      }
      try {
        await claimed.pump(request);
      } catch {
        // A publisher that hung up is not an error worth a 500.
      }
      claimed.close();
      json(response, 200, { ok: true, bytes: claimed.info.bytes });
      return;
    }

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
        // Names now, tags later, here as much as at startup: re-streaming a
        // directory of five thousand files used to read every tag before it
        // answered, with the event loop held the whole time.
        if (options.tag) {
          void options
            .tag(source)
            .then((tagged) => engine.retag(tagged, source))
            .catch(() => {});
        }
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
      watch(request, response, "media", engine.snapshot().tracks?.[index]?.title ?? file);
      // A browser asks for every track here, and a matroska or an avi handed
      // to it raw is bytes it cannot play. Seeking is what this route is for
      // and transcoding gives it up, but an unseekable film beats a silent
      // one -- and the seekable formats are untouched.
      // A ceiling the caller asked for, because only the caller knows what its
      // link can carry. Capped at both ends: nothing below 200k is watchable,
      // and above 20 megabits the original was always the better answer.
      const asked = Number(url.searchParams.get("kbps") ?? "");
      const capKbps = Number.isFinite(asked) && asked > 0 ? Math.min(20_000, Math.max(200, asked)) : 0;

      if (playsInBrowser(file) && capKbps === 0) {
        sendFile(request, response, file);
      } else if (hasPicture(file)) {
        // A film. It used to arrive as MP3 with `-vn`, which is to say as a
        // soundtrack over a blank panel; what ffprobe finds inside decides how
        // little work it takes to keep the picture.
        const codecs = await codecsOf({ ffmpeg: [], ffprobe: options.ffprobe ?? ["ffprobe"], play: null }, file);
        pipeFfmpeg(request, response, file, options.ffmpeg ?? ["ffmpeg"], videoArgs(codecs, capKbps), "video/mp4");
      } else {
        transcode(request, response, file, options.ffmpeg ?? ["ffmpeg"]);
      }
      return;
    }

    // Whatever the source is, this comes back as MP3 a browser will play:
    // a flac, a wma, a URL, an HLS stream. ffmpeg reads them all and we hand
    // the bytes on as they arrive, so a live stream starts immediately rather
    // than after it ends, which for a live stream is never.
    // One address that keeps playing, for a listener that cannot ask for the
    // next track: the phone line hands exactly this to Telnyx.
    if (path === "/api/live") {
      if (!options.media) {
        json(response, 403, { error: "media streaming is off" });
        return;
      }
      const current = engine.snapshot();
      if (current.trackCount === 0) {
        json(response, 404, { error: "nothing is playing" });
        return;
      }
      watch(request, response, "stream", current.tracks?.[current.index]?.title ?? "live");
      liveAudio(request, response, engine, options.ffmpeg ?? ["ffmpeg"]);
      return;
    }

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
      watch(request, response, "stream", engine.snapshot().tracks?.[index]?.title ?? source);
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

/** How long to wait before looking again when the player has not moved on. */
const LIVE_GAP_MS = 500;
/** How long to wait when there is nothing to play at all yet. */
const LIVE_IDLE_MS = 2000;

/**
 * Whatever is playing, as one endless MP3.
 *
 * /api/stream/N is one track: it needs an index, and it stops at the end of
 * the song. That is right for a browser, which knows what is playing and can
 * ask for the next one. It is wrong for everything that cannot -- a telephone
 * call, `curl | mpv`, anything handed a single address and expected to keep
 * hearing sound. Those need one URL that never ends and never needs asking
 * again, which is what a listener means by "the stream".
 *
 * So this follows the player rather than an index: transcode what is playing,
 * and when that track ends look at what is playing now and keep writing into
 * the same response. The listener sees one continuous audio/mpeg body.
 *
 * Read at native rate (-re), unlike /api/stream/N which is free to run ahead
 * into a browser's buffer. Here running ahead would finish the song in two
 * seconds and then sit waiting for the player to catch up, so the thing that
 * decides what plays next would be minutes behind what the listener hears.
 */
function liveAudio(
  request: IncomingMessage,
  response: ServerResponse,
  engine: Engine,
  ffmpeg: string[],
): void {
  const [command, ...prefix] = ffmpeg as [string, ...string[]];
  let child: ReturnType<typeof spawn> | null = null;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let started = false;
  let playing = -1;

  // Held back until the first byte, for the reason transcode() holds it back:
  // a 200 with nothing behind it is indistinguishable from silence.
  const begin = (): void => {
    if (started || closed) return;
    started = true;
    response.writeHead(200, {
      ...CORS,
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "transfer-encoding": "chunked",
    });
  };

  const later = (ms: number, run: () => void): void => {
    if (waiting) clearTimeout(waiting);
    waiting = setTimeout(run, ms);
    waiting.unref?.();
  };

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (waiting) clearTimeout(waiting);
    waiting = null;
    unsubscribe();
    child?.kill("SIGKILL");
    child = null;
    if (!response.writableEnded) response.end();
  };

  const next = (): void => {
    if (closed || child !== null) return;
    if (waiting) {
      clearTimeout(waiting);
      waiting = null;
    }
    const snapshot = engine.snapshot();
    const source = engine.trackPath(snapshot.index);
    if (source === undefined) {
      // A playlist that was replaced out from under us, or one that is empty
      // for the moment. Keep the connection and keep looking.
      later(LIVE_IDLE_MS, next);
      return;
    }

    playing = snapshot.index;
    const spawned = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel", "error",
        ...(isRemote(source) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []),
        "-re",
        "-i", source,
        "-vn",
        "-f", "mp3",
        "-b:a", "192k",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = spawned;

    spawned.stdout.once("data", begin);
    spawned.stdout.on("error", () => spawned.kill("SIGKILL"));
    // end: false, because the response outlives this track. Ending it here is
    // exactly the bug this endpoint exists to avoid.
    spawned.stdout.pipe(response, { end: false });
    spawned.stderr.resume();

    spawned.on("error", stop);
    spawned.on("close", () => {
      if (child !== spawned) return;
      child = null;
      if (closed) return;
      // Follow the player if it has already moved on. If it has not, look
      // again shortly -- which is also what makes a single-track library
      // repeat rather than fall silent.
      later(engine.snapshot().index === playing ? LIVE_GAP_MS : 0, next);
    });
  };

  // A track change that lands while we are between songs is the signal to go
  // now rather than wait out the poll.
  const unsubscribe = engine.subscribe(() => {
    if (child === null && !closed && engine.snapshot().index !== playing) next();
  });

  response.on("close", stop);
  response.on("error", stop);
  request.on("close", stop);
  next();
}

/**
 * Decode anything and hand back MP3, as it is produced.
 *
 * No seeking: this is a pipe, and the length is not known until it ends. The
 * player falls back to /api/media for a local file it can seek, and uses this
 * for everything else.
 */
/** Audio, from whatever this is: the shape every non-browser source took. */
function transcode(
  request: IncomingMessage,
  response: ServerResponse,
  source: string,
  ffmpeg: string[],
): void {
  pipeFfmpeg(request, response, source, ffmpeg, ["-vn", "-f", "mp3", "-b:a", "192k"], "audio/mpeg");
}

/**
 * Run ffmpeg and hand its output straight to the caller.
 *
 * The output arguments belong to the caller, because the same plumbing carries
 * a film and a song and the only difference is what ffmpeg is asked to write --
 * which for a film is decided by what ffprobe found inside it.
 */
function pipeFfmpeg(
  request: IncomingMessage,
  response: ServerResponse,
  source: string,
  ffmpeg: string[],
  outputArgs: string[],
  contentType: string,
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
      ...outputArgs,
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
      "content-type": contentType,
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
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "server error" });
      else response.end();
    });
  };

  // https when there is a certificate to serve it with, and the same handler
  // either way: nothing above this line knows or cares which it got.
  if (options.tls) {
    return createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, onRequest) as unknown as Server;
  }
  return createHttpServer(onRequest);
}


export async function serve(argv: string[], version = "0.1.0"): Promise<void> {
  const options = parseServeArgs(argv);
  const root = isRemote(options.root) ? options.root : resolve(options.root);
  const tools = detectTools();
  // Names now, tags later.
  //
  // Reading tags is an ffprobe per file, which over a real library is minutes,
  // and every one of them used to happen before this process printed a word or
  // listened on a port. `nixamp serve ~/music` looked hung, and `nixamp daemon
  // start` was worse: it waits fifteen seconds for the announce line, killed a
  // daemon that was working perfectly, and reported a failure whose log was
  // empty because nothing had been written to it yet.
  //
  // So the filenames are enough to start: the server is up and answering in the
  // time it takes to walk the directory, and the titles fill in behind it.
  const tracks = await loadSource(tools, root, false);
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

  const channels = new Channels({
    ffmpeg: tools.ffmpeg,
    onStart: (info) =>
      console.log(`  ${info.name} is publishing to "${info.id}" (${info.format} over ${info.via}).`),
    onEnd: (info) => console.log(`  "${info.id}" stopped.`),
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

  // The account signed in on this machine owns the server it starts. That is
  // the whole claim: `nixamp login` then `nixamp serve`, and the phone in your
  // pocket can administer it from anywhere by signing in as the same person.
  // Following outlives every stream, so unlike the rest of this it wants a
  // database. Only where there is one: a nixamp on a laptop has no followers.
  const pool =
    options.directory && process.env["DATABASE_URL"]
      ? new pg.Pool({ connectionString: process.env["DATABASE_URL"] })
      : undefined;
  const follows = pool ? new Follows(pool) : undefined;
  // The two things that were promises kept only in memory: a caller who was
  // told they would be texted, and the ended stream a code still points at.
  const durable = pool ? new Durable(pool, (message) => console.log(message)) : undefined;

  const vapidPublicKey = process.env["VAPID_PUBLIC_KEY"] ?? "";
  const vapidPrivateKey = process.env["VAPID_PRIVATE_KEY"] ?? "";

  /**
   * Tell a broadcaster's followers, on whatever they asked to be told on.
   *
   * Fired from the directory on the transition to live rather than on every
   * heartbeat, and awaited by nobody: a publisher's heartbeat should not sit
   * waiting on a push service.
   */
  const tellFollowers = (listing: Listing): void => {
    if (follows === undefined || !listing.ownerId) return;
    const what = listing.nowPlaying ? ` Playing ${listing.nowPlaying}.` : "";
    const note: Notification = {
      title: `${listing.name} is live`,
      body: `${what} Listen at ${DEFAULT_DIRECTORY}/directory, or call ${CALL_IN_NUMBER} and key ${listing.code}.`.trim(),
      url: listing.url,
    };
    void follows
      .audience(listing.ownerId)
      .then((audience) =>
        notifyAll(audience, note, {
          ...(process.env["RESEND_API_KEY"]
            ? {
                email: resendEmail({
                  apiKey: process.env["RESEND_API_KEY"],
                  from: process.env["NIXAMP_MAIL_FROM"] ?? "nixamp <notifications@nixamp.com>",
                  onEvent: (message) => console.log(message),
                }),
              }
            : {}),
          ...(process.env["TELNYX_API_KEY"] && process.env["PARTYLINE_SMS_FROM"]
            ? {
                sms: telnyxSms({
                  apiKey: process.env["TELNYX_API_KEY"],
                  from: process.env["PARTYLINE_SMS_FROM"],
                  onEvent: (message) => console.log(message),
                }),
              }
            : {}),
          ...(vapidPublicKey && vapidPrivateKey
            ? {
                push: webPush({
                  publicKey: vapidPublicKey,
                  privateKey: vapidPrivateKey,
                  subject: process.env["NIXAMP_SITE"] ?? DEFAULT_DIRECTORY,
                  onEvent: (message) => console.log(message),
                }),
              }
            : {}),
          // A subscription the vendor has retired is a row to delete, not a
          // failure to retry.
          onGone: (endpoint) => follows.removePush(endpoint),
          onEvent: (message) => console.log(message),
        }),
      )
      .catch(() => {});
  };

  // Hoisted rather than built inline, because the party line needs the same
  // instance: a second Directory would be a second set of stream codes, and
  // the one the phone looked in would never be the one the publishers reach.
  const directory = options.directory
    ? new Directory(undefined, undefined, undefined, tellFollowers)
    : undefined;

  if (directory && durable) {
    // Echoed rather than awaited: the directory answers from memory, so a
    // database that is briefly unreachable should cost the durability and not
    // the request.
    directory.persistTo({
      save: (item) => void durable.saveEnded(item),
      drop: (id) => void durable.dropEnded(id),
    });
    // And put back what the last process knew, without holding up the listen.
    void durable
      .loadEnded(Date.now() - ENDED_TTL_MS)
      .then((items) => {
        if (items.length > 0) console.log(`  remembered ${items.length} stream(s) that had ended.`);
        directory.seedEnded(items);
      })
      .catch(() => {});
    void durable.sweep(Date.now() - ENDED_TTL_MS, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  }

  const session = readSession();
  const owner = new Owner({
    ownerId: options.owner || (session?.token ? await ownerIdOf(session) : ""),
    site: session?.site ?? DEFAULT_DIRECTORY,
  });

  // The party line answers a phone number, and there is only one number. Both
  // keys or neither: without the public key every webhook would be refused,
  // which is a worse failure than not offering the endpoint.
  const partyLine =
    options.directory && process.env["TELNYX_API_KEY"] && process.env["TELNYX_PUBLIC_KEY"]
      ? new PartyLine({
          apiKey: process.env["TELNYX_API_KEY"],
          publicKey: process.env["TELNYX_PUBLIC_KEY"],
          streams: directory,
          callIn: CALL_IN_NUMBER,
          // Only when a sending number is configured. Without one the line
          // still answers and still says when the stream ended; it just does
          // not offer a text it could not send.
          ...(process.env["PARTYLINE_SMS_FROM"]
            ? {
                sms: telnyxSms({
                  apiKey: process.env["TELNYX_API_KEY"],
                  from: process.env["PARTYLINE_SMS_FROM"],
                  onEvent: (message) => console.log(message),
                }),
              }
            : {}),
          ...(process.env["PARTYLINE_GREETING"] ? { greeting: process.env["PARTYLINE_GREETING"] } : {}),
          ...(process.env["PARTYLINE_VOICE"] ? { voice: process.env["PARTYLINE_VOICE"] } : {}),
          onEvent: (message) => console.log(message),
        })
      : undefined;

  if (partyLine && durable) {
    // Put back everybody a previous process promised to text, then keep
    // echoing. Seeding first means a stream that goes live during startup
    // still finds them.
    void durable
      .loadReminders()
      .then((waiting) => {
        const owed = [...waiting.values()].reduce((n, set) => n + set.size, 0);
        if (owed > 0) console.log(`  ${owed} caller(s) are still owed a text.`);
        partyLine.persistRemindersTo(
          {
            add: (code, phone) => void durable.addReminder(code, phone),
            take: (code) => durable.takeReminders(code),
          },
          waiting,
        );
      })
      .catch(() => {
        // Still worth echoing new ones even if the old list could not be read.
        partyLine.persistRemindersTo({
          add: (code, phone) => void durable.addReminder(code, phone),
          take: (code) => durable.takeReminders(code),
        });
      });
  }

  // Read before listening, so a missing or unreadable certificate is a sentence
  // now rather than a connection that resets later.
  const tls = options.tlsCert
    ? (() => {
        try {
          return { cert: readFileSync(options.tlsCert, "utf8"), key: readFileSync(options.tlsKey, "utf8") };
        } catch (error) {
          throw new Error(`nixamp serve: could not read the certificate: ${(error as Error).message}`);
        }
      })()
    : undefined;

  const server = createServer(engine, {
    web,
    media: options.media,
    owner,
    channels,
    ...(ingest ? { ingest } : {}),
    broadcaster,
    broadcast: () => ({ destinations, settings: DEFAULT_ENCODER }),
    version,
    key,
    listenKey,
    connections,
    paywall,
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    ...(tls ? { tls } : {}),
    // Untagged, so a directory of five thousand files answers at once; the
    // tags follow through `tag` below.
    load: (next) => loadSource(tools, next, false),
    tag: (next) => loadTagged(tools, next),
    ...(directory ? { directory } : {}),
    ...(follows ? { follows, vapidPublicKey } : {}),
    ...(partyLine ? { partyLine } : {}),
    // Accounts live where the directory lives, and only there: a nixamp on a
    // laptop has nobody to be an account of.
    ...(options.directory && process.env["DATABASE_URL"]
      ? {
          accounts: new Accounts({
            connectionString: process.env["DATABASE_URL"],
            secret: process.env["NIXAMP_JWT_SECRET"] ?? "",
          }),
          secureCookies: (process.env["NIXAMP_SITE"] ?? "").startsWith("https://"),
          // A deployment reached over https is one behind somebody's proxy, so
          // the socket address is that proxy and the forwarded header is the
          // caller. A nixamp on a laptop is reached directly and must not
          // believe a header anybody can send.
          behindProxy: (process.env["NIXAMP_SITE"] ?? "").startsWith("https://"),
          // Whichever providers this deployment was given both halves of, plus
          // the device grant, which is worth having even with no provider at
          // all: a browser already signed in can approve a terminal.
          // The same pool the follows and reminders use: three small tables in
          // one database do not want three sets of connections.
          ...(pool ? { servers: new Servers(pool), handles: new Handles(pool) } : {}),
          signIn: new SignIn(
            providersFrom(process.env),
            new DeviceGrants(),
            process.env["NIXAMP_SITE"] ?? DEFAULT_DIRECTORY,
          ),
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

  // The link, not the address. Without the key the address is a 401, so
  // printing a bare host:port would be printing something that does not work.
  //
  // Behind NAT no interface holds the public address, so if nobody said what it
  // is and nothing local looks public, ask. What comes back is a fact about the
  // router and not about this port -- the port still has to be forwarded -- so
  // it is marked as a guess and everything that prints it says so.
  const localAddresses = reachableAddresses(options.host, port, options.publicUrl, tls ? "https" : "http");
  const guessedPublic =
    options.lookup && !options.publicUrl && !localAddresses.some((a) => a.label === "on the internet")
      ? await lookupPublicIp()
      : "";
  const addresses = guessedPublic
    ? reachableAddresses(
        options.host,
        port,
        `${tls ? "https" : "http"}://${guessedPublic.includes(":") ? `[${guessedPublic}]` : guessedPublic}:${port}`,
        tls ? "https" : "http",
      )
    : localAddresses;

  // Listening on every interface proves the socket is open here and nothing
  // about the path between here and the phone.
  const listening = options.host === "0.0.0.0" || options.host === "::";
  const firewall = listening ? firewallInUse(io) : null;

  if (options.announce) {
    // Everything `nixamp daemon start` needs to print what this would have
    // printed. Without the addresses it could only reconstruct host and port,
    // which for a server bound to every interface means it printed 127.0.0.1 --
    // an address that works on exactly the machine you are already sitting at.
    // The firewall matters for the same reason: the warning was going into a
    // log file nobody reads instead of to the person who just typed the
    // command.
    console.log(
      JSON.stringify({
        nixamp: "listening",
        host: options.host,
        port,
        key,
        source: root,
        urls: addresses,
        firewall,
        guessedPublic: guessedPublic !== "",
      }),
    );
  }

  // The other half of "names now, tags later". It runs while the banner is
  // printed and while the publish prompt waits, and it is deliberately not
  // awaited: nothing downstream needs it, and a library that takes a minute to
  // read should cost nobody a minute of silence.
  if (tracks.length > 0 && !isRemote(root)) {
    void loadTagged(tools, root)
      .then((tagged) => engine.retag(tagged, root))
      .catch(() => {
        // Filenames are a working player. A failure here is worth nothing but
        // titles that stay as they are.
      });
  }

  console.log(`nixamp serve — ${tracks.length} tracks under ${root}`);
  console.log("");

  const width = Math.max(...addresses.map((a) => a.label.length));
  for (const { label, url } of addresses) {
    console.log(`  ${label.padEnd(width)}  ${shareLink(url, key)}`);
  }

  if (guessedPublic) {
    console.log("");
    console.log(`  That internet address is this machine's router, not this port.`);
    console.log(`  Nothing outside reaches it until ${port} is forwarded here.`);
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
  if (owner.claimed) {
    console.log(`  ${session?.email} can administer this from anywhere, signed in at ${session?.site}.`);
  }
  if (options.ingest) console.log("  Accepting a live stream in at POST /api/ingest.");
  let rtmp: RtmpListeners | null = null;
  if (options.rtmpIn > 0) {
    const publish = addresses.find((a) => a.label !== "here") ?? addresses[0];
    const host = publish ? new URL(publish.url).hostname : "127.0.0.1";
    // One listener per stream, because ffmpeg's RTMP listener serves a single
    // connection per process. Three devices going live at once is three ports.
    const slots = Array.from({ length: options.rtmpStreams }, (_, i) => ({
      port: options.rtmpIn + i,
      id: i === 0 ? "live" : `live-${i + 1}`,
    }));
    rtmp = new RtmpListeners(channels, tools.ffmpeg, listenKey ?? "live");
    rtmp.listen(slots);

    console.log("  Or publish from OBS, Larix or ffmpeg, one per URL:");
    for (const slot of slots) {
      console.log(`    rtmp://${host}:${slot.port}/live/${listenKey ?? "live"}   -> "${slot.id}"`);
    }
  }
  if (destinations.length > 0) {
    console.log(`  Ready to broadcast to ${destinations.map((d) => d.name).join(", ")}.`);
  }
  if (web === null) console.log("  No built PWA found, so / has nothing to serve: run `bun run web:build`.");

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
    // Announced next to the listen link, not instead of it: one is for a person
    // with a browser, the other for the phone line and anything else that is
    // handed one address and expected to play it.
    const audio = audioLink(publishable_.url, listenKey);
    const wanted = options.publish === "yes"
      ? true
      : await confirm(`\n  List this stream at ${DEFAULT_DIRECTORY}/directory so anyone can find it?\n  It publishes ${listen} — listen only, not the controls.`);

    if (wanted) {
      publisher = new Publisher({
        directory: DEFAULT_DIRECTORY,
        name: options.name || hostname(),
        url: listen,
        audio,
        tracks: tracks.length,
        // From `nixamp login`. The directory will not list a stream it cannot
        // attribute to somebody, because a listing is now a phone code that
        // costs money to answer.
        ...(session?.token ? { token: session.token } : {}),
        onRefused: () => {
          console.log("");
          console.log("  nixamp.com would not list this stream: it needs an account.");
          console.log("  Run `nixamp login` (or `nixamp signup`) and start again.");
        },
        nowPlaying: () => {
          const snapshot = engine.snapshot();
          return snapshot.tracks?.[snapshot.index]?.title ?? "";
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
    rtmp?.stop();
    channels.stopAll();
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

/**
 * Which account the signed-in session belongs to. Asked once at startup rather
 * than trusted from the file: a token that nixamp.com no longer accepts should
 * not confer ownership of anything.
 */
async function ownerIdOf(session: { site: string; token: string }): Promise<string> {
  try {
    const answer = await fetch(`${session.site}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!answer.ok) return "";
    const body = (await answer.json()) as { account?: { id?: string } };
    return typeof body.account?.id === "string" ? body.account.id : "";
  } catch {
    // Offline at startup means no remote administration until a restart, and
    // the control key still works. Better than claiming an owner we cannot
    // check.
    return "";
  }
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

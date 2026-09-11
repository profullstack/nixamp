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
import {
  Channels, cleanId, generatedId, rememberChannels, rememberedChannels, rememberedNow,
  type Channel, type RememberedChannel,
} from "./channels.ts";
import { RtmpListeners } from "./rtmp-in.ts";
import { Accounts, clearedCookie, sessionCookie, tokenFrom } from "./accounts.ts";
import { anonymousHandle, Handles } from "./handles.ts";
import { OpenDirs } from "./opendirs.ts";
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
import { needsAdmin, needsMember, Owner } from "./owner.ts";
import { createHash as sha } from "node:crypto";
import { playJingle } from "./jingle.ts";
import { stateDir } from "./daemon.ts";
import { readSession } from "./session.ts";
import { Directory, ENDED_TTL_MS, parseAnnouncement, type Listing } from "./directory.ts";
import { PartyLine, telnyxSms } from "./partyline.ts";
import { HlsPackagers, segmentType, withKey } from "./hls.ts";
import { DEFAULT_SITE as NICHEDB, Enricher, type EnrichKind, FIXTURE_TTL_MS } from "./enrich.ts";
import {
  contentTypeFor, downloadArgs, fileNameFor, inputArgsFor, linkChannelId, mergeDownloadArgs, playableLink, resolveLink,
  saveFormat,
  type ResolvedLink,
} from "./links.ts";
import { CALL_IN_NUMBER, OPT_IN_PATH, optInPage } from "./optin.ts";
import pg from "pg";
import { Follows, phoneFrom } from "./follows.ts";
import { Favorites, favoriteUrl } from "./favorites.ts";
import { Catalogs, shownCatalog, shownEntry } from "./catalogs.ts";
import { Porkbun, isIPv4, isIPv6, type DnsZone } from "./dns.ts";
import { NameError, Names } from "./names.ts";
import { AcmeIssuer, Certs } from "./certs.ts";
import { claimName, fetchCert, labelFor, readCertFiles, writeCertFiles } from "./naming.ts";
import { forbiddenLibrary, readLibrary } from "./library.ts";
import { createThrottle, presentedCredential, type Throttle } from "@profullstack/throttle";
import { Durable } from "./durable.ts";
import { notifyAll, resendEmail, webPush, type Notification } from "./notify.ts";
import { inviteSubject, inviteText, isEmail, isPhone, watchLink } from "./invite.ts";
import { handleLiveApi } from "./live-api.ts";
import { LiveEvents, type LiveEvent } from "./live-events.ts";
import { Layouts } from "./layouts.ts";
import { Rooms } from "./rooms.ts";
import { confirm, DEFAULT_DIRECTORY, Publisher } from "./publish.ts";
import {
  applyRemoteConfig,
  createPaywall,
  FREE_LISTENERS,
  type PaywallConfig,
  paywallFromEnv,
} from "./paywall.ts";
import { isRemote, isTransportStream, playsInBrowser, sourceLabel } from "./sources.ts";
import { codecsOf, probeAsync, transportInputArgs, videoArgs, type Codecs } from "./audio.ts";
import {
  allowedForListening,
  elevate,
  firewallInUse,
  certifiable,
  keyCookie,
  keyInPath,
  rememberedKeys,
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
import { loadSource, loadTagged, readRemoteIndex } from "./playlist.ts";
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
  /** Mint a new share key rather than reusing the one this port had. */
  newKey: boolean;
  /** Start without the noise it makes when it wakes up. */
  noJingle: boolean;
  /** Do not ask nixamp.com for a name and a certificate, even when signed in. */
  noName: boolean;
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
    // Empty, not ".": nothing about a server should depend on where it was
    // started from. The saved library fills it in, or the start refuses.
    root: "",
    port: Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535 ? fromEnv : DEFAULT_PORT,
    // Every interface, because a player nobody else can reach is not much of a
    // remote. The key in the link is what makes that safe; --no-key gives up
    // both at once, and --host pins it back to one address.
    host: "0.0.0.0",
    web: null,
    media: true,
    key: true,
    newKey: false,
    noJingle: false,
    noName: false,
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
    } else if (arg === "--new-key") {
      options.newKey = true;
    } else if (arg === "--no-jingle") {
      options.noJingle = true;
    } else if (arg === "--no-name") {
      options.noName = true;
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

/**
 * A track and the source it arrived with.
 *
 * The library a server was started on has no group: it is simply what this
 * machine has. Anything added afterwards carries the name of the folder or
 * album it came from, which is what lets a client draw the two apart instead
 * of running them together.
 */
export type Loaded = Track & {
  group?: string;
  /** The folder it sits in, relative to what it was loaded from. */
  folder?: string;
  /**
   * Whether this has a picture, when the name could not say.
   *
   * A file on disk is named `film.mkv` and that is answer enough. A live
   * stream is `http://host/tipoffsport/KEY/301`, which says nothing at all --
   * so it was treated as audio, transcoded with `-vn`, and arrived as a
   * football match somebody could only listen to. Asked of ffprobe once, when
   * the source is added, rather than guessed from a URL that has no opinion.
   */
  picture?: boolean;
  /**
   * Whether a person named this, rather than a tagger.
   *
   * Tags are read in the background and merged in when they arrive, which is
   * right for a library and wrong for a channel: somebody called it "MLB
   * Network", ffprobe came back a moment later with "932", and the name they
   * chose vanished on its own.
   */
  named?: boolean;
};

/** What the HTTP layer needs from a player. Tests hand it a fake. */
export interface Engine {
  /** `withTracks` false leaves the library out, for a frame that is only motion. */
  snapshot(withTracks?: boolean): Snapshot;
  command(command: Command): void;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  /** Absolute path of a track, or undefined when the index is not one. */
  trackPath(index: number): string | undefined;
  /**
   * Play something else instead of everything here.
   *
   * The big hammer, and no longer what adding a folder does: this is "point
   * this server somewhere else", which throws the library away on purpose.
   */
  replace(tracks: Track[], root: string): void;
  /** The library, arriving after the server was already listening. */
  fill(tracks: Track[], root: string): void;
  /**
   * This track turned out to have a picture after all.
   *
   * Whether a track is a film is worked out when it is added, and for an
   * address with no extension that means asking ffprobe. A track added before
   * that was asked -- or by an older nixamp -- keeps the wrong answer forever,
   * and every remote goes on putting a television channel into an audio
   * element. Streaming it is the moment the truth is known for certain.
   */
  sawPicture(index: number): void;
  /**
   * Play something as well as everything here.
   *
   * What somebody means by putting a folder in a box: the album shows up at
   * the bottom of the playlist under its own name, and the music that was
   * already there is still there. Answers how many tracks were new.
   *
   * `called` is what a person named it, which beats whatever the address ends
   * in -- a channel is "MLB Network", not "932".
   */
  add(tracks: Track[], from: string, called?: string): number;
  /**
   * Take an added source back out again, by the name `add` gave it.
   *
   * Nothing that came with the library can be dropped this way; the library is
   * what the server is, and there is a command line for changing that.
   */
  drop(group: string): number;
  /** Every added source, in the order they were added. */
  groups(): string[];
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

export function toRemoteTracks(tracks: Loaded[]): RemoteTrack[] {
  return tracks.map((t) => ({
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    // Said out loud, because a remote cannot see the path and had been sending
    // every track to the audio element -- a film's soundtrack over a blank
    // panel, which is exactly what it looked like.
    // The name when it says something, what ffprobe found when it does not.
    ...(t.picture ?? hasPicture(t.path) ? { video: true } : {}),
    // Only for what was added; the library's own tracks say nothing, which is
    // how a client knows they are the library.
    ...(t.group ? { group: t.group } : {}),
    ...(t.folder ? { folder: t.folder } : {}),
    // Said plainly rather than guessed at from how it was loaded: this is
    // what puts a channel in the live list and a film in the library.
    ...(isRemote(t.path) ? { remote: true } : {}),
  }));
}

/** Video containers, as opposed to the songs that are most of a library. */
const PICTURE = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".mpg", ".mpeg", ".wmv", ".flv",
  // Raw transport streams: a recording off a card, a receiver or an IPTV
  // dump, which is 1080p or 4K television and was arriving as its own
  // soundtrack because none of these names were on this list.
  ".m2ts", ".mts", ".m2t", ".trp", ".tp",
]);

export function hasPicture(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot > 0 && PICTURE.has(path.slice(dot).toLowerCase())) return true;
  // A `.ts` is a transport stream or a TypeScript file, and only its first
  // bytes know which. Asked of the file rather than of the name, and the
  // answer is remembered, because this is asked once per track per listing.
  return isTransportStream(path);
}

/**
 * Where a track sits, relative to the thing it was loaded from.
 *
 * A library is a shelf of albums and seasons, and a flat list of five thousand
 * files is one nobody can find anything in. This is what lets a player offer
 * the folders as folders.
 *
 * Relative and never absolute: the shape of somebody's library is what a
 * listener needs, and where it lives on their disk is not.
 */
export function folderOf(path: string, from: string): string {
  const strip = (value: string): string => value.replace(/\/+$/, "");
  const base = strip(from);
  if (base === "" || !path.startsWith(base + "/")) return "";
  const rest = path.slice(base.length + 1);
  const at = rest.lastIndexOf("/");
  if (at === -1) return "";
  const folder = rest.slice(0, at);
  // A URL's path is percent-encoded and a person reading a folder name is not.
  try {
    return isRemote(path) ? decodeURIComponent(folder) : folder;
  } catch {
    return folder;
  }
}

/**
 * Whether the name of a source tells us anything about what is inside it.
 *
 * A remote address with no extension -- an IPTV channel, a stream key, a
 * redirect -- is the case where it does not, and the only way to find out is
 * to look.
 */
export function nameSaysNothing(path: string): boolean {
  if (!isRemote(path)) return false;
  try {
    const last = new URL(path).pathname.split("/").pop() ?? "";
    return !last.includes(".");
  } catch {
    return false;
  }
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
    private tracks: Loaded[],
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
    this.tracks = tracks.map((track) => ({ ...track, folder: folderOf(track.path, root) }));
    this.root = root;
    this.state.index = 0;
    this.state.position = 0;
    this.state.note = "";
    this.push(true);
  }

  /**
   * Load something as well as what is already here.
   *
   * Adding a folder used to be `replace`, so pointing a server at an album on
   * the web threw away the music on its disk: the playlist you were looking at
   * turned into somebody else's twenty-eight tracks, and clicking your own
   * files played theirs. Nothing about playback changes here -- whatever was
   * playing keeps playing, at the same index, because the new tracks go on the
   * end.
   *
   * Paths already loaded are skipped, so adding the same album twice is not
   * two copies of it.
   */
  add(tracks: Track[], from: string, called = ""): number {
    // What somebody called it beats what the address happens to end in. A
    // channel at .../932 is "932" to a URL and "MLB Network" to a person, and
    // no transport stream reliably says which -- the one in front of us calls
    // itself "Service01".
    const group = called || sourceLabel(from);
    const known = new Set(this.tracks.map((track) => track.path));
    const fresh = tracks
      .filter((track) => !known.has(track.path))
      .map((track) => ({ ...track, group, folder: folderOf(track.path, from) }));
    if (fresh.length === 0) return 0;
    this.tracks = [...this.tracks, ...fresh];
    // The list itself changed, so it has to ride this frame; a count nobody
    // can index into is worse than no news at all.
    this.push(true);
    return fresh.length;
  }

  /**
   * Take an added source back out.
   *
   * The track that is playing is followed rather than an index: removing an
   * album from above the current track would otherwise slide the playlist out
   * from under a listener mid-song. If the playing track is itself in what is
   * being removed, playback stops -- there is nothing to keep playing.
   */
  drop(group: string): number {
    if (group === "") return 0;
    const playingPath = this.tracks[this.state.index]?.path;
    const kept = this.tracks.filter((track) => track.group !== group);
    const removed = this.tracks.length - kept.length;
    if (removed === 0) return 0;
    this.tracks = kept;
    const stillThere = kept.findIndex((track) => track.path === playingPath);
    if (stillThere === -1) {
      this.halt();
      this.state.index = this.clamp(this.state.index);
    } else {
      this.state.index = stillThere;
    }
    this.push(true);
    return removed;
  }

  sawPicture(index: number): void {
    const track = this.tracks[index];
    if (!track || track.picture === true) return;
    this.tracks = this.tracks.map((one, at) => (at === index ? { ...one, picture: true } : one));
    // The list changed in a way a client acts on -- which element it plays the
    // track in -- so it has to go out rather than wait for the next change.
    this.push(true);
  }

  groups(): string[] {
    const seen: string[] = [];
    for (const track of this.tracks) {
      if (track.group && !seen.includes(track.group)) seen.push(track.group);
    }
    return seen;
  }

  /**
   * The library, arriving after the server was already listening.
   *
   * Walking a directory is the slow part of starting -- eighty thousand files
   * under a home directory takes far longer than the fifteen seconds
   * `nixamp daemon start` waits for the server to say it is up, so starting a
   * daemon with no source given looked exactly like hanging and then failed
   * about a server that was working. The port opens first now and this puts
   * the library in behind it.
   *
   * Unlike `replace` it stops nothing and clears no listeners: whoever
   * connected in the first second is still connected, and simply sees the
   * playlist appear.
   */
  fill(tracks: Loaded[], root: string): void {
    // Something is already loaded, so this is a scan that finished after
    // somebody pointed the server elsewhere. Theirs wins.
    if (this.tracks.length > 0) return;
    this.tracks = tracks.map((track) => ({ ...track, folder: folderOf(track.path, root) }));
    this.root = root;
    this.state.note = tracks.length === 0 ? `No audio files under ${root}.` : "";
    this.push(true);
  }

  retag(tracks: Track[], root: string): void {
    // Matched by path rather than by position, because the list is no longer
    // required to be the one that was sent for tagging: somebody can add an
    // album while a library's tags are still being read, and an exact-shape
    // check would throw away every tag for it. Tags that describe tracks which
    // are no longer here simply match nothing, which is the same protection
    // the shape check was giving.
    void root;
    const byPath = new Map(tracks.map((track) => [track.path, track]));
    let changed = false;
    const merged = this.tracks.map((track) => {
      const tagged = byPath.get(track.path);
      if (!tagged || tagged === track) return track;
      changed = true;
      // The group is ours, not the tagger's: it knows what a track is called,
      // not which pile it is in.
      return {
        ...tagged,
        ...(track.group ? { group: track.group } : {}),
        ...(track.folder ? { folder: track.folder } : {}),
        // A name somebody chose outlives whatever the stream says about
        // itself. It called itself "932".
        ...(track.named ? { title: track.title, named: true } : {}),
      };
    });
    if (!changed) return;
    this.tracks = merged;
    // No stop, no index reset: the only thing that changes is what the titles
    // say, and every remote finds out because a snapshot goes out -- carrying
    // the list, since the titles are the whole point of this one.
    this.push(true);
  }
}

/**
 * The streams a server is carrying, gathered by name.
 *
 * A whole re-streamed folder is one entry rather than twenty: somebody
 * looking at what is on wants "that album from the web", not every track in
 * it. An entry names where to start, so clicking it plays.
 */
/**
 * A fetch-shaped Request for the throttle, built from the Node one.
 *
 * @profullstack/throttle is written against the web Request so it runs at an
 * edge; this server is Node's http. Only what the throttle reads is carried
 * across: method, URL and headers. The body is not, because metering is
 * decided before anybody reads it.
 */
export function requestFor(request: IncomingMessage, origin = "http://localhost"): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  // The address, for a throttle that has no socket to ask.
  if (!headers.has("x-forwarded-for") && request.socket?.remoteAddress) {
    headers.set("x-forwarded-for", request.socket.remoteAddress);
  }
  return new Request(`${origin}${request.url ?? "/"}`, { method: request.method ?? "GET", headers });
}

/** Write a refusal the throttle produced back through the Node response. */
export async function answerWith(response: ServerResponse, refused: Response): Promise<void> {
  const headers: Record<string, string> = { ...CORS };
  refused.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.writeHead(refused.status, headers);
  response.end(Buffer.from(await refused.arrayBuffer()));
}

/**
 * How many channels a server will start on demand at once. Each is an ffmpeg,
 * and a catalog has thousands of entries; this is what keeps a room full of
 * curious people from becoming a room full of decoders.
 */
export const MAX_ON_DEMAND = 4;

/**
 * How often where each film has got to is written down. A restart lands
 * somewhere inside this, and REWIND covers the gap.
 */
export const REMEMBER_EVERY_MS = 15_000;

/**
 * What a member may have on the air at once, here, and what all members
 * together may. Each is a decoder on this machine. The owner is not counted:
 * it is their machine.
 */
export const MEMBER_LIVES_EACH = 2;
export const MEMBER_LIVES_TOTAL = 8;
/** How many times a minute one member may ask to go live. Three is a person. */
export const MEMBER_STARTS_PER_MINUTE = 3;

/**
 * Going live, metered per member. The session rides in the query from
 * another origin, which is where the throttle is told to look for who is
 * asking; the same session in a header or cookie counts as the same caller.
 * No gateway: over the limit is a 429 with Retry-After, not an offer.
 */
const memberThrottle = createThrottle({
  limit: MEMBER_STARTS_PER_MINUTE,
  // A credential buys a caller the larger budget by default -- six hundred a
  // minute, sized for a host of people behind one address. Here the
  // credential is the person, and the person gets the same three; the
  // ceiling is what one address may spend across every session it presents.
  credential: { limit: MEMBER_STARTS_PER_MINUTE, ceiling: MEMBER_STARTS_PER_MINUTE * 10 },
  credentialFrom: (request) =>
    new URL(request.url).searchParams.get("session") ?? presentedCredential(request.headers) ?? null,
});

/** Why a member may not put one more thing on the air here, or "" when they may. */
export function memberLiveRefusal(channels: Channels, account: string): string {
  const mine = channels.list().filter((one) => one.startedBy === account).length;
  if (mine >= MEMBER_LIVES_EACH) {
    return `you already have ${MEMBER_LIVES_EACH} on the air here; take one off first`;
  }
  const all = channels.list().filter((one) => one.startedBy).length;
  if (all >= MEMBER_LIVES_TOTAL) {
    return `this server is carrying ${MEMBER_LIVES_TOTAL} members' streams already; try again when one ends`;
  }
  return "";
}

/**
 * Probe a source and start carrying it as a channel of its own.
 *
 * Shared by the request that puts one on and the boot that puts remembered
 * ones back, so that both agree on what a source is encoded as. Null when
 * that channel id is already on.
 */
/** What is already known about a source, so it need not be asked, or asked twice. */
export interface KnownSource {
  kind?: "audio" | "video";
  codecs?: Codecs;
  position?: number;
  live?: boolean;
}

/** How many times a source that answers nothing is asked, and how far apart. */
export const PROBE_TRIES = 3;
export const PROBE_RETRY_MS = 1500;

/**
 * Whether a channel may carry H.265 as it is.
 *
 * A channel has one encode and many viewers, so it has to be something they
 * can all play, and H.265 is not that: Safari and televisions decode it,
 * Chrome on a desktop mostly does not and shows nothing rather than saying
 * so. So an HEVC source is re-encoded by default -- to 1080p H.264, because a
 * 4K re-encode does not keep up with playback -- and an operator whose
 * audience is phones and televisions can say `NIXAMP_HEVC_CHANNELS=1` and
 * have the 4K copied through untouched. A single viewer asking for a file
 * over /api/media is a different matter: there the browser says for itself.
 */
export function hevcChannelsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NIXAMP_HEVC_CHANNELS"] === "1";
}

export async function pullChannel(
  channels: Channels,
  ffprobe: string[],
  id: string,
  name: string,
  source: string,
  input: string[] = [],
  audio = "",
  known: KnownSource = {},
): Promise<Channel | null> {
  const tools = { ffmpeg: [], ffprobe, play: null };
  const empty = (c: Codecs): boolean => c.video === "" && c.audio === "";
  // A pair is probed as a pair: the picture's file has no sound in it, and
  // asked alone it would read as a silent film. The sound's codec comes from
  // the sound's file; the picture's, and the container, from the picture's.
  const probe = async (): Promise<Codecs> => {
    const [picture, sound] = await Promise.all([
      codecsOf(tools, source, input),
      audio ? codecsOf(tools, audio, input) : Promise.resolve(null),
    ]);
    return sound ? { ...picture, audio: sound.audio } : picture;
  };
  // Known already: a restart puts back what it wrote down and asks nobody.
  // Otherwise ask, and ask again when the answer is nothing: a film on an
  // IPTV panel allows one connection, and while the last ffmpeg's is still
  // being counted a probe gets an error page and no streams. Nothing, read
  // as "no picture", is how two films came back on the air as sound alone.
  let codecs: Codecs = known.codecs && !empty(known.codecs) ? known.codecs : { video: "", audio: "", container: "" };
  let assumed = false;
  if (empty(codecs)) {
    for (let attempt = 0; attempt < PROBE_TRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, PROBE_RETRY_MS));
      codecs = await probe();
      if (!empty(codecs)) break;
    }
    assumed = empty(codecs);
  }
  // A source that would not say is carried as what it was last time, or as
  // video: a picture-less MP4 still plays, whereas a film as MP3 is a film
  // with no picture until somebody notices.
  const kind = codecs.video !== "" ? "video" : codecs.audio !== "" ? "audio" : (known.kind ?? "video");
  if (assumed) console.log(`  "${id}": the source would not say what it holds; carrying it as ${kind}.`);
  // A film has a length and a place to go back to; a live source has neither.
  const live = known.live ?? !((codecs.duration ?? 0) > 0);
  const encode = kind === "video"
    ? [
        // Which streams from which input, when there are two: the picture
        // from the first, the sound from the second. With one input ffmpeg
        // picks for itself, as it always did.
        ...(audio ? ["-map", "0:v:0", "-map", "1:a:0"] : []),
        ...videoArgs(codecs, 0, { allowHevc: hevcChannelsAllowed() }),
      ]
    // No picture in it, so none is invented: MP3 is the thing every browser
    // plays and the thing a listener can join halfway through.
    : ["-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"];
  // A transport stream is read further into before it is decoded, and given
  // the timestamps a recording cut mid-stream does not carry. Ahead of the
  // caller's own input arguments, which are headers for the address itself.
  const opening = [...transportInputArgs(source, codecs.container), ...input];
  const channel = channels.pull(
    id, name, source, encode, kind, true, undefined, opening, kind === "video" ? audio : "",
    { live, position: known.position ?? 0 },
  );
  if (channel && !assumed) channel.info.codecs = codecs;
  // What comes out, as opposed to what went in. An H.265 source copied
  // through stays H.265; one re-encoded arrives as H.264, and a packager
  // told otherwise would cut fMP4 segments for a stream that did not need
  // them.
  if (channel && kind === "video") {
    channel.info.emits = encode.includes("libx264") ? "h264" : codecs.video || "h264";
  }
  return channel;
}

/** What a link resolves to, kept so a download can be named without asking twice. */
const links = new Map<string, ResolvedLink>();

/**
 * A Netscape cookies file beside the state, if the operator has put one there.
 *
 * YouTube and Vimeo refuse a datacenter without a signed-in cookie; the
 * person who runs the server can export one from their browser and drop it
 * at ~/.local/state/nixamp/cookies.txt, and every link is asked for with it.
 */
export function cookiesFile(): string {
  const path = join(stateDir(), "cookies.txt");
  try {
    return statSync(path).isFile() ? path : "";
  } catch {
    return "";
  }
}

/** What the page is told about a link it asked to play. */
function shownLink(channelId: string, link: ResolvedLink) {
  return {
    kind: "live",
    channel: channelId,
    name: link.title,
    live: link.live,
    video: link.video,
    duration: link.duration,
    extractor: link.extractor,
    // A live has no whole to keep; a bare file can be fetched by the browser itself.
    download: !link.live && link.extractor !== "direct",
  };
}

export function liveOnes(engine: Engine): { name: string; at: number; tracks: number }[] {
  const tracks = engine.snapshot().tracks ?? [];
  const found = new Map<string, { name: string; at: number; tracks: number }>();
  tracks.forEach((track, at) => {
    if (track.remote !== true) return;
    const name = track.group || track.title;
    const already = found.get(name);
    if (already) already.tracks += 1;
    else found.set(name, { name, at, tracks: 1 });
  });
  return [...found.values()];
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
  fill(): void {}
  sawPicture(): void {}
  add(): number {
    return 0;
  }
  drop(): number {
    return 0;
  }
  groups(): string[] {
    return [];
  }
  retag(): void {}
  stop(): void {}
}

const CORS: Record<string, string> = {
  // A remote is a browser on another device on the same network, so the
  // control API has to be reachable cross-origin. It exposes no filesystem
  // paths and takes six commands; binding to 127.0.0.1 is what keeps it shut.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * How many nameless addresses are worth an ffprobe when a source is added.
 *
 * One is the ordinary case -- somebody pasting a channel -- and a directory
 * listing of thousands must not turn into thousands of probes for an answer
 * that only changes which element a browser uses.
 */
const PROBE_BY_HAND = 8;

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
    // Public to read, so it must not be behind a share key either.
    path === "/api/v1/opendirs" ||
    path.startsWith("/api/v1/opendirs/") ||
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

function htmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function eventDocument(shell: string, event: Awaited<ReturnType<LiveEvents["get"]>>, site: string): string {
  if (!event) return shell;
  const title = `${event.title} — BackToSchool.help`;
  const description = event.description || `Listen to ${event.title} live on BackToSchool.help.`;
  const canonical = `${site.replace(/\/$/, "")}/live/${encodeURIComponent(event.slug)}`;
  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    description,
    eventStatus: event.status === "cancelled"
      ? "https://schema.org/EventCancelled"
      : event.status === "live"
        ? "https://schema.org/EventInProgress"
        : event.status === "ended"
          ? "https://schema.org/EventCompleted"
          : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    ...(event.startsAt ? { startDate: event.startsAt } : {}),
    ...(event.endsAt ? { endDate: event.endsAt } : {}),
    url: canonical,
    location: { "@type": "VirtualLocation", url: canonical },
  }).replaceAll("<", "\\u003c");
  return shell
    .replace(/<title>.*?<\/title>/s, `<title>${htmlText(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${htmlText(description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/>/, `<meta property="og:title" content="${htmlText(event.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/>/, `<meta property="og:description" content="${htmlText(description)}" />`)
    .replace("</head>", `${event.visibility === "public" ? "" : '<meta name="robots" content="noindex,nofollow" />'}\n    <meta property="og:url" content="${htmlText(canonical)}" />\n    <link rel="canonical" href="${htmlText(canonical)}" />\n    <script type="application/ld+json">${structured}</script>\n  </head>`);
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
  /** yt-dlp, which turns a pasted page into a media address. Null when there is none. */
  ytdlp?: string[] | null;
  /** Channels as HLS, for Safari on a phone, which plays a live stream no other way. */
  hls?: HlsPackagers;
  /** What a name is -- a film, a channel, a fixture -- asked of nichedb.dev and remembered. */
  enricher?: Enricher;
  /** A Netscape cookies file for sites that want a signed-in browser, when there is one. */
  cookies?: string;
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
  /** Write down the channels this server pulls, so a restart puts them back. */
  rememberChannels?: (list: RememberedChannel[]) => void;
  /** The m3u catalogs this server keeps, browsable by group. */
  catalogs?: Catalogs;
  /** Live audio going out to RTMP. */
  broadcaster?: Broadcaster;
  /** Where a broadcast should send, and what it should look like. */
  broadcast?: () => { destinations: Destination[]; settings: EncoderSettings };
  /** What this server calls itself, for the list of what is live on it. */
  serverName?: string;
  /**
   * The source this server was started on -- its own library.
   *
   * Replacing the playlist with a stream leaves no way back to it: the address
   * is a path on somebody else's machine, and a person looking at a player has
   * no reason to know it. Reported to an administrator so there can be a
   * button rather than a thing you have to remember and retype.
   *
   * Admin-only, because it is a filesystem path and a viewer has no business
   * with it.
   */
  homeSource?: string;
  /**
   * Going live: whether this server is listed, and how to change that.
   *
   * Listing used to be a question asked once at startup and never again, so a
   * server started with --no-publish had no listing, no phone code, and no
   * link to hand anybody -- and no way to change its mind short of stopping
   * and starting it. It is an action now, because that is what it is.
   */
  live?: {
    status: () => {
      live: boolean; code: string; name: string; url: string; possible: boolean;
      /** A phone code per live channel, by name, as the directory assigned them. */
      channelCodes?: Record<string, string>;
    };
    start: () => Promise<{ live: boolean; code: string; name: string; url: string; error?: string }>;
    stop: () => Promise<void>;
    /**
     * Tell the directory now rather than at the next heartbeat. A channel
     * that just went on the air should be in the list before the person who
     * put it there has looked, and a heartbeat is ninety seconds.
     */
    announce?: () => Promise<void>;
  };
  /**
   * Where OBS should point, one entry per stream this server will accept.
   *
   * There is deliberately no single link. ffmpeg's RTMP listener serves one
   * connection per process, so three people going live at once is three ports
   * and three URLs -- and a panel offering one address for all of them would
   * be offering an address that works exactly once.
   */
  publishUrls?: () => { id: string; url: string }[];
  /** Accounts, on the instance that keeps them. Only nixamp.com passes this. */
  accounts?: Accounts;
  /** Providers to sign in with, and the terminals waiting to be connected. */
  signIn?: SignIn;
  /** The servers each account runs, on the instance that keeps accounts. */
  servers?: Servers;
  /** The name other people see, which is never the address they signed up with. */
  handles?: Handles;
  /** Open directories people have found, which anyone may read. */
  openDirs?: OpenDirs;
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
  /** The servers an account hearted. nixamp.com only, like follows. */
  favorites?: Favorites;
  /** Scheduled and live sessions, kept by NixAmp and shared by branded clients. */
  events?: LiveEvents;
  /** Versioned panel layouts, including event and user overrides. */
  layouts?: Layouts;
  /** Persistent participation state that must not be coupled to live audio. */
  rooms?: Rooms;
  /**
   * How an invite is sent: by email, by text, and the site the watch link is
   * built on. nixamp.com only; a personal nixamp has no mail to send from.
   */
  invites?: {
    email?: (to: string, note: Notification) => Promise<boolean>;
    sms?: { send(to: string, text: string): Promise<boolean> };
    site: string;
  };
  /** Names under `<handle>.<zone>` for an account's servers. nixamp.com only. */
  names?: Names;
  /** One wildcard certificate per handle, issued and renewed here. nixamp.com only. */
  certs?: Certs;
  /** The zone the names live in, e.g. "nixamp.com". */
  dnsZone?: string;
  /**
   * The rate limit over everything, from @profullstack/throttle. Fetch-shaped,
   * so the handler builds a Request from the Node one and writes back the
   * Response it is refused with.
   */
  throttle?: Throttle;
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
    const channelParts = path.startsWith("/api/channels/")
      ? path.slice("/api/channels/".length).split("/")
      : null;
    const channelId = channelParts ? cleanId(channelParts[0]) : "";
    const channelAction = channelParts?.[1];
    let channelEvent: LiveEvent | null | undefined;
    const eventForChannel = async (): Promise<LiveEvent | null> => {
      if (channelEvent === undefined) {
        channelEvent = channelId ? await options.events?.byRoom(channelId) ?? null : null;
      }
      return channelEvent;
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    // Metered before anything is done for the request, so a caller over its
    // allowance costs nothing but this check. The throttle decides; this only
    // carries its refusal back through Node's response.
    if (options.throttle) {
      const refused = await options.throttle.handle(requestFor(request));
      if (refused) {
        await answerWith(response, refused);
        return;
      }
    }

    // Opening a share link is what hands a browser its key. It comes back as a
    // cookie, so every later fetch, EventSource and <audio src> carries it
    // without the page knowing anything about keys. Either key works here, and
    // which one was used decides what the browser can then do.
    const inPath = key !== null ? keyInPath(path) : null;
    if (inPath !== null) {
      const offered = inPath.key;
      // The path has to be telling the truth about the key it carries. A `/v/`
      // link holding the control key would read as view-only to whoever you
      // sent it to and hand them the controls, which is the whole reason for
      // naming the two shapes in the first place.
      //
      // A mismatch answers exactly as a wrong key does, so nothing is learned
      // from the difference between the two.
      if (scopeOf(offered, key, listenKey) !== inPath.wants) {
        json(response, 404, { error: "not found" });
        return;
      }
      response.writeHead(302, { ...CORS, "set-cookie": keyCookie(offered), location: "/" });
      response.end();
      return;
    }

    if (options.events && await handleLiveApi(request, response, url, {
      events: options.events,
      ...(options.accounts ? { accounts: options.accounts } : {}),
      ...(options.layouts ? { layouts: options.layouts } : {}),
      ...(options.rooms ? { rooms: options.rooms } : {}),
      ...(options.invites?.site ? { site: options.invites.site } : {}),
      ...(options.invites?.email ? { email: options.invites.email } : {}),
    })) return;

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
    // --- names and certificates for an account's servers --------------------
    //
    // A server that is signed in becomes `<label>.<handle>.<zone>`, with A and
    // AAAA records nixamp.com writes with keys only nixamp.com holds, and it
    // serves https with the one wildcard certificate its handle has. Nothing
    // about DNS or ACME ever reaches the box; it asks, and is answered.
    if ((path === "/api/v1/dns" || path.startsWith("/api/v1/dns/")) && options.names && options.accounts && options.handles) {
      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in to name a server" });
        return;
      }
      const handle = await options.handles.of(me.id);
      if (!handle) {
        json(response, 422, { error: "this account has no handle yet" });
        return;
      }
      const names = options.names;
      const zone = `${handle}.${options.dnsZone ?? ""}`.replace(/\.$/, "");

      if (path === "/api/v1/dns" && request.method === "GET") {
        json(response, 200, { zone, names: await names.list(me.id, handle) });
        return;
      }
      const label = decodeURIComponent(path.slice("/api/v1/dns/".length));
      if (!label) {
        json(response, 404, { error: "no such endpoint" });
        return;
      }
      if (request.method === "PUT" || request.method === "POST") {
        let body: { a?: unknown; aaaa?: unknown; ttl?: unknown } = {};
        try {
          body = JSON.parse((await readBody(request)) || "{}") as typeof body;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        // "auto" is the address this request came from, for whichever family
        // it came in on: a server names itself without knowing its address.
        const caller = callerOf(request.headers, request.socket.remoteAddress, options.behindProxy ?? false);
        const family = (value: unknown, is: (ip: unknown) => boolean): string | null | undefined => {
          if (value === null) return null;
          if (value === undefined) return undefined;
          if (value === "auto") return is(caller) ? caller : undefined;
          return String(value);
        };
        try {
          const name = await names.set(me.id, handle, label, {
            a: family(body.a, isIPv4),
            aaaa: family(body.aaaa, isIPv6),
            ...(typeof body.ttl === "number" ? { ttl: body.ttl } : {}),
          });
          json(response, 200, { name });
        } catch (error) {
          const status = error instanceof NameError ? error.status : 500;
          json(response, status, { error: (error as Error).message });
        }
        return;
      }
      if (request.method === "DELETE") {
        const gone = await names.remove(me.id, handle, label);
        json(response, gone ? 200 : 404, gone ? { ok: true } : { error: "no such name of yours" });
        return;
      }
      json(response, 405, { error: "GET, PUT or DELETE" });
      return;
    }

    if (path === "/api/v1/certs" && options.certs && options.accounts && options.handles) {
      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in to get a certificate" });
        return;
      }
      const handle = await options.handles.of(me.id);
      if (!handle) {
        json(response, 422, { error: "this account has no handle yet" });
        return;
      }
      const state = await options.certs.forHandle(handle);
      const host = `*.${handle}.${options.dnsZone ?? ""}`.replace(/\.$/, "");
      if (state.status === "ready") {
        json(response, 200, { status: "ready", cert: state.cert, key: state.key, expiresAt: state.expiresAt, host, renewing: state.renewing });
        return;
      }
      if (state.status === "failed") {
        json(response, 503, { status: "failed", error: state.error, host });
        return;
      }
      json(response, 202, { status: "issuing", host });
      return;
    }

    // --- an invite: "so-and-so is streaming", by text or by email ------------
    //
    // The page had a Send button and nothing answered it: the message was
    // written (invite.ts) and never given a route. Sending needs an account,
    // because a text costs money and lands on somebody's phone, and the link
    // sent is always the listen link -- an admin link handed out by mistake
    // would hand out the server.
    if (path === "/api/v1/invite" && options.invites && options.accounts) {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in to send an invite" });
        return;
      }
      let body: { to?: unknown; stream?: unknown } = {};
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      const to = String(body.to ?? "").trim();
      const stream = String(body.stream ?? "").trim();
      const byEmail = isEmail(to);
      const bySms = !byEmail && isPhone(to);
      if (!byEmail && !bySms) {
        json(response, 400, { error: "give a phone number or an email address" });
        return;
      }
      let origin = "";
      try {
        origin = new URL(stream).origin;
      } catch {
        json(response, 400, { error: "that is not a stream link" });
        return;
      }
      // What the directory knows about this server names it and gives the
      // listen link and the phone code. An unlisted server is still sendable,
      // as long as the link given is not the one that drives it.
      const listed = options.directory?.list().find((one) => {
        try {
          return new URL(one.url).origin === origin;
        } catch {
          return false;
        }
      });
      const link = listed?.url ?? stream;
      if (/\/admin\//.test(link) || /[?&]k=/.test(link) && !listed) {
        json(response, 400, { error: "send the view link, not the admin link" });
        return;
      }
      const invite = {
        name: listed?.name ?? new URL(link).hostname,
        link: watchLink(link, options.invites.site),
        phone: listed ? CALL_IN_NUMBER : "",
        code: listed?.code ?? "",
      };
      const sender = byEmail ? options.invites.email : options.invites.sms;
      if (!sender) {
        json(response, 503, { error: byEmail ? "this site cannot send email yet" : "this site cannot send texts yet" });
        return;
      }
      const ok = byEmail
        ? await options.invites.email!(to, { title: inviteSubject(invite), body: inviteText(invite), url: invite.link })
        : await options.invites.sms!.send(to, inviteText(invite));
      json(response, ok ? 200 : 502, ok ? { sent: to } : { error: "the message did not go" });
      return;
    }

    // Favourites: the servers you hearted, kept against your account. Reading
    // the directory and listening need no account; remembering where you
    // listened does, because there has to be somebody to remember it for.
    if (path === "/api/v1/favorites" && options.favorites && options.accounts) {
      const me = await options.accounts.whoIs(tokenFrom(request.headers));
      if (me === null) {
        json(response, 401, { error: "sign in to keep favourites" });
        return;
      }
      const favorites = options.favorites;

      if (request.method === "GET") {
        const list = await favorites.list(me.id);
        // Whether each is on right now, from the directory: a favourite that
        // is live is the one to click first.
        const live = new Map((options.directory?.list() ?? []).map((one) => [one.url, one]));
        json(response, 200, {
          favorites: list.map((one) => {
            const on = live.get(one.url);
            return {
              ...one,
              live: on !== undefined,
              nowPlaying: on?.playing ? on.nowPlaying : "",
              channels: on?.channels ?? [],
            };
          }),
        });
        return;
      }

      if (request.method === "PUT" || request.method === "POST") {
        let body: { url?: unknown; name?: unknown } = {};
        try {
          body = JSON.parse(await readBody(request)) as typeof body;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        const address = favoriteUrl(body.url);
        if (!address) {
          json(response, 400, { error: "give the server's address" });
          return;
        }
        await favorites.add(me.id, address, typeof body.name === "string" ? body.name : "");
        json(response, 200, { favorite: true });
        return;
      }

      if (request.method === "DELETE") {
        const address = favoriteUrl(url.searchParams.get("url"));
        if (!address) {
          json(response, 400, { error: "give the server's address" });
          return;
        }
        await favorites.remove(me.id, address);
        json(response, 200, { favorite: false });
        return;
      }
      json(response, 405, { error: "GET, PUT or DELETE" });
      return;
    }

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
    const eventChannelRequest = Boolean(channelId && await eventForChannel());
    if (
      key !== null &&
      path !== "/api/health" &&
      path !== "/api/directory" &&
      !isSignInPath(path) &&
      !eventChannelRequest
    ) {
      let scope = scopeOf(keyFrom(request, url), key, listenKey);
      // A key is how somebody who was invited proves it. It is not the only way
      // to be allowed in: the person who owns this server is allowed in whether
      // or not they still have the link, and their nixamp.com session says who
      // they are. Without this, signing in as yourself and opening your own
      // server was refused, and the address of a machine you administer was
      // useless without a link you had to go and find.
      if (scope === null && options.owner) {
        const check = await options.owner.check(false, tokenFrom(request.headers));
        if (check.allowed) scope = "control";
      }
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
        json(response, 401, {
          error: "this nixamp needs the key from its share link, or sign in as its owner",
        });
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

      /**
       * The session itself, for the page to carry to a server on another
       * origin. The cookie is this host's and stays here; a server elsewhere
       * can only be shown the session in the query, the way it is shown the
       * key. Only a signed-in caller gets one, and it is the token they
       * already hold -- nothing new is minted.
       */
      if (path === "/api/v1/auth/token") {
        const token = tokenFrom(request.headers);
        const who = await accounts.whoIs(token);
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }
        json(response, 200, { token });
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

    // --- the name other people see ---------------------------------------
    //
    // Separate from the address on purpose. The address is a credential and
    // a way to reach somebody; publishing it in a directory listing or an
    // invite would be publishing what they log in with.
    if (path === "/api/v1/me/handle" && options.handles && options.accounts) {
      const handles = options.handles;
      const who = await options.accounts.whoIs(tokenFrom(request.headers));
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
    if ((path === "/api/v1/servers" || path.startsWith("/api/v1/servers/")) && options.servers && options.accounts) {
      const servers = options.servers;
      const who = await options.accounts.whoIs(tokenFrom(request.headers));
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

    // --- open directories somebody found -----------------------------------
    //
    // Its own list, not the stream directory: that one is what is playing now,
    // with a heartbeat and a room code and somebody at the other end, and this
    // one is a folder on the web that is always there and belongs to nobody
    // here. Reading needs no account. Adding does, because a public list with
    // nobody accountable for its rows is a list of whatever anyone felt like.
    if ((path === "/api/v1/opendirs" || path.startsWith("/api/v1/opendirs/")) && options.openDirs) {
      const dirs = options.openDirs;

      if (path === "/api/v1/opendirs" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const before = Number(url.searchParams.get("before") ?? "0");
        const page = await dirs.list(Number.isFinite(limit) ? limit : 50, Number.isFinite(before) ? before : 0);
        const names = options.handles ? await options.handles.many(page.addedBy) : new Map<string, string>();
        json(response, 200, {
          opendirs: page.rows.map((row, at) => ({
            ...row,
            // A handle or nothing. The address that signed up is never here.
            by: names.get(page.addedBy[at] ?? "") ?? "",
          })),
          next: page.next,
        });
        return;
      }

      if (path === "/api/v1/opendirs" && request.method === "POST" && options.accounts) {
        const who = await options.accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "sign in to publish one" });
          return;
        }
        let body: { url?: unknown; name?: unknown };
        try {
          body = JSON.parse(await readBody(request)) as typeof body;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }

        // Read before publishing. A row nobody can play is worse than no row,
        // and the count is the one fact a reader wants before clicking.
        const listed = typeof body.url === "string" ? await readRemoteIndex(body.url) : [];
        if (listed.length === 0) {
          json(response, 422, { error: "nothing playable was linked from that page" });
          return;
        }
        const made = await dirs.add(who.id, body.url, body.name, listed.length);
        if (made === null) {
          json(response, 422, { error: "that needs an http or https address" });
          return;
        }
        const handle = options.handles ? await options.handles.of(who.id) : "";
        json(response, 201, { opendir: { ...made, by: handle } });
        return;
      }

      const dirId = path.slice("/api/v1/opendirs/".length);
      if (dirId && request.method === "DELETE" && options.accounts) {
        const who = await options.accounts.whoIs(tokenFrom(request.headers));
        if (who === null) {
          json(response, 401, { error: "not signed in" });
          return;
        }
        const gone = await dirs.remove(who.id, dirId);
        json(response, gone ? 200 : 404, gone ? { ok: true } : { error: "not yours, or not there" });
        return;
      }

      json(response, 405, { error: "GET, POST or DELETE" });
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
        // The admin link goes only to the account that owns the listing. A
        // directory that handed out control links would be a directory of
        // machines anyone could take over.
        const me = options.accounts ? await options.accounts.whoIs(tokenFrom(request.headers)) : null;
        const streams = options.directory.list().map(({ admin, ...stream }) => ({
          ...stream,
          callers: onThePhone ? onThePhone.listenersOn(stream.code) : 0,
          // And on the phone for each live on it, by name: every live is its
          // own room, so each has its own count.
          channelCallers: Object.fromEntries(
            Object.entries(stream.channelCodes).map(([name, code]) => [name, onThePhone ? onThePhone.listenersOn(code) : 0]),
          ),
          ...(admin && me !== null && stream.ownerId === me.id ? { admin } : {}),
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
        const id = url.searchParams.get("id") ?? "";
        const listing = options.directory.list().find((one) => one.id === id);
        if (!listing) {
          // Already gone, or never here. Saying so plainly rather than
          // pretending to have done something.
          json(response, 404, { error: "no such listing" });
          return;
        }

        // Taking a stream out of a public directory is the owner's to do.
        //
        // This asked nobody anything: a listing id is in every copy of the
        // list, so anyone who could read the directory could empty it of other
        // people's streams. The publisher already sends its token; it was
        // simply never looked at.
        const who = options.accounts ? await options.accounts.whoIs(tokenFrom(request.headers)) : null;
        const mine = listing.ownerId !== "" && who !== null && who.id === listing.ownerId;
        if (!mine) {
          json(response, 403, {
            error: listing.ownerId === ""
              ? "that listing has no owner to prove; it leaves the list when it stops renewing"
              : "only the account that published a stream can take it off the list",
          });
          return;
        }

        options.directory.withdraw(id);
        json(response, 200, { ok: true });
        return;
      }
      json(response, 405, { error: "GET, POST or DELETE" });
      return;
    }

    // Administering is a different question from listening, and it is asked
    // after the share key: the control key answers both, but a listen key or a
    // nixamp.com session answers only one of them.
    /**
     * The member this request is from, when it is a member going live rather
     * than the owner administering: the nixamp.com account id. Read by the
     * handlers that put things on the air, to mark what they put on and to
     * count it against what a member may have on at once.
     */
    let liveBy = "";
    const eventMediaOperation = Boolean(
      channelId &&
      ((request.method === "POST" && (channelAction === undefined || channelAction === "chunk")) ||
        (request.method === "DELETE" && channelAction === undefined)) &&
      eventChannelRequest,
    );
    if (options.owner && needsAdmin(path, request.method ?? "GET") && !eventMediaOperation) {
      // A server started with --no-key has said that anyone who can reach the
      // port may drive it, and prints exactly that. Locking administration to
      // nobody would contradict it and leave such a server unadministrable.
      const holdsControl =
        key === null || scopeOf(keyFrom(request, url), key, null) === "control";
      // A session in the query as well as in a header or a cookie: from
      // nixamp.com's page a server is another origin, and the cookie stays
      // home, so the session travels the way the key does.
      const sessionToken = tokenFrom(request.headers) || url.searchParams.get("session") || "";
      const check = await options.owner.check(holdsControl, sessionToken);
      // Not the owner, but somebody: a signed-in nixamp.com account is a
      // member, and a member may go live here.
      const member = check.allowed ? "" : await options.owner.accountFor(sessionToken);

      if (path === "/api/admin") {
        // Always answered, and honestly: the page has to know whether to draw
        // an admin panel at all, and "no" is a real answer rather than a 403.
        json(response, 200, { allowed: check.allowed, as: check.as, claimed: options.owner.claimed, member: member !== "" });
        return;
      }
      if (!check.allowed) {
        if (member !== "" && needsMember(path, request.method ?? "GET")) {
          // Metered per member, before anything is done: going live is a
          // decoder on this machine, and a script could ask for one a
          // second. Three a minute is a person; more is not.
          const refused = await memberThrottle.handle(requestFor(request));
          if (refused) {
            await answerWith(response, refused);
            return;
          }
          liveBy = member;
        } else {
          json(response, 403, {
            error: options.owner.claimed
              ? "sign in to nixamp.com as this server's owner, or use its control link"
              : "this server has no owner signed in; use its control link",
          });
          return;
        }
      }
    }

    // After the key check: a paying listener still needs the link, and a 402
    // is a worse answer than a 401 to someone who has neither.
    if (options.paywall && (await options.paywall(request, response, path))) return;

    /**
     * What is live on this server, for somebody deciding what to watch.
     *
     * Two different things are, and they were only ever visible in two
     * different places: the server's own stream -- its playlist, which is what
     * it is listed in the directory as -- and any channels being published
     * into it from OBS or a phone. A person connected to a server had no way
     * to see either as a list, so "what is on here?" had no answer.
     *
     * Readable by anyone holding either link, because this is the viewing
     * side: it names streams and how to reach them, and says nothing about
     * how to change them.
     */
    if (path === "/api/streams") {
      const now = engine.snapshot(false);
      const state = options.live?.status();
      json(response, 200, {
        server: {
          name: options.serverName ?? "this server",
          nowPlaying: engine.snapshot().tracks?.[now.index]?.title ?? "",
          tracks: now.trackCount,
          playing: now.playing,
          /**
           * Live means playing, and it did not.
           *
           * It meant "listed in a directory", which is a different fact
           * entirely -- so a stopped server advertised a live stream of a film
           * nobody was watching, and everybody who joined started it from the
           * beginning on their own. There is nothing to be in sync with until
           * something is actually running.
           */
          live: state?.live === true && now.playing,
          /** Findable in the directory, which is what `live` used to mean. */
          listed: state?.live === true,
          // Only when it has been published: a code is a thing you dial, and
          // one nobody can dial is not worth showing.
          code: state?.code ?? "",
          url: state?.url ?? "",
        },
        channels: (options.channels?.list() ?? []).map((one) => ({
          id: one.id,
          name: one.name,
          via: one.via,
          listeners: one.listeners,
          startedAt: one.startedAt,
          // Whether it has a picture, so the page puts it in the element
          // that can show one. Never the source: that is the owner's.
          kind: one.kind ?? "audio",
          // Its own room on the phone line, as the directory assigned it;
          // empty until the next heartbeat has told the directory it is on.
          code: state?.channelCodes?.[one.name] ?? "",
          // How it has been going, for whoever may do something about it.
          redials: one.redials ?? 0,
          error: one.error ?? "",
          // The member who put it on, when one did: theirs to take off.
          startedBy: one.startedBy ?? "",
        })),
        // Anything re-streamed into this server is a live stream too, and was
        // sitting in the middle of the playlist among the files -- which is
        // what made moving between a channel and an album so confusing. Named
        // here with the first track it owns, so it can be played from the list
        // of what is live rather than hunted for among five thousand files.
        // Every stream coming off the network, however it got here.
        //
        // This used to read the groups, which only exist for sources that were
        // added -- so re-streaming something as a replacement produced a
        // channel that appeared in no list anywhere, with nothing to click.
        // What makes a thing live is where it comes from, not which button
        // loaded it.
        restreams: liveOnes(engine),
      });
      return;
    }

    // --- several streams at once ------------------------------------------
    //
    // --- catalogs: m3u lists you can browse ---------------------------------
    //
    // An IPTV list is thousands of entries with groups and logos. Kept as a
    // catalog it stays browsable; poured into the playlist it was three
    // thousand flat rows. Anyone with the link browses and plays; adding,
    // refreshing and removing is administering (see needsAdmin).
    if ((path === "/api/catalogs" || path.startsWith("/api/catalogs/")) && options.catalogs) {
      const catalogs = options.catalogs;

      if (path === "/api/catalogs" && request.method === "GET") {
        // Where a list is read from is the administrator's business, not a
        // listener's: it can carry a provider's credentials in the URL.
        const holdsControl = key === null || scopeOf(keyFrom(request, url), key, null) === "control";
        const admin = options.owner
          ? (await options.owner.check(holdsControl, tokenFrom(request.headers))).allowed
          : holdsControl;
        json(response, 200, { catalogs: catalogs.list().map((one) => shownCatalog(one, admin)) });
        return;
      }

      if (path === "/api/catalogs" && request.method === "POST") {
        let body: { source?: unknown; name?: unknown } = {};
        try {
          body = JSON.parse(await readBody(request)) as typeof body;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        try {
          const added = await catalogs.add(String(body.source ?? ""), String(body.name ?? ""));
          json(response, added.error ? 422 : 200, {
            ok: !added.error,
            catalog: shownCatalog(added, true),
            ...(added.error ? { error: added.error } : {}),
          });
        } catch (error) {
          json(response, 422, { error: (error as Error).message.replace(/^nixamp: /, "") });
        }
        return;
      }

      const [rawId = "", action = "", entryId = "", sub = ""] = path.slice("/api/catalogs/".length).split("/");
      const id = decodeURIComponent(rawId);
      if (!catalogs.get(id)) {
        json(response, 404, { error: "no such catalog" });
        return;
      }

      if (action === "" && request.method === "DELETE") {
        json(response, 200, { ok: catalogs.remove(id) });
        return;
      }
      if (action === "refresh" && request.method === "POST") {
        const refreshed = await catalogs.refresh(id);
        json(response, refreshed && !refreshed.error ? 200 : 422, {
          ok: refreshed !== null && !refreshed.error,
          ...(refreshed ? { catalog: shownCatalog(refreshed, true) } : {}),
          ...(refreshed?.error ? { error: refreshed.error } : {}),
        });
        return;
      }
      if (action === "groups" && request.method === "GET") {
        json(response, 200, { groups: catalogs.groups(id) ?? [] });
        return;
      }
      if (action === "entries" && entryId === "" && request.method === "GET") {
        const page = catalogs.entries_(id, {
          group: url.searchParams.get("group") ?? "",
          q: url.searchParams.get("q") ?? "",
          offset: Number(url.searchParams.get("offset") ?? "0") || 0,
          limit: Number(url.searchParams.get("limit") ?? "200") || 200,
        }) ?? { total: 0, entries: [] };
        json(response, 200, { total: page.total, entries: page.entries.map(shownEntry) });
        return;
      }

      const entry = action === "entries" && entryId !== "" ? catalogs.entry(id, decodeURIComponent(entryId)) : null;
      if (!entry) {
        json(response, 404, { error: "no such entry" });
        return;
      }

      // Play. A live entry becomes a channel, started for whoever asked and
      // stopped a minute after the last viewer leaves; a film is played on
      // its own, straight from the source through ffmpeg.
      if (sub === "play" && request.method === "POST") {
        if (!entry.live) {
          json(response, 200, {
            kind: "vod",
            url: `/api/catalogs/${encodeURIComponent(id)}/entries/${encodeURIComponent(entry.id)}/stream`,
            name: entry.title,
          });
          return;
        }
        if (!options.channels) {
          json(response, 503, { error: "this server cannot carry channels" });
          return;
        }
        const channelId = cleanId(`cat-${entry.id}`);
        if (!options.channels.has(channelId)) {
          if (options.channels.ephemeralCount >= MAX_ON_DEMAND) {
            json(response, 429, { error: `this server is already carrying ${MAX_ON_DEMAND} channels on demand; try again in a minute` });
            return;
          }
          const started = await pullChannel(options.channels, options.ffprobe ?? ["ffprobe"], channelId, entry.title, entry.source);
          if (!started) {
            json(response, 409, { error: "that channel is already starting" });
            return;
          }
          options.channels.ephemeral(channelId);
          // Told to the directory now, so the room code arrives with the
          // channel rather than at the next heartbeat, ninety seconds on.
          void options.live?.announce?.();
        }
        json(response, 200, { kind: "live", channel: channelId, name: entry.title });
        return;
      }

      // Go live with it. The same channel a viewer would get on demand, but
      // kept: it stays up with nobody watching, it is written down so a
      // restart puts it back, and the directory hears about it now. A film
      // goes on the air the same way -- read at its own pace from the start,
      // so everybody who opens the link sees the same minute of it.
      if (sub === "live" && request.method === "POST") {
        if (!options.channels) {
          json(response, 503, { error: "this server cannot carry channels" });
          return;
        }
        const channelId = cleanId(`cat-${entry.id}`);
        // A member's, if a member asked: counted against what they may have
        // on, and theirs to take off. Something already on stays whose it was.
        if (liveBy && !options.channels.has(channelId)) {
          const refusal = memberLiveRefusal(options.channels, liveBy);
          if (refusal) {
            json(response, 429, { error: refusal });
            return;
          }
        }
        if (!options.channels.has(channelId)) {
          const started = await pullChannel(options.channels, options.ffprobe ?? ["ffprobe"], channelId, entry.title, entry.source);
          if (!started) {
            json(response, 409, { error: "that channel is already starting" });
            return;
          }
          if (liveBy) {
            const info = options.channels.info(channelId);
            if (info) info.startedBy = liveBy;
          }
        }
        options.channels.keep(channelId);
        options.rememberChannels?.(rememberedNow(options.channels));
        void options.live?.announce?.();
        json(response, 200, { channel: channelId, name: entry.title, kind: entry.live ? "live" : "vod" });
        return;
      }

      if (sub === "stream" && request.method === "GET") {
        if (!options.media) {
          json(response, 403, { error: "media streaming is off" });
          return;
        }
        watch(request, response, "stream", entry.title);
        const codecs = await codecsOf({ ffmpeg: [], ffprobe: options.ffprobe ?? ["ffprobe"], play: null }, entry.source);
        if (codecs.video !== "") {
          pipeFfmpeg(
            request, response, entry.source, options.ffmpeg ?? ["ffmpeg"],
            videoArgs(codecs, 0, { allowHevc: url.searchParams.get("hevc") === "1" }), "video/mp4",
            transportInputArgs(entry.source, codecs.container),
          );
        } else {
          transcode(request, response, entry.source, options.ffmpeg ?? ["ffmpeg"]);
        }
        return;
      }

      json(response, 404, { error: "no such endpoint" });
      return;
    }

    // --- any link, played -------------------------------------------------
    //
    // Paste a page -- YouTube, a podcast, SoundCloud, a TikTok live -- and the
    // server works out where the media is and plays it as a channel of its
    // own, the way a catalog entry is played: started for whoever asked,
    // stopped a minute after the last viewer leaves. Open to anyone holding
    // the link, like picking something from a catalog.
    // --- what is this? ------------------------------------------------------
    //
    // A file name, a playlist entry, a channel: the poster, the logo, the
    // year, the rating, from nichedb.dev, remembered here so a library is
    // asked about once. Open to whoever holds the link, like the playlist.
    if (path === "/api/enrich" && request.method === "GET") {
      const name = (url.searchParams.get("name") ?? "").trim().slice(0, 300);
      if (name === "") {
        json(response, 400, { error: "name is required" });
        return;
      }
      if (!options.enricher) {
        json(response, 200, { match: null });
        return;
      }
      const kinds: EnrichKind[] = ["auto", "title", "channel", "fixture"];
      const asked = url.searchParams.get("kind") ?? "auto";
      const kind = kinds.includes(asked as EnrichKind) ? (asked as EnrichKind) : "auto";
      const year = Number(url.searchParams.get("year")) || null;
      const match = await options.enricher.lookup(name, kind, year);
      response.writeHead(200, {
        ...CORS,
        "content-type": "application/json; charset=utf-8",
        // Briefly: the server remembers for days, so the browser need not,
        // and an hour of browser cache hid a better answer for an hour. A
        // fixture's score moves by the minute and the page asks again every
        // minute; a browser cache that long would answer instead of the server.
        "cache-control": match?.kind === "fixture"
          ? `public, max-age=${Math.floor(FIXTURE_TTL_MS / 2000)}`
          : match ? "public, max-age=300" : "public, max-age=120",
      });
      response.end(JSON.stringify({ match }));
      return;
    }

    if (path === "/api/links/play" && request.method === "POST") {
      let body: { url?: unknown } = {};
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      const link = playableLink(body.url);
      if (link === "") {
        json(response, 400, { error: "that is not a link this can play" });
        return;
      }
      if (!options.channels) {
        json(response, 503, { error: "this server cannot carry channels" });
        return;
      }
      const channelId = linkChannelId(link);
      const known = links.get(link);
      if (options.channels.has(channelId) && known) {
        json(response, 200, shownLink(channelId, known));
        return;
      }
      if (!options.channels.has(channelId) && options.channels.ephemeralCount >= MAX_ON_DEMAND) {
        json(response, 429, { error: `this server is already carrying ${MAX_ON_DEMAND} channels on demand; try again in a minute` });
        return;
      }
      const resolved = known ?? await resolveLink(options.ytdlp ?? null, link, { cookies: options.cookies ?? "" });
      if ("error" in resolved) {
        json(response, 422, { error: resolved.error });
        return;
      }
      links.set(link, resolved);
      if (!options.channels.has(channelId)) {
        // Asked of the site first, once, with the headers yt-dlp said to
        // send. A media address that answers nothing is a site refusing
        // this server -- YouTube does, for many videos, to a datacenter --
        // and the honest answer is that, now, rather than a channel that
        // starts, gets 403 five times, and quietly stops.
        const reachable = await codecsOf(
          { ffmpeg: [], ffprobe: options.ffprobe ?? ["ffprobe"], play: null }, resolved.media, inputArgsFor(resolved.headers),
        );
        if (reachable.video === "" && reachable.audio === "") {
          links.delete(link);
          json(response, 422, {
            error: `${resolved.extractor || "the site"} would not hand this server the media (often a sign-in or a bot check on a datacenter address). It plays in a browser instead.`,
          });
          return;
        }
        const started = await pullChannel(
          options.channels, options.ffprobe ?? ["ffprobe"], channelId, resolved.title, resolved.media,
          inputArgsFor(resolved.headers), resolved.audio,
        );
        if (!started) {
          json(response, 409, { error: "that link is already starting" });
          return;
        }
        options.channels.ephemeral(channelId);
        // Told to the directory now, so the room code arrives with the
        // channel rather than at the next heartbeat, ninety seconds on.
        void options.live?.announce?.();
      }
      json(response, 200, shownLink(channelId, resolved));
      return;
    }

    // The whole thing, to keep. The server fetches it through yt-dlp and
    // hands the bytes straight on as a download, so the person's own machine
    // ends up with the file and the server keeps nothing. A live stream has
    // no whole to hand over.
    if (path === "/api/links/download") {
      const link = playableLink(url.searchParams.get("url"));
      if (link === "") {
        json(response, 400, { error: "that is not a link this can fetch" });
        return;
      }
      if (!options.ytdlp || options.ytdlp.length === 0) {
        json(response, 503, { error: "this server has no yt-dlp to fetch with" });
        return;
      }
      const resolved = links.get(link) ?? await resolveLink(options.ytdlp, link, { cookies: options.cookies ?? "" });
      if ("error" in resolved) {
        json(response, 422, { error: resolved.error });
        return;
      }
      links.set(link, resolved);
      if (resolved.live) {
        json(response, 409, { error: "that is live; there is no whole file to download yet" });
        return;
      }
      const audioOnly = url.searchParams.get("audio") === "1" || !resolved.video;
      // Named for the format the download will actually take, which is not
      // always the one played: a track played from an HLS playlist is saved
      // as the plain MP3 the site also offers, and ".m4a" on an MP3 is a
      // file nothing will open.
      const saved = await resolveLink(options.ytdlp, link, { cookies: options.cookies ?? "", format: saveFormat(audioOnly) });
      const chosen = "error" in saved ? resolved : { ...resolved, ext: saved.ext || resolved.ext, media: saved.media, audio: saved.audio, headers: saved.headers };
      const fileName = fileNameFor(chosen, audioOnly);
      // A picture and a sound kept apart by the site are put together here
      // by ffmpeg, as they go: yt-dlp only merges into a file it can seek
      // in, which a pipe is not. Anything else yt-dlp hands over whole.
      const paired = !audioOnly && chosen.audio !== "";
      const [command, ...prefix] = (paired ? (options.ffmpeg ?? ["ffmpeg"]) : options.ytdlp) as [string, ...string[]];
      const child = spawn(
        command,
        [...prefix, ...(paired ? mergeDownloadArgs(chosen) : downloadArgs(link, audioOnly, options.cookies ?? ""))],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      response.writeHead(200, {
        "content-type": contentTypeFor(fileName),
        "content-disposition": `attachment; filename="${fileName.replace(/["\\]/g, "")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "cache-control": "no-store",
      });
      child.stdout?.pipe(response);
      let complaint = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (complaint.length < 20_000) complaint += chunk.toString("utf8");
      });
      child.on("error", () => response.end());
      child.on("close", (code) => {
        if (code !== 0) console.log(`  a download of ${link} failed: ${complaint.split("\n").filter((one) => one.startsWith("ERROR")).pop() ?? code}`);
        response.end();
      });
      // The person closed the tab: stop fetching what nobody will keep.
      response.on("close", () => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      return;
    }

    /**
     * A file on this server, on the air as a channel of its own.
     *
     * The same act as going live with a catalog entry, for a file in the
     * library: its own room, its own phone code, kept, remembered, listed.
     * It used to take over the server's one player, which a member must not
     * do and which made two files at once impossible for anybody. The owner
     * and any member may; the caps and the throttle above say how much.
     */
    const trackLive = /^\/api\/tracks\/(\d+)\/live$/.exec(path);
    if (trackLive && request.method === "POST") {
      if (!options.channels) {
        json(response, 503, { error: "this server cannot carry channels" });
        return;
      }
      const index = Number(trackLive[1]);
      const source = engine.trackPath(index);
      if (!source || isRemote(source)) {
        json(response, 404, { error: "no such file on this server" });
        return;
      }
      const name = engine.snapshot().tracks?.[index]?.title || source.split("/").pop() || `track ${index + 1}`;
      // Named for the file, so the same file is the same channel whoever asks.
      const channelId = cleanId(`file-${sha("sha1").update(source).digest("hex").slice(0, 12)}`);
      if (liveBy && !options.channels.has(channelId)) {
        const refusal = memberLiveRefusal(options.channels, liveBy);
        if (refusal) {
          json(response, 429, { error: refusal });
          return;
        }
      }
      if (!options.channels.has(channelId)) {
        const started = await pullChannel(options.channels, options.ffprobe ?? ["ffprobe"], channelId, name, source);
        if (!started) {
          json(response, 409, { error: "that file is already going on the air" });
          return;
        }
        if (liveBy) {
          const info = options.channels.info(channelId);
          if (info) info.startedBy = liveBy;
        }
      }
      options.channels.keep(channelId);
      options.rememberChannels?.(rememberedNow(options.channels));
      void options.live?.announce?.();
      json(response, 200, { channel: channelId, name });
      return;
    }

    // A channel is one publisher and everybody listening to them. Two or three
    // devices can publish at once, each to their own channel, and a listener
    // picks which to hear.
    if (path === "/api/channels" && options.channels) {
      // Without the source. Anyone holding the listen link may ask what is
      // on, and the address a channel is pulled from is the one thing about
      // it that is not theirs to have.
      json(response, 200, {
        channels: options.channels.list().map(({ source: _source, ...shown }) => shown),
        listeners: options.channels.listeners,
      });
      return;
    }

    // Publishing. Anyone with the control link may; listening to the result is
    // open to whoever has the share link, like the rest of the audio.
    if (path.startsWith("/api/channels/") && options.channels) {
      const channels = options.channels;
      const rest = path.slice("/api/channels/".length);
      const [rawId, action, file] = rest.split("/");
      const id = cleanId(rawId);
      const event = await eventForChannel();
      if (event) {
        const account = await options.accounts?.whoIs(tokenFrom(request.headers)) ?? null;
        if (request.method === "GET") {
          const invited = await options.events!.invitationAllows(event.id, url.searchParams.get("invite") ?? "");
          if (!(await options.events!.canAccess(event, account?.id)) && !invited) {
            json(response, 404, { error: "nothing is playing on that channel" });
            return;
          }
        } else if (!options.events!.canManage(event, account?.id)) {
          json(response, account ? 403 : 401, { error: account ? "only the event host can publish here" : "sign in to host this event" });
          return;
        } else if (request.method === "POST" &&
                   (action === undefined || action === "chunk") &&
                   event.status !== "live") {
          json(response, 409, { error: "start the event before publishing audio" });
          return;
        }
      }

      // The same channel as HLS: a playlist of short files, which is what
      // Safari on an iPhone plays live -- it will not take the endless MP4
      // below, and spun on it a few times before giving up. Packaged on
      // demand, copying the fragments the browser would have got.
      if (action === "hls" && request.method === "GET") {
        if (!options.hls) {
          json(response, 503, { error: "this server cannot package HLS" });
          return;
        }
        if (!channels.has(id)) {
          json(response, 404, { error: "nothing is playing on that channel" });
          return;
        }
        if (file === "index.m3u8") {
          // A channel carrying H.265 is cut into fMP4 rather than transport
          // segments: HLS in TS is defined for H.264 only, and Safari plays
          // an HEVC channel packaged as TS as sound over a black screen.
          const playlist = await options.hls.playlist(id, channels.info(id)?.emits === "hevc");
          if (playlist === null) {
            json(response, 503, { error: "that channel could not be packaged as HLS yet; try again in a moment" });
            return;
          }
          response.writeHead(200, {
            ...CORS,
            "content-type": "application/vnd.apple.mpegurl",
            "cache-control": "no-store",
          });
          // The key rides on every segment line: a browser drops the query
          // when it resolves a segment against the playlist.
          response.end(withKey(playlist, url.searchParams.get("k") ?? ""));
          return;
        }
        const segment = options.hls.segment(id, file ?? "");
        if (segment === "") {
          json(response, 404, { error: "no such segment" });
          return;
        }
        watch(request, response, "stream", id);
        response.writeHead(200, {
          ...CORS,
          "content-type": segmentType(file ?? ""),
          "cache-control": "no-store",
          "content-length": statSync(segment).size,
        });
        createReadStream(segment).pipe(response);
        return;
      }

      if (action === undefined && request.method === "GET") {
        // Listening. The response is the fan-out target: whatever ffmpeg
        // produces for this channel is written to it until one end goes away.
        if (!channels.has(id)) {
          json(response, 404, { error: "nothing is playing on that channel" });
          return;
        }
        watch(request, response, "stream", id);
        // Headers first, and then the listener.
        //
        // Attaching first was fine while a channel only ever wrote future
        // bytes. A video channel writes the opening boxes to a new listener
        // the moment it joins, and those went out before this response had
        // any headers at all -- so it committed as a bare 200 with no
        // content-type, ended immediately, and the picture was one kilobyte
        // long. Whether it happened depended on whether ffmpeg had produced
        // its header yet, which is why it looked intermittent.
        response.writeHead(200, {
          ...CORS,
          // Asked of the channel rather than assumed: a channel carrying
          // pictures that calls itself audio/mpeg plays as nothing at all.
          "content-type": channels.contentType(id),
          "cache-control": "no-store",
        });
        const detach = channels.listen(id, response);
        if (detach === null) {
          response.end();
          return;
        }
        const leave = (): void => detach();
        request.on("close", leave);
        response.on("close", leave);
        return;
      }

      if (action === undefined && request.method === "DELETE") {
        // Asked once: the second call would answer false, having just stopped
        // the thing it was asking about.
        // A member takes off what they put on, and nothing else.
        if (liveBy && channels.info(id)?.startedBy !== liveBy) {
          json(response, 403, { error: "that stream is not yours to take off" });
          return;
        }
        const stopped = channels.stop(id);
        // Taken off on purpose is forgotten on purpose: it must not come back
        // at the next restart.
        if (stopped) {
          options.rememberChannels?.(rememberedNow(channels));
          // Off the air is news too: told now, so the directory drops it
          // rather than listing it until the next heartbeat.
          void options.live?.announce?.();
          if (event && event.status === "live") {
            await options.events?.transition(event.id, event.ownerId, "ended", event.version).catch(() => undefined);
          }
        }
        json(response, stopped ? 200 : 404, { ok: stopped });
        return;
      }

      if (request.method !== "POST") {
        json(response, 405, { error: "GET, POST or DELETE" });
        return;
      }

      /**
       * Dial the source again, now.
       *
       * The thing an administrator reaches for when a channel says it is on
       * the air and shows nobody anything. It is what fixed CNN by hand --
       * take it off, put it back -- without having to know the source, which
       * a browser is never told.
       */
      if (action === "restart") {
        if (!channels.has(id)) {
          json(response, 404, { error: "nothing is playing on that channel" });
          return;
        }
        if (!channels.pulled(id)) {
          json(response, 409, { error: "that channel is published into this server; restart it at the publisher" });
          return;
        }
        const restarted = channels.restart(id);
        json(response, restarted ? 200 : 409, { ok: restarted });
        return;
      }

      /*
       * Keep a channel that was started on demand. Something being watched
       * from a catalog stops a minute after its last viewer leaves; going
       * live with it is asking it not to, and asking the directory to list
       * it now.
       */
      if (action === "keep") {
        if (!channels.has(id)) {
          json(response, 404, { error: "nothing is playing on that channel" });
          return;
        }
        // Keeping something started on demand is putting it on the air: for
        // a member, counted and marked like anything else they put on.
        if (liveBy) {
          const info = channels.info(id);
          if (info && !info.startedBy && !channels.isEphemeral(id)) {
            json(response, 403, { error: "that stream is the owner's" });
            return;
          }
          if (info && !info.startedBy) {
            const refusal = memberLiveRefusal(channels, liveBy);
            if (refusal) {
              json(response, 429, { error: refusal });
              return;
            }
            info.startedBy = liveBy;
          }
        }
        channels.keep(id);
        options.rememberChannels?.(rememberedNow(channels));
        void options.live?.announce?.();
        json(response, 200, { ok: true });
        return;
      }

      /**
       * Carry a source of our own, rather than waiting to be sent one.
       *
       * A re-stream used to be added to the playlist, where it became one
       * more track -- and a server plays one track at a time, so the second
       * channel you added sat there saying "stopped". Two channels are two
       * processes with two audiences and two addresses, which is what lets
       * one person watch the baseball while another watches the news, in two
       * tabs or in two panels of the same multiview.
       */
      if (action === "pull") {
        let source = "";
        let called = "";
        try {
          const body = JSON.parse(await readBody(request)) as {
            source?: unknown; name?: unknown; at?: unknown;
          };
          called = String(body.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
          // A track number rather than a path: it is the server's own library
          // either way, and a number cannot name a file outside it.
          if (typeof body.at === "number" && Number.isInteger(body.at) && body.at >= 0) {
            source = engine.trackPath(body.at) ?? "";
            if (source === "") {
              json(response, 404, { error: "no track there" });
              return;
            }
          } else {
            source = String(body.source ?? "").trim();
          }
        } catch {
          json(response, 400, { error: "bad JSON" });
          return;
        }
        if (source === "") {
          json(response, 400, { error: "give a URL to carry, or a track to show" });
          return;
        }

        const wanted = cleanId(rawId, generatedId());
        if (channels.has(wanted)) {
          json(response, 409, { error: "that channel is already on" });
          return;
        }

        const channel = await pullChannel(channels, options.ffprobe ?? ["ffprobe"], wanted, called, source);
        if (!channel) {
          json(response, 409, { error: "that channel is already on" });
          return;
        }
        // Written down, so a restart puts it back on the air.
        options.rememberChannels?.(rememberedNow(channels));
        json(response, 200, { ok: true, channel: channel.info });
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
    // Going live, and coming back off. Admin-gated by ADMIN_PATHS, because
    // listing somebody's machine in a public directory is not a thing a
    // listener gets to do.
    if (path === "/api/live/state") {
      if (!options.live) {
        json(response, 200, { live: false, possible: false, code: "", name: "", url: "" });
        return;
      }
      json(response, 200, options.live.status());
      return;
    }

    if (path === "/api/live/start" || path === "/api/live/stop") {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      if (!options.live) {
        json(response, 409, { error: "this nixamp cannot be listed; it has no address the world can reach" });
        return;
      }
      if (path === "/api/live/stop") {
        await options.live.stop();
        json(response, 200, options.live.status());
        return;
      }
      const started = await options.live.start();
      json(response, started.error ? 502 : 200, started);
      return;
    }

    if (path === "/api/connections") {
      json(response, 200, {
        connections: tracker.list(),
        active: tracker.active,
        startedAt: started,
        now: Date.now(),
        // Where to point OBS. Printed at startup since RTMP was added, which
        // is no use at all to somebody looking at the admin panel a day later.
        publish: options.publishUrls?.() ?? [],
        // And which of those slots somebody is already on, because the
        // question you have in front of three addresses is which one is free.
        channels: options.channels?.list().map(({ id, name, via }) => ({ id, name, via })) ?? [],
        // What this server's own library is, and whether it is loaded, so
        // there can be a way back to it that is not retyping a path.
        home: options.homeSource ?? "",
        root: engine.snapshot(false).root,
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

    // Take an added source back out of the playlist. The library it was added
    // to is untouched -- there is no group name that names it.
    if (path === "/api/source/remove") {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      let group = "";
      try {
        group = String((JSON.parse(await readBody(request)) as { group?: unknown }).group ?? "");
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      if (!group) {
        json(response, 400, { error: "no group given" });
        return;
      }
      const removed = engine.drop(group);
      if (removed === 0) {
        json(response, 404, { error: `nothing here came from ${group}` });
        return;
      }
      json(response, 200, { ...engine.snapshot(), removed, groups: engine.groups() });
      return;
    }

    // Hand the running server another source. The listeners stay connected;
    // by default they get more to listen to, and only an explicit `replace`
    // swaps what this server is for something else.
    if (path === "/api/source") {
      if (request.method !== "POST") {
        json(response, 405, { error: "POST only" });
        return;
      }
      let source = "";
      let called = "";
      let replacing = false;
      try {
        const body = JSON.parse(await readBody(request)) as {
          source?: unknown; replace?: unknown; name?: unknown;
        };
        source = String(body.source ?? "");
        // Trimmed and capped: it is a label, and it can end up in a listing.
        called = String(body.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
        // Adding is what somebody means by putting a folder in a box, so it is
        // the default. Replacing is the much larger claim that this server now
        // serves that instead, so it is the one you have to ask for.
        replacing = body.replace === true;
      } catch {
        json(response, 400, { error: "bad JSON" });
        return;
      }
      if (!source) {
        json(response, 400, { error: "no source given" });
        return;
      }
      try {
        let tracks: Loaded[] = await options.load(source);
        if (tracks.length === 0) {
          json(response, 422, { error: `nothing to play at ${source}` });
          return;
        }
        // A handful of addresses whose names say nothing get asked what they
        // are, so a live channel arrives as a picture rather than as its own
        // soundtrack. Capped, because a playlist of five thousand of them is
        // five thousand ffprobes and the answer only matters for the few a
        // person adds by hand.
        const looked = await Promise.all(
          tracks.map(async (track, at) => {
            if (at >= PROBE_BY_HAND || !nameSaysNothing(track.path)) return track;
            const codecs = await codecsOf(
              { ffmpeg: [], ffprobe: options.ffprobe ?? ["ffprobe"], play: null },
              track.path,
            );
            return codecs.video === "" ? track : { ...track, picture: true };
          }),
        );
        tracks = looked;

        // Named by hand, so a single channel says what it is rather than what
        // its URL ends in.
        if (called !== "" && tracks.length === 1 && tracks[0]) {
          tracks = [{ ...tracks[0], title: called, named: true }];
        }

        let added = tracks.length;
        if (replacing) {
          engine.replace(tracks, source);
        } else {
          added = engine.add(tracks, source, called);
          if (added === 0) {
            // Everything there was already here. Not an error -- the playlist
            // is exactly what the caller asked for -- but worth saying, so a
            // client can tell that apart from having added an album.
            json(response, 200, { ...engine.snapshot(), added: 0, groups: engine.groups() });
            return;
          }
        }
        // Names now, tags later, here as much as at startup: loading a
        // directory of five thousand files used to read every tag before it
        // answered, with the event loop held the whole time.
        if (options.tag) {
          void options
            .tag(source)
            .then((tagged) => engine.retag(tagged, source))
            .catch(() => {});
        }
        json(response, 200, { ...engine.snapshot(), added, replaced: replacing, groups: engine.groups() });
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
      // Whether this browser decodes H.265, which only it can know: Safari and
      // televisions do, Chrome on a desktop does not and says nothing when
      // handed it. Copying a 4K HEVC film is free; re-encoding one does not
      // keep up with playing it, so the answer is worth carrying in the URL.
      const allowHevc = url.searchParams.get("hevc") === "1";

      if (playsInBrowser(file) && capKbps === 0) {
        sendFile(request, response, file);
        return;
      }
      // A film, or something whose name refuses to say. A live channel at
      // .../301 used to fall through to the audio branch and arrive as MP3
      // with `-vn` -- a match you could only listen to.
      if (hasPicture(file) || nameSaysNothing(file)) {
        // What ffprobe finds inside decides how little work it takes to keep
        // the picture, and whether there is a picture to keep at all.
        const codecs = await codecsOf({ ffmpeg: [], ffprobe: options.ffprobe ?? ["ffprobe"], play: null }, file);
        if (codecs.video !== "") {
          // Told back to the playlist, so an entry that was added before this
          // could be asked stops claiming to be a song. Without it a track
          // added by an older nixamp goes to an audio element for ever, and
          // the only cure is noticing and adding it again.
          engine.sawPicture(index);
          pipeFfmpeg(
            request, response, file, options.ffmpeg ?? ["ffmpeg"],
            videoArgs(codecs, capKbps, { allowHevc }), "video/mp4",
            transportInputArgs(file, codecs.container),
          );
          return;
        }
      }
      transcode(request, response, file, options.ffmpeg ?? ["ffmpeg"]);
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
      await liveAudio(
        request,
        response,
        engine,
        options.ffmpeg ?? ["ffmpeg"],
        options.ffprobe ?? ["ffprobe"],
      );
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
        if (file.endsWith("index.html") && path.startsWith("/live/") && options.events) {
          try {
            const slug = decodeURIComponent(path.slice("/live/".length).replace(/\/$/, ""));
            const event = await options.events.get(slug);
            const account = await options.accounts?.whoIs(tokenFrom(request.headers)) ?? null;
            const invited = event
              ? await options.events.invitationAllows(event.id, url.searchParams.get("invite") ?? "")
              : false;
            if (event && (await options.events.canAccess(event, account?.id) || invited)) {
              const shell = readIfPossible(file);
              if (shell !== null) {
                html(response, 200, eventDocument(shell, event, options.invites?.site ?? "https://backtoschool.help"));
                return;
              }
            }
          } catch {}
        }
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
/**
 * The server's own output, as one address that keeps playing.
 *
 * This is the watch party: everybody pointed at it hears and sees whatever the
 * server is playing, and somebody joining halfway through joins halfway
 * through rather than starting the film again on their own.
 *
 * A film comes with its picture. It used to be `-vn` and MP3 whatever it was,
 * so inviting people to watch a film got them its soundtrack -- which is not
 * an invitation anybody wants. The container is decided when the connection
 * opens, because a response has one content type and MP4 and MP3 cannot be
 * spliced; going from a film to a song ends the stream, and a client that
 * wants to keep listening asks again and gets the right one.
 */
async function liveAudio(
  request: IncomingMessage,
  response: ServerResponse,
  engine: Engine,
  ffmpeg: string[],
  ffprobe: string[],
): Promise<void> {
  const [command, ...prefix] = ffmpeg as [string, ...string[]];

  /** Whether this track is something to watch rather than only to hear. */
  const looksLikeVideo = async (source: string): Promise<boolean> => {
    if (hasPicture(source)) return true;
    if (!nameSaysNothing(source)) return false;
    const codecs = await codecsOf({ ffmpeg: [], ffprobe, play: null }, source);
    return codecs.video !== "";
  };

  const first = engine.trackPath(engine.snapshot().index);
  const asVideo = first === undefined ? false : await looksLikeVideo(first);
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
      "content-type": asVideo ? "video/mp4" : "audio/mpeg",
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
    // Joined where the server is, not where the track begins. Somebody
    // arriving forty minutes into a film should arrive forty minutes in;
    // starting it again for them is not a watch party, it is two people
    // watching the same film separately.
    //
    // Before -i, so ffmpeg seeks rather than decoding its way there.
    const from = Math.max(0, Math.floor(snapshot.position));
    const spawned = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel", "error",
        ...(isRemote(source) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []),
        // A live source has no beginning to seek from.
        ...(from > 1 && !isRemote(source) ? ["-ss", String(from)] : []),
        "-re",
        "-i", source,
        ...(asVideo
          // Copied where it can be, because a room full of viewers is a room
          // full of encoders otherwise.
          ? ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
             "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"]
          : ["-vn", "-f", "mp3", "-b:a", "192k"]),
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
    if (closed || child !== null) return;
    if (engine.snapshot().index === playing) return;
    // The kind changed under us -- a film after a song, or the other way --
    // and one response cannot carry both. Ending it is how the client is told
    // to ask again, which it does.
    const source = engine.trackPath(engine.snapshot().index);
    if (source !== undefined) {
      void looksLikeVideo(source).then((wants) => {
        if (closed) return;
        if (wants !== asVideo) stop();
        else next();
      });
      return;
    }
    next();
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
  /**
   * What to say before the input is opened. A transport stream needs telling
   * how far to read before it decides what is in it, and to make up the
   * timestamps a recording cut mid-stream does not have.
   */
  inputArgs: string[] = [],
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
      ...inputArgs,
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
  // `end: false`, because a pipe that closes the response also commits its
  // headers -- and ffmpeg failing instantly ends stdout without ever writing a
  // byte. The response would go out as an empty 200, and the close handler
  // below would then try to send a 502 over it and throw
  // ERR_HTTP_HEADERS_SENT from a child-process callback, which is not a place
  // an exception can be caught: it killed the whole server. A URL that ffmpeg
  // cannot read is an ordinary thing for a person to paste, and it took every
  // listener down with it.
  child.stdout.pipe(response, { end: false });

  child.on("error", (error) => {
    console.error(`nixamp: ffmpeg could not start: ${error.message}`);
    if (!response.headersSent) json(response, 500, { error: "ffmpeg could not start" });
    else if (!response.writableEnded) response.end();
  });
  child.on("close", (code) => {
    const message = failed.trim();
    if (code !== 0 && code !== null) console.error(`nixamp: ffmpeg exited ${code}: ${message}`);
    // Asked of the response rather than of our own flag: the truth about
    // whether a status can still be sent belongs to the response.
    if (!started && !response.headersSent) {
      // Nothing was ever produced, so the status can still tell the truth.
      json(response, 502, { error: "could not decode that source", detail: message.split("\n").pop() ?? "" });
      return;
    }
    if (!response.writableEnded) response.end();
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
  // Told which folder, or the one that was saved. Never the directory this
  // happens to be running in: a daemon restarted from a home directory served
  // the home directory, keys and all, under a public listing.
  const chosen = options.root || readLibrary();
  if (!chosen) {
    throw new Error(
      "nixamp serve: which folder? Say `nixamp library ~/Music` once, or `nixamp daemon start ~/Music`.",
    );
  }
  const root = isRemote(chosen) ? chosen : resolve(chosen);
  const why = isRemote(root) ? "" : forbiddenLibrary(root);
  if (why) {
    throw new Error(`nixamp will not serve ${why}. Pick a folder with your media in it: nixamp library ~/Music`);
  }
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
  // Empty on purpose. The walk happens below, once the port is open: it is
  // the slowest part of starting and nothing about it needs to happen first.
  const engine = new PlayerEngine([], root, tools);

  // A serving machine with speakers is still a player. A headless one has no
  // ffplay, and playJingle answers that by doing nothing.
  if (!options.noJingle) playJingle(tools);

  const web = options.web !== null ? resolve(options.web) : defaultWebDir();
  // The same keys this port used last time, so a link somebody was given
  // still works after a restart -- and a server is restarted to pick up a new
  // version, which is to say often. `--new-key` mints a fresh pair and forgets
  // the old one, which is the way to revoke a link that got out.
  const remembered = options.key ? rememberedKeys(stateDir(), options.port, options.newKey) : null;
  const key = remembered?.key ?? null;
  // Kept whether or not it is published, so `nixamp admin` and the operator
  // both have a link they can hand out without handing over the controls.
  const listenKey = remembered?.listenKey ?? null;
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
  // Channels as HLS, on demand, for Safari on a phone: one ffmpeg copying a
  // channel's fragments into short files while somebody is asking for them.
  // What things are, from nichedb.dev, remembered beside the keys so a
  // library is asked about once across restarts.
  const enricher = new Enricher({
    site: process.env["NIXAMP_NICHEDB"] || NICHEDB,
    cacheFile: join(stateDir(), "enrich.json"),
    onEvent: (message) => console.log(message),
  });
  const hls = new HlsPackagers({
    ffmpeg: tools.ffmpeg,
    listen: (id, listener) => channels.listen(id, listener),
    onEvent: (message) => console.log(message),
  });

  // The channels this server was carrying when it was last stopped, put back
  // on. A server is restarted to pick up a new version, which is often, and
  // every restart used to take CNN off the air until somebody noticed.
  const remembering = (list: RememberedChannel[]): void => rememberChannels(stateDir(), options.port, list);
  for (const one of rememberedChannels(stateDir(), options.port)) {
    const where = one.position && !one.live ? `, from ${Math.floor(one.position / 60)}m${Math.floor(one.position % 60)}s` : "";
    console.log(`  Putting "${one.id}" (${one.name}) back on the air${where}.`);
    // With what was written down about it: what it holds, so the source is
    // not asked again, and where it had got to, so a film carries on.
    void pullChannel(channels, tools.ffprobe, one.id, one.name, one.source, [], "", {
      ...(one.kind ? { kind: one.kind } : {}),
      ...(one.codecs ? { codecs: one.codecs } : {}),
      ...(one.position !== undefined ? { position: one.position } : {}),
      ...(one.live !== undefined ? { live: one.live } : {}),
    }).then((channel) => {
      if (!channel) console.log(`  "${one.id}" is already on.`);
    });
  }
  // Where each film has got to, written down every so often, so a restart
  // picks it up from about there rather than from the start. Only when it
  // has changed: a server carrying nothing but live television writes
  // nothing.
  let lastRemembered = "";
  setInterval(() => {
    const now = rememberedNow(channels);
    if (!now.some((one) => one.position !== undefined)) return;
    const text = JSON.stringify(now);
    if (text === lastRemembered) return;
    lastRemembered = text;
    remembering(now);
  }, REMEMBER_EVERY_MS).unref();

  // The m3u catalogs kept here: read from disk now, and any that were never
  // read are fetched in the background so browsing does not wait on a provider.
  const catalogs = new Catalogs(stateDir(), options.port);
  catalogs.load();
  void catalogs.warm().catch(() => undefined);

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
  const favorites = pool ? new Favorites(pool) : undefined;
  const events = pool ? new LiveEvents(pool) : undefined;
  const layouts = pool ? new Layouts(pool) : undefined;
  const rooms = pool ? new Rooms(pool) : undefined;

  // Names and certificates for signed-in servers, and the rate limit over
  // everything. All of it is nixamp.com's business: the DNS keys live only
  // here, the certificates are issued here, and a personal nixamp has neither
  // a database nor strangers to meter. Without the registrar's keys the names
  // are simply not offered, rather than written into a zone that does not
  // exist.
  const zoneName = (() => {
    try {
      return new URL(process.env["NIXAMP_SITE"] ?? DEFAULT_DIRECTORY).hostname;
    } catch {
      return "nixamp.com";
    }
  })();
  const porkbunKey = process.env["PORKBUN_API_KEY"] ?? "";
  const porkbunSecret = process.env["PORKBUN_SECRET_API_KEY"] ?? "";
  const zone: DnsZone | null = porkbunKey && porkbunSecret ? new Porkbun(zoneName, porkbunKey, porkbunSecret) : null;
  const names = pool && zone ? new Names(pool, zone) : undefined;
  let certs: Certs | undefined;
  if (pool && zone) {
    const issuer = new AcmeIssuer({
      directoryUrl: process.env["NIXAMP_ACME_DIRECTORY"] ?? "https://acme-v02.api.letsencrypt.org/directory",
      email: process.env["NIXAMP_ACME_EMAIL"] ?? `hostmaster@${zoneName}`,
      // The key is kept by the store, so the issuer asks for it each time
      // rather than holding one that a second instance would not share.
      accountKey: () => (certs as Certs).accountKey(),
    });
    certs = new Certs(pool, zone, issuer, { log: (line) => console.log(`  ${line}`) });
  }
  const throttle = pool
    ? createThrottle({
        rules: [
          // Sign-in stays address-bucketed however the request is dressed, or
          // a guess with an Authorization header buys itself the bigger budget.
          { path: "/api/v1/auth/", limit: 20, credential: false },
          { path: "/api/v1/dns/", limit: 30 },
          // A text costs money and lands on a phone: ten a minute is plenty.
          { path: "/api/v1/invite", limit: 10 },
          { path: "/api/v1/dns", limit: 30 },
          { path: "/api/v1/certs", limit: 30 },
          { path: "/api/health", open: true },
          { path: "/api/directory", limit: 120 },
        ],
        // A signed-in browser carries its session as a cookie, and is a
        // credential the same as a bearer token: a person on a dashboard is
        // not an anonymous scraper.
        credentialFrom: (request) =>
          presentedCredential(request.headers) ?? (tokenFrom(Object.fromEntries(request.headers)) || null),
      })
    : undefined;
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
  let tls: { cert: string; key: string } | undefined = options.tlsCert
    ? (() => {
        try {
          return { cert: readFileSync(options.tlsCert, "utf8"), key: readFileSync(options.tlsKey, "utf8") };
        } catch (error) {
          throw new Error(`nixamp serve: could not read the certificate: ${(error as Error).message}`);
        }
      })()
    : undefined;

  // A signed-in server names itself.
  //
  // Nothing about DNS or certificates reaches this machine: it asks nixamp.com
  // for `<label>.<handle>.<zone>` pointing at the address it is calling from,
  // and for the handle's wildcard certificate, and serves https under that
  // name. The registrar's keys stay on nixamp.com. Skipped when the operator
  // named or certified the server by hand, when it listens on one interface
  // only, or with --no-name.
  let certExpiresAt = 0;
  let namedHost = "";
  const namedSession = readSession();
  if (
    !options.noName && !options.publicUrl && !options.tlsCert &&
    (options.host === "0.0.0.0" || options.host === "::") && namedSession?.token
  ) {
    const say = (line: string): void => console.log(`  ${line}`);
    const named = await claimName(namedSession.site, namedSession.token, labelFor(options.name, hostname()), say);
    if (named) {
      namedHost = named.host;
      // The certificate is the handle's, so the cache is keyed by the handle's
      // wildcard rather than by this machine's label.
      const wildcard = `*.${named.host.split(".").slice(1).join(".")}`;
      let files = readCertFiles(stateDir(), wildcard);
      if (!files) {
        const got = await fetchCert(namedSession.site, namedSession.token, {}, say);
        if (got) {
          writeCertFiles(stateDir(), got);
          files = { cert: got.cert, key: got.key, expiresAt: got.expiresAt };
        }
      }
      if (files) {
        tls = { cert: files.cert, key: files.key };
        certExpiresAt = files.expiresAt;
      }
      options.publicUrl = `${tls ? "https" : "http"}://${named.host}:${options.port}`;
      console.log(`  This server is ${named.host}${tls ? "" : " -- no certificate yet, so http for now"}.`);
    }
  }

  // Filled in below, when the RTMP listeners are opened. Read through a
  // function so the handler sees the list rather than the empty array it was
  // built with.
  let publishUrls: { id: string; url: string }[] = [];

  // Declared up here, not beside the publishing below: the port opens before
  // that code runs, so an admin asking to go live in the first moments would
  // otherwise reach a binding that has not been initialised.
  let publisher: Publisher | null = null;
  let listing: Listing | null = null;
  let publishable_: { label: string; url: string } | undefined;

  const server = createServer(engine, {
    web,
    media: options.media,
    owner,
    channels,
    rememberChannels: remembering,
    catalogs,
    publishUrls: () => publishUrls,
    serverName: options.name || hostname(),
    homeSource: root,
    live: {
      status: () => ({
        live: publisher !== null,
        code: listing?.code ?? "",
        channelCodes: listing?.channelCodes ?? {},
        name: listing?.name ?? (options.name || hostname()),
        url: listing?.url ?? (publishable_ ? shareLink(publishable_.url, listenKey, false) : ""),
        // Whether going live is even possible here. A laptop behind a router
        // with no address the world can reach cannot be listed, and a button
        // that could only fail is worse than one that is not offered.
        possible: publishable_ !== undefined,
      }),
      start: async () => {
        if (publisher === null) publisher = makePublisher();
        if (publisher === null) {
          return { live: false, code: "", name: "", url: "", error: "this machine has no address the world can reach" };
        }
        const first = await publisher.start();
        if (first === null) {
          // Nothing was listed, so nothing should claim to be: a publisher
          // left running here would heartbeat at a directory that refused it.
          await publisher.stop();
          publisher = null;
          return {
            live: false, code: "", name: "", url: "",
            error: `${DEFAULT_DIRECTORY} would not list this stream. Run \`nixamp login\` on that machine.`,
          };
        }
        listing = first;
        return { live: true, code: first.code, name: first.name, url: first.url };
      },
      stop: async () => {
        await publisher?.stop();
        publisher = null;
        listing = null;
      },
      announce: async () => {
        if (publisher === null) return;
        const renewed = await publisher.announce();
        if (renewed) listing = renewed;
      },
    },
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
    // For a pasted link: where its media is, and the whole of it to keep.
    // A cookie jar beside the state, when the operator has put one there,
    // for the sites that will not talk to a datacenter without one.
    ytdlp: tools.ytdlp ?? null,
    cookies: cookiesFile(),
    hls,
    enricher,
    ...(tls ? { tls } : {}),
    // Untagged, so a directory of five thousand files answers at once; the
    // tags follow through `tag` below.
    load: (next) => loadSource(tools, next, false),
    tag: (next) => loadTagged(tools, next),
    ...(directory ? { directory } : {}),
    ...(follows ? { follows, vapidPublicKey } : {}),
    ...(favorites ? { favorites } : {}),
    ...(events ? { events } : {}),
    ...(layouts ? { layouts } : {}),
    ...(rooms ? { rooms } : {}),
    // Invites go out the same way follow notifications do, and only from a
    // site that has somebody to send them for.
    ...(pool
      ? {
          invites: {
            site: (process.env["NIXAMP_SITE"] ?? DEFAULT_DIRECTORY).replace(/\/+$/, ""),
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
          },
        }
      : {}),
    ...(names ? { names } : {}),
    ...(certs ? { certs } : {}),
    dnsZone: zoneName,
    ...(throttle ? { throttle } : {}),
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
          ...(pool
            ? { servers: new Servers(pool), handles: new Handles(pool), openDirs: new OpenDirs(pool) }
            : {}),
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

  // A named server keeps its certificate fresh without a restart: once a day
  // it asks for the handle's certificate again and, when a newer one has been
  // issued, swaps it into the running listener.
  if (namedHost && namedSession?.token) {
    const renew = setInterval(() => {
      void fetchCert(namedSession.site, namedSession.token, { waitMs: 0 }, () => undefined).then((got) => {
        if (!got || got.expiresAt <= certExpiresAt) return;
        writeCertFiles(stateDir(), got);
        certExpiresAt = got.expiresAt;
        const secure = server as unknown as { setSecureContext?: (context: { cert: string; key: string }) => void };
        secure.setSecureContext?.({ cert: got.cert, key: got.key });
        console.log(`  Renewed the certificate for ${namedHost}.`);
      });
    }, 24 * 60 * 60 * 1000);
    renew.unref();
  }

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
        // The other half of the pair. Without it `nixamp admin` can only draw
        // the links that administer, so the operator has nothing to hand
        // somebody who should be able to watch and not to drive.
        listenKey,
        source: root,
        urls: addresses,
        firewall,
        guessedPublic: guessedPublic !== "",
      }),
    );
  }

  // Names now, tags later, and both after the door is open. Not awaited:
  // nothing below needs the library, and a directory that takes a minute to
  // walk should cost nobody a minute of not being able to connect.
  void loadSource(tools, root, false)
    .then((found) => {
      engine.fill(found, root);
      if (found.length === 0) {
        console.log(`nixamp serve — no audio files under ${root}`);
        return;
      }
      console.log(`nixamp serve — ${found.length} tracks under ${root}`);
      if (isRemote(root)) return;
      // Handed the files we already found. Tagging used to walk the whole
      // library a second time to discover the same paths, and that second walk
      // was the one that ran with the port already open.
      return loadTagged(tools, root, probeAsync, found.map((track) => track.path))
        .then((tagged) => engine.retag(tagged, root))
        .catch(() => {
          // Filenames are a working player. A failure here is worth nothing
          // but titles that stay as they are.
        });
    })
    .catch((error: unknown) => {
      console.log(`nixamp: could not read ${root}: ${(error as Error).message}`);
    });

  console.log(`nixamp serve — reading ${root}`);
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
        console.log(`    ${shareLink(url, listenKey, false)}`);
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

    publishUrls = slots.map((slot) => ({
      id: slot.id,
      url: `rtmp://${host}:${slot.port}/live/${listenKey ?? "live"}`,
    }));

    console.log("  Or publish from OBS, Larix or ffmpeg, one per URL:");
    for (const entry of publishUrls) {
      console.log(`    ${entry.url}   -> "${entry.id}"`);
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
  // Never a bare IP over https: a certificate is issued for a name, so a
  // listing pointing at one is a listing nobody can open.
  publishable_ = addresses.find((a) => a.label === "on the internet" && certifiable(a.url))
    ?? addresses.find((a) => a.label === "on tailscale" && certifiable(a.url))
    ?? addresses.find((a) => a.label === "on the internet")
    ?? addresses.find((a) => a.label === "on tailscale");

  /**
   * Make a publisher for this server. Called at startup when the operator says
   * yes, and again whenever somebody goes live from the admin panel.
   *
   * A declaration rather than an assignment, so it exists from the moment the
   * function is entered -- the port is open well before this line is reached.
   */
  function makePublisher(): Publisher | null {
    if (!publishable_) return null;
    const listen = shareLink(publishable_.url, listenKey, false);
    // Announced next to the listen link, not instead of it: one is for a person
    // with a browser, the other for the phone line and anything else that is
    // handed one address and expected to play it.
    const audio = audioLink(publishable_.url, listenKey);
    return new Publisher({
        directory: DEFAULT_DIRECTORY,
        name: options.name || hostname(),
        url: listen,
        audio,
        // The control link, for the owner to open this machine as its
        // administrator from the directory. The directory shows it to the
        // owning account and strips it for everyone else.
        ...(key ? { admin: shareLink(publishable_.url, key) } : {}),
        // Asked at every heartbeat rather than once, because the library is
        // read after the port opens and is still arriving when this is made.
        tracks: () => engine.snapshot(false).trackCount,
        // What a visitor would find here: whether the player is running, and
        // which channels are on. A directory row that says "5,717 files,
        // live: CNN" is one somebody can decide about; "5717 tracks" was not.
        playing: () => engine.snapshot(false).playing,
        channels: () => channels.list().map((one) => one.name),
        // From `nixamp login`. The directory will not list a stream it cannot
        // attribute to somebody, because a listing is now a phone code that
        // costs money to answer.
        ...(session?.token ? { token: session.token } : {}),
        onRefused: () => {
          console.log("");
          console.log("  nixamp.com would not list this stream: it needs an account.");
          console.log("  Run `nixamp login` (or `nixamp signup`) and start again.");
        },
        // Every heartbeat, so the code this server shows is the code the
        // phone line knows, whatever the directory has forgotten meanwhile.
        onListed: (fresh) => {
          if (listing && listing.code !== fresh.code) {
            console.log(`  nixamp.com listed this stream again; the phone code is now ${fresh.code}.`);
          }
          listing = fresh;
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
  }

  if (options.publish !== "no" && publishable_) {
    const listen = shareLink(publishable_.url, listenKey, false);
    // Listed unless told otherwise.
    //
    // It used to ask, and a daemon has nobody to ask -- so a server started in
    // the background was never listed, which meant nobody could find it, which
    // meant it could not be paid for either. A stream that nobody can find is
    // not a stream. What is published is the listening link, never the one
    // that drives, and `--no-publish` is there for a server that should not be
    // public at all.
    //
    // Still asked when a person is at the terminal to answer, because that is
    // somebody who can say no.
    const wanted = options.publish === "yes" || !process.stdin.isTTY
      ? true
      : await confirm(`\n  List this stream at ${DEFAULT_DIRECTORY}/directory so anyone can find it?\n  It publishes ${listen} — listen only, not the controls.`);

    if (wanted) {
      publisher = makePublisher();
      listing = (await publisher?.start()) ?? null;
      console.log("");
      console.log(listing
        ? `  Listed at ${DEFAULT_DIRECTORY}/directory as "${listing.name}". It leaves the list when this stops.`
        : `  Could not reach ${DEFAULT_DIRECTORY}; not listed.`);
    }
  } else if (options.publish === "yes" && !publishable_) {
    console.log("");
    console.log("  --publish needs an address the world can reach. This machine has none.");
  }

  // Remember this machine on the account it belongs to, without being asked.
  //
  // `nixamp server add --here` existed and did exactly this, which is a manual
  // step for something the daemon already knows: it has just worked out its
  // own address and minted its own key, and the session file says whose it is.
  // Somebody who has signed in on this machine has said which account it is;
  // being on their list is what they meant by that.
  //
  // Idempotent: adding the same URL again updates the row rather than making
  // a second one, so this is safe on every start. Silent about failure, since
  // nothing here is worth stopping a player for.
  if (session?.token && publishable_) {
    const remembered = shareLink(publishable_.url, key);
    void fetch(`${DEFAULT_DIRECTORY}/api/v1/servers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ url: publishable_.url, name: options.name || hostname(), key: key ?? "" }),
    })
      .then((answer) => {
        if (answer.ok) console.log(`  Remembered on your account at ${DEFAULT_DIRECTORY}.`);
      })
      .catch(() => {
        // The directory being unreachable is not a reason to stop serving.
      });
    void remembered;
  }

  // A last resort, not a licence.
  //
  // Every throw reachable from a request should be caught where it happens,
  // and one that is not is a bug worth fixing. But the alternative to catching
  // it here is that node prints a stack and exits -- and a music server
  // exiting drops every listener, forgets what was added, and leaves ffmpeg
  // children behind. That happened twice from one bad URL. Whatever is wrong
  // with one response, everybody else is still listening.
  process.on("uncaughtException", (error) => {
    console.error(`nixamp: kept going after an unexpected error: ${error.stack ?? error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`nixamp: kept going after an unhandled rejection: ${String(reason)}`);
  });

  const shutdown = (): void => {
    rtmp?.stop();
    enricher.save();
    hls.stopAll();
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

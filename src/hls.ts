/**
 * A channel as HLS, for the browsers that will not take it any other way.
 *
 * A channel is sent as one endless fragmented MP4 down a chunked response,
 * which Chrome and Firefox play as they would a file. Safari on an iPhone
 * will not: it asks for a byte range, gets a stream with no length, and gives
 * up before the first picture -- a spinner that flashes and a player that
 * never starts. What Safari plays live is HLS, a playlist of short files.
 *
 * So this packages the same bytes into HLS on demand: one ffmpeg per channel,
 * copying (never re-encoding) the fragments it is fed into two-second
 * MPEG-TS segments in a temporary directory, started when the first playlist
 * is asked for and stopped a minute after the last. The channel itself is
 * untouched; this is one more listener on it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Seconds of video per segment. Short, so joining is quick; long enough that a playlist is not churn. */
export const SEGMENT_SECONDS = 2;
/** How many segments the playlist offers. About twelve seconds of catch-up. */
export const PLAYLIST_SEGMENTS = 6;
/** How long a packager runs with nobody asking for its playlist. */
export const IDLE_MS = 60_000;
/** How long the first playlist may take to appear before it is a failure. */
export const FIRST_PLAYLIST_MS = 20_000;

/**
 * How the segments are wrapped. MPEG-TS is what every HLS client has played
 * since 2009; fragmented MP4 is the same boxes the channel already carries,
 * copied into files without a second container around them, which is
 * smaller and is what a modern client prefers. Neither re-encodes anything.
 */
export type Packaging = "mpegts" | "fmp4";

const SEGMENT = /^seg\d{5}\.(?:ts|m4s)$/;
/**
 * The initialisation segment carries a token from the packager that made
 * it, so a client holding the init of a previous run cannot pair it with
 * the media of this one: the names do not match, and the old one is 404.
 */
const INIT = /^init-[0-9a-f]{8}\.mp4$/;

/** A segment file name, or "" for anything that is not one. Never a path. */
export function segmentName(requested: string): string {
  return SEGMENT.test(requested) || INIT.test(requested) ? requested : "";
}

/** What to call a segment file in a response. */
export function segmentType(name: string): string {
  if (name.endsWith(".m4s")) return "video/iso.segment";
  if (name.endsWith(".mp4")) return "video/mp4";
  return "video/mp2t";
}

/**
 * The playlist with the key on every segment.
 *
 * A browser resolves segment names against the playlist's URL and drops its
 * query, so the key that opened the playlist never reaches the segments and
 * each one answers 401. The key travels on every line instead -- including
 * the initialisation segment named inside the EXT-X-MAP tag, which is
 * fetched exactly like a segment and refused exactly like one.
 */
export function withKey(playlist: string, key: string): string {
  if (key === "") return playlist;
  const query = `?k=${encodeURIComponent(key)}`;
  return playlist
    .split("\n")
    .map((line) => {
      if (line.startsWith("#EXT-X-MAP:")) return line.replace(/URI="([^"]+)"/, (_, uri: string) => `URI="${uri}${query}"`);
      return line !== "" && !line.startsWith("#") ? `${line}${query}` : line;
    })
    .join("\n");
}

/** The ffmpeg arguments: copy what arrives on stdin into a rolling playlist. */
export function packagerArgs(dir: string, packaging: Packaging = "mpegts", token = "00000000"): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_list_size", String(PLAYLIST_SEGMENTS),
    // Old segments go; the playlist never ends; each segment starts on a
    // keyframe so a joiner can begin anywhere; written whole then renamed so
    // a request never reads half a file.
    "-hls_flags", "delete_segments+omit_endlist+independent_segments+temp_file",
    "-hls_segment_type", packaging,
    ...(packaging === "fmp4" ? ["-hls_fmp4_init_filename", `init-${token}.mp4`] : []),
    "-hls_segment_filename", join(dir, packaging === "fmp4" ? "seg%05d.m4s" : "seg%05d.ts"),
    join(dir, "index.m3u8"),
  ];
}

export interface PlaylistReport {
  packaging: Packaging;
  targetSeconds: number;
  /** Whether the playlist claims every segment starts on a keyframe. */
  independent: boolean;
  /** The longest segment the playlist offers, in seconds. A copy cannot cut inside a GOP, so this can exceed the target. */
  longestSegmentSeconds: number;
  segments: number;
  /** Whether an initialisation segment is named. */
  initialised: boolean;
}

/**
 * What a playlist actually says, as opposed to what the packager was asked
 * for: how long its segments came out, whether it names an init segment.
 * A two-second target on a stream with ten-second keyframes gives
 * ten-second segments, and only the playlist knows.
 */
export function playlistReport(playlist: string, packaging: Packaging): PlaylistReport {
  let target = 0;
  let longest = 0;
  let segments = 0;
  for (const line of playlist.split("\n")) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) target = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) {
      segments += 1;
      longest = Math.max(longest, Number(inf[1]) || 0);
    }
  }
  return {
    packaging,
    targetSeconds: target,
    independent: playlist.includes("#EXT-X-INDEPENDENT-SEGMENTS"),
    longestSegmentSeconds: longest,
    segments,
    initialised: playlist.includes("#EXT-X-MAP:"),
  };
}

export interface Packaged {
  /** Feed it the channel's bytes: the header first, then every fragment. */
  write(chunk: Buffer): boolean;
  /** The channel ended; finish and stop. */
  end(): void;
}

/** One channel's packager. */
class Packager implements Packaged {
  readonly dir: string;
  /** Names this run's init segment, so it cannot be mixed with another run's media. */
  readonly token = randomBytes(4).toString("hex");
  private child: ChildProcess | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private detach: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly ffmpeg: string[],
    readonly packaging: Packaging,
    private readonly onStop: (id: string) => void,
    private readonly onEvent: (message: string) => void,
  ) {
    this.dir = mkdtempSync(join(tmpdir(), `nixamp-hls-${id}-`));
  }

  start(listen: (listener: Packaged) => (() => void) | null): boolean {
    const [command, ...prefix] = this.ffmpeg as [string, ...string[]];
    try {
      this.child = spawn(command, [...prefix, ...packagerArgs(this.dir, this.packaging, this.token)], { stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      this.onEvent(`  HLS for "${this.id}" could not start: ${(error as Error).message}`);
      this.stop();
      return false;
    }
    let complaint = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (complaint.length < 4000) complaint += chunk.toString("utf8");
    });
    this.child.stdin?.on("error", () => undefined);
    this.child.on("error", (error) => {
      this.onEvent(`  HLS for "${this.id}" failed: ${error.message}`);
      this.stop();
    });
    this.child.on("close", (code) => {
      if (!this.stopped && code !== 0) {
        this.onEvent(`  HLS for "${this.id}" stopped: ${complaint.trim().split("\n").pop() ?? code}`);
      }
      this.stop();
    });
    this.detach = listen(this);
    if (this.detach === null) {
      this.stop();
      return false;
    }
    this.touch();
    return true;
  }

  write(chunk: Buffer): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      stdin.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  end(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // Already gone.
    }
    this.stop();
  }

  /** Somebody asked for the playlist: it is wanted for another minute. */
  touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  /** The playlist as it stands, or "" before the first segment is written. */
  playlist(): string {
    try {
      const text = readFileSync(join(this.dir, "index.m3u8"), "utf8");
      return text.includes("#EXTINF") ? text : "";
    } catch {
      return "";
    }
  }

  /** A segment's path, or "" when it is not there (any more). */
  segment(name: string): string {
    const safe = segmentName(name);
    if (safe === "") return "";
    const path = join(this.dir, safe);
    try {
      return statSync(path).isFile() ? path : "";
    } catch {
      return "";
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.detach?.();
    this.detach = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try {
        child.stdin?.end();
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // A directory that is already gone is fine.
    }
    this.onStop(this.id);
  }
}

/**
 * The packagers, one per channel that somebody is watching this way.
 *
 * `listen` is how a packager becomes a listener on its channel: it is handed
 * the header and then every fragment, exactly as a browser would be.
 */
export class HlsPackagers {
  private readonly running = new Map<string, Packager>();

  constructor(
    private readonly options: {
      ffmpeg: string[];
      listen: (id: string, listener: Packaged) => (() => void) | null;
      onEvent?: (message: string) => void;
      /** Injected for tests: how long to wait for the first playlist. */
      firstPlaylistMs?: number;
      /** How to wrap a channel's segments. MPEG-TS unless something says otherwise. */
      packaging?: (id: string) => Packaging;
    },
  ) {}

  /**
   * The playlist for a channel, starting the packager if it is not running,
   * and waiting for the first segments to exist. Null when the channel is not
   * there or nothing could be packaged.
   */
  async playlist(id: string): Promise<string | null> {
    let packager = this.running.get(id);
    if (!packager) {
      const packaging = this.options.packaging?.(id) ?? "mpegts";
      packager = new Packager(id, this.options.ffmpeg, packaging, (gone) => this.running.delete(gone), this.options.onEvent ?? (() => undefined));
      this.running.set(id, packager);
      if (!packager.start((listener) => this.options.listen(id, listener))) return null;
    }
    packager.touch();
    const deadline = Date.now() + (this.options.firstPlaylistMs ?? FIRST_PLAYLIST_MS);
    for (;;) {
      const text = packager.playlist();
      if (text !== "") return text;
      if (Date.now() > deadline || !this.running.has(id)) return null;
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  /** A segment's path, or "" when there is no such segment. */
  segment(id: string, name: string): string {
    const packager = this.running.get(id);
    if (!packager) return "";
    packager.touch();
    return packager.segment(name);
  }

  /** What a running packager's playlist actually says, or null when none is running. */
  report(id: string): PlaylistReport | null {
    const packager = this.running.get(id);
    if (!packager) return null;
    const text = packager.playlist();
    if (text === "") return null;
    return playlistReport(text, packager.packaging);
  }

  /** The channel went: stop packaging it. */
  stop(id: string): void {
    this.running.get(id)?.stop();
  }

  stopAll(): void {
    for (const packager of [...this.running.values()]) packager.stop();
  }

  get count(): number {
    return this.running.size;
  }
}

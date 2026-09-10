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

const SEGMENT = /^seg\d{5}\.ts$/;

/** A segment file name, or "" for anything that is not one. Never a path. */
export function segmentName(requested: string): string {
  return SEGMENT.test(requested) ? requested : "";
}

/**
 * The playlist with the key on every segment.
 *
 * A browser resolves segment names against the playlist's URL and drops its
 * query, so the key that opened the playlist never reaches the segments and
 * each one answers 401. The key travels on every line instead.
 */
export function withKey(playlist: string, key: string): string {
  if (key === "") return playlist;
  return playlist
    .split("\n")
    .map((line) => (line !== "" && !line.startsWith("#") ? `${line}?k=${encodeURIComponent(key)}` : line))
    .join("\n");
}

/** The ffmpeg arguments: copy what arrives on stdin into a rolling playlist. */
export function packagerArgs(dir: string): string[] {
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
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", join(dir, "seg%05d.ts"),
    join(dir, "index.m3u8"),
  ];
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
  private child: ChildProcess | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private detach: (() => void) | null = null;

  constructor(
    private readonly id: string,
    private readonly ffmpeg: string[],
    private readonly onStop: (id: string) => void,
    private readonly onEvent: (message: string) => void,
  ) {
    this.dir = mkdtempSync(join(tmpdir(), `nixamp-hls-${id}-`));
  }

  start(listen: (listener: Packaged) => (() => void) | null): boolean {
    const [command, ...prefix] = this.ffmpeg as [string, ...string[]];
    try {
      this.child = spawn(command, [...prefix, ...packagerArgs(this.dir)], { stdio: ["pipe", "ignore", "pipe"] });
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
      packager = new Packager(id, this.options.ffmpeg, (gone) => this.running.delete(gone), this.options.onEvent ?? (() => undefined));
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

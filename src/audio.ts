/**
 * Decoding and playback, both by way of ffmpeg.
 *
 * One decode feeds both the speakers and the analyser: ffmpeg writes raw f32
 * samples to our stdout pipe, we compute the spectrum from them and pass the
 * same bytes to the output process. Running two decoders instead would drift
 * apart within seconds and the bars would stop matching what you hear.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export const RATE = 44100;
export const CHANNELS = 2;

export interface Track {
  path: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds; 0 when ffprobe could not tell us. */
  duration: number;
}

export interface Tools {
  ffmpeg: string[];
  ffprobe: string[];
  /** Argv prefix for the player, or null when nothing can make sound here. */
  play: string[] | null;
}

function works(argv: string[]): boolean {
  const [cmd, ...rest] = argv;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, "-version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
}

/**
 * Find the tools. A bare `ffmpeg` on PATH is tried first; mise shims are common
 * on developer machines and need `mise exec` because the shim itself fails when
 * no version is pinned.
 */
export function detectTools(): Tools {
  const candidates = (name: string): string[][] => [
    [name],
    ["mise", "exec", `ffmpeg@latest`, "--", name],
  ];
  const pick = (name: string): string[] | null =>
    candidates(name).find((argv) => works(argv)) ?? null;

  const ffmpeg = pick("ffmpeg");
  const ffprobe = pick("ffprobe");
  const play = pick("ffplay");
  return {
    ffmpeg: ffmpeg ?? ["ffmpeg"],
    ffprobe: ffprobe ?? ["ffprobe"],
    play,
  };
}

export function probe(tools: Tools, path: string): Track {
  const [cmd, ...rest] = tools.ffprobe;
  const fallback: Track = {
    path,
    title: path.split("/").pop() ?? path,
    artist: "",
    album: "",
    duration: 0,
  };
  if (!cmd) return fallback;
  const result = spawnSync(cmd, [
    ...rest,
    "-v", "quiet", "-print_format", "json",
    "-show_format", "-show_entries", "format_tags=title,artist,album",
    path,
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) return fallback;
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string; tags?: Record<string, string> };
    };
    const tags = parsed.format?.tags ?? {};
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) lower[k.toLowerCase()] = v;
    return {
      path,
      title: lower.title || fallback.title,
      artist: lower.artist ?? "",
      album: lower.album ?? "",
      duration: Number(parsed.format?.duration ?? 0) || 0,
    };
  } catch {
    return fallback;
  }
}

export interface StreamHandlers {
  /** Interleaved stereo f32 samples, as decoded. */
  onSamples: (pcm: Float32Array) => void;
  onEnd: (error?: string) => void;
}

/**
 * A playing track: one ffmpeg decoding, one player consuming, and us in the
 * middle reading every sample on its way past.
 */
export class Stream {
  private decoder: ChildProcess | null = null;
  private output: ChildProcess | null = null;
  private stopped = false;
  /**
   * Which start each callback belongs to. A killed ffmpeg still fires `close`,
   * and without this its "exited null" lands on the track that replaced it —
   * so skipping a track would report an error and stop the player.
   */
  private generation = 0;
  /** Samples handed to the output so far, per channel. */
  private framesOut = 0;
  /** Leftover bytes when a chunk does not divide into whole f32 samples. */
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(
    private readonly tools: Tools,
    private readonly handlers: StreamHandlers,
  ) {}

  /** Seconds of audio delivered so far. */
  get position(): number {
    return this.framesOut / RATE;
  }

  get silent(): boolean {
    return this.tools.play === null;
  }

  start(track: Track, from = 0): void {
    this.stop();
    this.stopped = false;
    const generation = ++this.generation;
    this.framesOut = Math.round(from * RATE);

    const [ff, ...ffRest] = this.tools.ffmpeg;
    if (!ff) { this.handlers.onEnd("ffmpeg not found"); return; }

    this.decoder = spawn(ff, [
      ...ffRest,
      "-hide_banner", "-loglevel", "error",
      ...(from > 0 ? ["-ss", String(from)] : []),
      "-i", track.path,
      "-f", "f32le", "-ac", String(CHANNELS), "-ar", String(RATE), "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    if (this.tools.play) {
      const [player, ...playerRest] = this.tools.play;
      this.output = spawn(player as string, [
        ...playerRest,
        "-hide_banner", "-loglevel", "quiet",
        "-nodisp", "-autoexit",
        "-f", "f32le", "-ac", String(CHANNELS), "-ar", String(RATE), "-i", "-",
      ], { stdio: ["pipe", "ignore", "ignore"] });
      // The player exiting first must not kill us with EPIPE.
      this.output.stdin?.on("error", () => {});
    }

    let stderr = "";
    this.decoder.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    this.decoder.stdout?.on("data", (chunk: Buffer) => {
      if (this.stopped || generation !== this.generation) return;
      this.output?.stdin?.write(chunk);
      const joined = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
      const usable = joined.length - (joined.length % 4);
      this.tail = usable === joined.length ? Buffer.alloc(0) : joined.subarray(usable);
      if (usable === 0) return;
      // Copy rather than view: the underlying buffer is reused by the stream.
      const samples = new Float32Array(usable / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = joined.readFloatLE(i * 4);
      this.framesOut += samples.length / CHANNELS;
      this.handlers.onSamples(samples);
    });

    this.decoder.on("close", (code) => {
      if (this.stopped || generation !== this.generation) return;
      this.output?.stdin?.end();
      this.handlers.onEnd(code === 0 ? undefined : stderr.trim() || `ffmpeg exited ${code}`);
    });
    this.decoder.on("error", (error) => {
      if (this.stopped || generation !== this.generation) return;
      this.handlers.onEnd(error.message);
    });
  }

  stop(): void {
    this.stopped = true;
    // Anything still in flight from the last start belongs to nobody now.
    this.generation++;
    this.decoder?.kill("SIGKILL");
    this.output?.stdin?.end();
    this.output?.kill("SIGKILL");
    this.decoder = null;
    this.output = null;
    this.tail = Buffer.alloc(0);
  }
}

/** Left and right peak levels from an interleaved stereo frame, 0..1. */
export function peaks(pcm: Float32Array): [number, number] {
  let left = 0;
  let right = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const l = Math.abs(pcm[i] as number);
    const r = Math.abs(pcm[i + 1] as number);
    if (l > left) left = l;
    if (r > right) right = r;
  }
  return [Math.min(1, left), Math.min(1, right)];
}

/** Interleaved stereo down to mono, for the analyser. */
export function toMono(pcm: Float32Array): Float32Array {
  const mono = new Float32Array(Math.floor(pcm.length / CHANNELS));
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (((pcm[i * 2] as number) + (pcm[i * 2 + 1] as number)) / 2);
  }
  return mono;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

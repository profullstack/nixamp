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

/**
 * The same tags, read without blocking anything.
 *
 * `probe` is spawnSync, and 0.5.5 tried to fix the tagging pass by yielding
 * between files. That is not enough: each individual call still stops the
 * process for as long as one ffprobe takes, and on a large file over a slow
 * disk that is hundreds of milliseconds. Yield, block, yield, block, and a
 * server delivers a stream in slivers -- measured at 357 KB/s on a machine
 * whose disk reads at 6.5 MB/s and whose link runs at 1.4 Gbps.
 *
 * ffprobe still costs what it costs. It just costs it in a child process now,
 * which is where that work belongs.
 */
export async function probeAsync(tools: Tools, path: string): Promise<Track> {
  const [cmd, ...rest] = tools.ffprobe;
  const fallback: Track = {
    path,
    title: path.split("/").pop() ?? path,
    artist: "",
    album: "",
    duration: 0,
  };
  if (!cmd) return fallback;

  return new Promise<Track>((done) => {
    const child = spawn(
      cmd,
      [
        ...rest,
        "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_entries", "format_tags=title,artist,album",
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    // A file that will not answer must not hold a place in the queue for ever.
    const giveUp = setTimeout(() => child.kill("SIGKILL"), 20_000);
    giveUp.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < 4 * 1024 * 1024) out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(giveUp);
      done(fallback);
    });
    child.on("close", (code) => {
      clearTimeout(giveUp);
      if (code !== 0) return done(fallback);
      done(readTags(out, fallback));
    });
  });
}

/** The tags out of ffprobe's JSON, or the filename when it said nothing useful. */
function readTags(stdout: string, fallback: Track): Track {
  try {
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; tags?: Record<string, string> };
    };
    const tags = parsed.format?.tags ?? {};
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) lower[k.toLowerCase()] = v;
    return {
      path: fallback.path,
      title: lower.title || fallback.title,
      artist: lower.artist ?? "",
      album: lower.album ?? "",
      duration: Number(parsed.format?.duration ?? 0) || 0,
    };
  } catch {
    return fallback;
  }
}

/** What is actually inside a container, as opposed to what the name suggests. */
export interface Codecs {
  /** e.g. "h264", "hevc", "vp9". Empty when there is no video stream. */
  video: string;
  /** e.g. "aac", "ac3", "dts". Empty when there is no audio stream. */
  audio: string;
}

/**
 * Ask ffprobe what the streams are, without holding the event loop.
 *
 * Deliberately not the spawnSync `probe` above: this one runs while a server is
 * answering other requests, and a synchronous probe per media request is how
 * the whole library came to be tagged with the process wedged solid.
 */
export async function codecsOf(tools: Tools, path: string): Promise<Codecs> {
  const [cmd, ...rest] = tools.ffprobe;
  const empty: Codecs = { video: "", audio: "" };
  if (!cmd) return empty;

  return new Promise<Codecs>((done) => {
    const child = spawn(
      cmd,
      [
        ...rest,
        "-v", "quiet",
        "-print_format", "json",
        "-show_entries", "stream=codec_type,codec_name",
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => done(empty));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out) as { streams?: { codec_type?: string; codec_name?: string }[] };
        const streams = parsed.streams ?? [];
        return done({
          video: streams.find((s) => s.codec_type === "video")?.codec_name ?? "",
          audio: streams.find((s) => s.codec_type === "audio")?.codec_name ?? "",
        });
      } catch {
        return done(empty);
      }
    });
  });
}

/**
 * How to get this file into a browser, given what is inside it.
 *
 * A container a browser will not open says nothing about the streams within:
 * most Matroska holds H.264, which every browser decodes, and only the wrapper
 * is wrong. Rewrapping that costs nothing and looks identical; re-encoding it
 * would cost a core per viewer and look worse. So the streams decide, one part
 * at a time -- a film can have its video copied and only its DTS re-encoded.
 */
export function videoArgs(codecs: Codecs, capKbps = 0): string[] {
  // A ceiling means re-encoding whatever is there, because you cannot cap the
  // bitrate of a stream you are copying: copying is what "unchanged" means.
  if (capKbps > 0) return cappedArgs(capKbps);

  // What a browser can play inside MP4 without help.
  const keepVideo = codecs.video === "h264";
  const keepAudio = codecs.audio === "aac" || codecs.audio === "mp3";
  return [
    "-c:v", keepVideo ? "copy" : "libx264",
    ...(keepVideo ? [] : ["-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]),
    "-c:a", keepAudio ? "copy" : "aac",
    ...(keepAudio ? [] : ["-b:a", "160k", "-ac", "2"]),
    "-f", "mp4",
    // Fragmented, because this is a pipe: a normal MP4 writes its index at the
    // end, which for a stream never arrives and for a browser means nothing
    // plays at all.
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
  ];
}

/**
 * The width that suits a bitrate.
 *
 * 1080p squeezed into a megabit is worse than 360p at the same megabit: the
 * encoder spends everything it has on detail it cannot afford and the result
 * smears on every motion. Dropping the resolution with the bitrate is what
 * makes a small stream watchable rather than merely small.
 */
export function widthFor(kbps: number): number {
  if (kbps <= 800) return 640;
  if (kbps <= 1800) return 854;
  if (kbps <= 4000) return 1280;
  return 1920;
}

/** Arguments for a stream that has to fit through a link of a known size. */
function cappedArgs(kbps: number): string[] {
  const audioKbps = kbps <= 800 ? 96 : 128;
  const videoKbps = Math.max(200, kbps - audioKbps);
  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    // -2 keeps the aspect ratio and an even height, which H.264 requires.
    // The min() never enlarges: a 480p source asked for 720p stays 480p.
    "-vf", `scale='min(${widthFor(kbps)},iw)':-2`,
    "-b:v", `${videoKbps}k`,
    // A ceiling rather than an average, because an average that spikes is a
    // stall on a link this size. The buffer is one second of it.
    "-maxrate", `${videoKbps}k`,
    "-bufsize", `${videoKbps}k`,
    "-c:a", "aac",
    "-b:a", `${audioKbps}k`,
    "-ac", "2",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
  ];
}

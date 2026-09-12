/**
 * Decoding and playback, both by way of ffmpeg.
 *
 * One decode feeds both the speakers and the analyser: ffmpeg writes raw f32
 * samples to our stdout pipe, we compute the spectrum from them and pass the
 * same bytes to the output process. Running two decoders instead would drift
 * apart within seconds and the bars would stop matching what you hear.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTransportStream } from "./sources.ts";

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
  /** yt-dlp, which turns a pasted page into a media address; null when there is none. */
  ytdlp?: string[] | null;
  /**
   * Whether an ffmpeg was actually found, as opposed to guessed at. A server
   * without one cannot carry a channel, and should say so before a link is
   * resolved and probed and blamed for it.
   */
  carries?: boolean;
}

function works(argv: string[], flag = "-version"): boolean {
  const [cmd, ...rest] = argv;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, flag], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
}

/**
 * Everywhere a version manager or a package manager tends to leave ffmpeg.
 *
 * A daemon is started detached and inherits whatever environment happened to
 * be around, which on a machine that installs ffmpeg through mise is a PATH
 * with neither `ffmpeg` nor `mise` on it. Every probe then fails, and a
 * failed probe means "no video stream" -- so a television channel arrived as
 * its own soundtrack and nothing anywhere said why. Looking is cheaper than
 * asking somebody to fix their PATH for a process they did not start.
 *
 * Newest first, so a machine with several installed uses the one it would
 * have used anyway.
 */
function installedElsewhere(name: string): string[][] {
  const home = homedir();
  const roots = [
    join(home, ".local", "share", "mise", "installs", "ffmpeg"),
    join(home, ".asdf", "installs", "ffmpeg"),
  ];
  const found: string[][] = [];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) found.push([join(root, version, "bin", name)]);
  }
  // The ordinary absolute places, for a PATH that has been emptied rather than
  // merely shortened.
  for (const dir of ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin"]) {
    found.push([join(dir, name)]);
  }
  return found;
}

/**
 * Find the tools. A bare `ffmpeg` on PATH is tried first; mise shims are common
 * on developer machines and need `mise exec` because the shim itself fails when
 * no version is pinned. Failing both, the places these are actually installed
 * are looked in directly, because a detached daemon's PATH is not the operator's.
 */
export function detectTools(): Tools {
  const candidates = (name: string): string[][] => [
    [name],
    ["mise", "exec", `ffmpeg@latest`, "--", name],
    ...installedElsewhere(name),
  ];
  const pick = (name: string): string[] | null =>
    candidates(name).find((argv) => works(argv)) ?? null;

  const ffmpeg = pick("ffmpeg");
  const ffprobe = pick("ffprobe");
  const play = pick("ffplay");
  // yt-dlp is not an ffmpeg, so mise's ffmpeg tree is not where it lives;
  // the installer puts it beside nixamp, and pip puts it in ~/.local/bin too.
  // Asked with its own spelling: ffmpeg answers -version, yt-dlp only --version.
  const found = [["yt-dlp"], [join(homedir(), ".local", "bin", "yt-dlp")], ["/usr/local/bin/yt-dlp"], ["/usr/bin/yt-dlp"], ["/opt/homebrew/bin/yt-dlp"]]
    .find((argv) => works(argv, "--version")) ?? null;
  // yt-dlp wants a JavaScript runtime for YouTube now, and looks only for
  // deno unless told otherwise; without one it warns and some formats are
  // missing. This is a Node program, so the Node it is running on is handed
  // over. Only when yt-dlp knows the flag: an older one refuses it.
  const runtime = process.versions.bun ? "bun" : "node";
  const withRuntime = found ? [...found, "--js-runtimes", `${runtime}:${process.execPath}`] : null;
  const ytdlp = withRuntime && works(withRuntime, "--version") ? withRuntime : found;
  return {
    ffmpeg: ffmpeg ?? ["ffmpeg"],
    ffprobe: ffprobe ?? ["ffprobe"],
    play,
    ytdlp,
    carries: ffmpeg !== null,
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
      // Always paced to real time, because playing is a real-time act.
      //
      // Decoding is meant to keep pace with listening, and `position` is what
      // a watch party synchronises to. Left unpaced it runs at whatever speed
      // the disk manages -- a film reached its end in a couple of minutes, and
      // every viewer was handed a position the server had already raced past.
      //
      // This was first written as "pace only when there is no player", which
      // looked right and was not: a server has an ffplay binary sitting there
      // that cannot open an audio device, so it exits at once and drains
      // nothing, while its mere existence said pacing was somebody else's job.
      // Whether a machine can make a sound is not a thing to infer from a file
      // being on disk. Measured with that condition in place: still 13.8x.
      "-re",
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
    // The tail only: what went wrong is on the last line, and a film with a
    // damaged audio track can say so once a frame for two hours.
    this.decoder.stderr?.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-2000); });

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
  /**
   * What is wrapped around them: "mpegts", "matroska,webm", "mov,mp4,...".
   *
   * It matters for one reason. A transport stream -- which is what every IPTV
   * channel is -- frames its AAC as ADTS, and copying that into MP4 needs a
   * bitstream filter or ffmpeg refuses the whole muxing and writes nothing.
   * They also tend to carry several audio tracks, so the one ffmpeg picks can
   * be AC-3 on the same URL that offered AAC a minute earlier, and AC-3 in MP4
   * is a track no browser will play.
   */
  container: string;
  /**
   * How long it is, in seconds; 0 when it has no end, which is what tells a
   * live channel from a film. A film has a place to go back to after a
   * restart; a live channel is wherever it is now.
   */
  duration?: number;
  /**
   * The size of the picture, when there is one.
   *
   * It decides the one thing that costs real money: whether a re-encode is
   * asked to do 4K. Measured on this machine, 3840x2160 through libx264
   * -preset veryfast runs at about half of real time, so a 4K film re-encoded
   * at its own size arrives slower than it plays -- a stream that falls
   * further behind every second. The same source scaled to 1080p runs at
   * about 1.6x real time and keeps up. Copying, of course, costs nothing at
   * any size, which is why what is inside matters more than how big it is.
   */
  width?: number;
  height?: number;
}

/**
 * Ask ffprobe what the streams are, without holding the event loop.
 *
 * Deliberately not the spawnSync `probe` above: this one runs while a server is
 * answering other requests, and a synchronous probe per media request is how
 * the whole library came to be tagged with the process wedged solid.
 */
export async function codecsOf(tools: Tools, path: string, input: string[] = []): Promise<Codecs> {
  const [cmd, ...rest] = tools.ffprobe;
  const empty: Codecs = { video: "", audio: "", container: "" };
  if (!cmd) return empty;

  return new Promise<Codecs>((done) => {
    const child = spawn(
      cmd,
      [
        ...rest,
        "-v", "quiet",
        "-print_format", "json",
        // The disposition too: an MP3 with its cover art in it carries that
        // art as a video stream of one JPEG, and a probe that took it for a
        // picture put a podcast on the air as a film with no frames.
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic",
        // A transport stream needs looking further into than a file with an
        // index does: there is no header listing the tracks, only packets, and
        // a 4K recording can carry a second of null padding and a long gap to
        // its first keyframe. ffprobe's default gives up before the picture on
        // exactly the recordings this is for, and "no video stream" is how a
        // film comes back as its own soundtrack.
        ...transportProbeArgs(path),
        // Headers the source's site expects, for a link resolved by yt-dlp.
        ...input,
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
        const parsed = JSON.parse(out) as {
          streams?: {
            codec_type?: string; codec_name?: string; width?: number; height?: number;
            disposition?: { attached_pic?: number };
          }[];
          format?: { format_name?: string; duration?: string };
        };
        const streams = parsed.streams ?? [];
        // ffprobe prints seconds as a string, and "N/A" for a stream with no
        // end; both of those read as 0.
        const seconds = Number(parsed.format?.duration ?? 0);
        const picture = streams.find((s) => s.codec_type === "video" && !isCoverArt(s));
        return done({
          video: picture?.codec_name ?? "",
          audio: streams.find((s) => s.codec_type === "audio")?.codec_name ?? "",
          container: parsed.format?.format_name ?? "",
          duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
          ...(typeof picture?.width === "number" && picture.width > 0 ? { width: picture.width } : {}),
          ...(typeof picture?.height === "number" && picture.height > 0 ? { height: picture.height } : {}),
        });
      } catch {
        return done(empty);
      }
    });
  });
}

/**
 * Cover art is not a picture.
 *
 * An MP3, FLAC or M4A with its sleeve embedded shows ffprobe a video stream:
 * one JPEG or PNG, flagged as an attached picture. Carried as video it is a
 * channel whose picture never gets a second frame -- ffmpeg writes nothing
 * and the source is dialled again and again -- so a sleeve counts for
 * nothing and the sound decides. A still-image codec with no such flag is
 * the same thing from a container that does not flag it.
 */
const STILL_IMAGE = new Set(["png", "bmp", "gif", "tiff", "webp"]);
export function isCoverArt(stream: { codec_name?: string; disposition?: { attached_pic?: number } }): boolean {
  if (stream.disposition?.attached_pic === 1) return true;
  return STILL_IMAGE.has((stream.codec_name ?? "").toLowerCase());
}

/** How much of a transport stream is read before deciding what is in it. */
export const TRANSPORT_PROBE_BYTES = 20 * 1024 * 1024;
export const TRANSPORT_ANALYSE_US = 10_000_000;

/**
 * What to tell ffmpeg or ffprobe before it opens a transport stream.
 *
 * A `.ts` has no index and no header: it is packets, and the tracks are
 * whatever turns up in them. The defaults are tuned for a file that describes
 * itself, so a 4K recording -- padded with null packets, seconds between
 * keyframes, sometimes several programmes -- gets read as having no picture,
 * or no sound, or neither. Reading twenty megabytes before deciding costs a
 * fraction of a second on a local disk and is the difference between a
 * television recording and "nothing to play here".
 *
 * `+genpts` is for the other half of it: a recording that starts mid-stream
 * has no timestamp on its first frames, and a fragmented MP4 built out of
 * those has a duration of nothing and a seek bar that does not move.
 * `+discardcorrupt` drops the half-packet at a cut rather than passing
 * rubbish to the decoder.
 */
export function transportProbeArgs(path: string, container = ""): string[] {
  if (!isTransportSource(path, container)) return [];
  return ["-probesize", String(TRANSPORT_PROBE_BYTES), "-analyzeduration", String(TRANSPORT_ANALYSE_US)];
}

/** The same, for a decode rather than a probe: the timestamps matter too. */
export function transportInputArgs(path: string, container = ""): string[] {
  if (!isTransportSource(path, container)) return [];
  return [...transportProbeArgs(path, container), "-fflags", "+genpts+discardcorrupt"];
}

/**
 * Whether this source is a transport stream, by its name or by what a probe
 * already found in it. The container is the better answer where there is one:
 * an IPTV URL ending in `/301` is an mpegts and says so nowhere in its name.
 */
function isTransportSource(path: string, container = ""): boolean {
  if (container.includes("mpegts")) return true;
  return isTransportStream(path);
}

/** How the two sides of `-c:v copy` are told apart in a name a person reads. */
export interface VideoOptions {
  /**
   * Whether the thing at the other end can decode H.265.
   *
   * Safari and most televisions can; Chrome on a desktop cannot, and hands
   * back nothing at all rather than an error anybody sees. So HEVC is only
   * ever copied when the client said it could take it -- which is worth
   * asking, because the alternative for a 4K HEVC film is an encode that does
   * not keep up with playback.
   */
  allowHevc?: boolean;
  /**
   * The tallest picture a re-encode may produce. A copy is never resized: a
   * 4K stream a browser can already decode is handed over as it is.
   */
  maxHeight?: number;
}

/**
 * The tallest re-encode that keeps up with playback.
 *
 * Measured on this box (8 cores, libx264 -preset veryfast, a 4K HEVC source):
 * 4K out ran at 0.52x real time, 1080p out at 1.65x. An encode slower than
 * real time is a live channel that falls behind for ever and a film that
 * stalls every few seconds, so a re-encode of anything taller comes down to
 * this. Copying is exempt, and copying is the ordinary case.
 */
export const MAX_TRANSCODE_HEIGHT = 1080;

/**
 * How to get this file into a browser, given what is inside it.
 *
 * A container a browser will not open says nothing about the streams within:
 * most Matroska holds H.264, which every browser decodes, and only the wrapper
 * is wrong. Rewrapping that costs nothing and looks identical; re-encoding it
 * would cost a core per viewer and look worse. So the streams decide, one part
 * at a time -- a film can have its video copied and only its DTS re-encoded.
 *
 * Resolution is deliberately not one of the deciders for a copy. 1080p and 4K
 * H.264 out of a transport stream are copied exactly as 720p is, because the
 * work of copying does not grow with the picture and a browser that can decode
 * 4K should be given 4K.
 */
export function videoArgs(codecs: Codecs, capKbps = 0, options: VideoOptions = {}): string[] {
  // A ceiling means re-encoding whatever is there, because you cannot cap the
  // bitrate of a stream you are copying: copying is what "unchanged" means.
  if (capKbps > 0) return cappedArgs(capKbps);

  // What a browser can play inside MP4 without help -- and H.265, when the
  // other end has said it can decode it, which saves re-encoding 4K.
  const keepHevc = codecs.video === "hevc" && options.allowHevc === true;
  const keepVideo = codecs.video === "h264" || keepHevc;
  // A transport stream's audio is never copied. Its AAC is ADTS-framed, which
  // MP4 refuses without a bitstream filter -- ffmpeg writes nothing at all and
  // says "Malformed AAC bitstream detected" -- and the track ffmpeg picks off
  // a channel with several of them can be AC-3, which that filter rejects and
  // no browser plays. Re-encoding audio is cheap; this failing is total.
  const transportStream = codecs.container.includes("mpegts");
  const keepAudio = !transportStream && (codecs.audio === "aac" || codecs.audio === "mp3");
  // A re-encode of something taller than this comes down to it, because an
  // encode slower than real time is not a stream. A copy keeps its size.
  const ceiling = options.maxHeight ?? MAX_TRANSCODE_HEIGHT;
  const tooTall = !keepVideo && (codecs.height ?? 0) > ceiling;
  return [
    "-c:v", keepVideo ? "copy" : "libx264",
    // H.265 in MP4 is `hvc1` to Safari and to every television; ffmpeg writes
    // `hev1` by default, which Safari opens and then plays as a black panel.
    ...(keepHevc ? ["-tag:v", "hvc1"] : []),
    // A keyframe every two seconds when encoding. A fragment starts on a
    // keyframe, so this is how soon a joiner sees a picture -- and an HLS
    // segment, which is cut on keyframes too, was ten seconds long on
    // x264's default and made a phone wait thirty before it played.
    ...(keepVideo ? [] : ["-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"]),
    // -2 keeps the aspect ratio and an even height, which H.264 requires; the
    // min() never enlarges, so a 720p source asked for 1080p stays 720p.
    ...(tooTall ? ["-vf", `scale=-2:'min(${ceiling},ih)'`] : []),
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

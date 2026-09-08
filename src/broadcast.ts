/**
 * Broadcasting out to RTMP, to as many places at once as you like.
 *
 * One ffmpeg, one encode, many outputs, through the `tee` muxer. Running an
 * ffmpeg per destination is the obvious shape and it encodes the same frames
 * four times; tee encodes once and writes the result to every URL.
 *
 * The encoder settings are PairUX's, which learned them the hard way against
 * the real platforms: a one-second keyframe interval because YouTube stalls on
 * ffmpeg's default, a forced constant frame rate because a variable-rate source
 * makes YouTube report "not receiving enough video", and yuv420p because that
 * is what RTMP platforms accept.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface Destination {
  id: string;
  /** What to call it: "YouTube", "X", the name of a server. */
  name: string;
  /** rtmp://a.rtmp.youtube.com/live2 — without the key. */
  url: string;
  /** The stream key. It never leaves the machine: see redact(). */
  key: string;
  enabled: boolean;
}

export interface EncoderSettings {
  /** kbps. */
  videoBitrate: number;
  audioBitrate: number;
  framerate: number;
  /** Seconds between keyframes. One, unless you enjoy YouTube stalling. */
  keyframeInterval: number;
  resolution: "720p" | "1080p";
}

export const DEFAULT_ENCODER: EncoderSettings = {
  videoBitrate: 4500,
  audioBitrate: 128,
  framerate: 30,
  keyframeInterval: 1,
  resolution: "1080p",
};

/** The RTMP ingest URLs of the places people actually go live. */
export const PRESETS: Record<string, string> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  x: "rtmp://ingest.x.com:1935/live",
  facebook: "rtmps://live-api-s.facebook.com:443/rtmp",
  tiktok: "rtmp://push.tiktokcdn.com/live",
  twitch: "rtmp://live.twitch.tv/app",
  kick: "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
};

export function resolutionOf(resolution: EncoderSettings["resolution"]): { width: number; height: number } {
  return resolution === "720p" ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
}

/** The full ingest URL. Built here so a key is never assembled by a client. */
export function ingestUrl(destination: Destination): string {
  return `${destination.url.replace(/\/+$/, "")}/${destination.key}`;
}

/** Somewhere to actually send RTMP. */
export function isRtmp(url: string): boolean {
  return /^rtmps?:\/\/[^\s/]+/i.test(url);
}

/**
 * A destination as it may be shown to anyone. A stream key is a password: it
 * lets a stranger broadcast as you until you rotate it.
 */
export function redact(destination: Destination): Omit<Destination, "key"> & { key: string } {
  const tail = destination.key.slice(-4);
  return { ...destination, key: destination.key ? `••••${tail}` : "" };
}

/**
 * A tee output. `onfail=ignore` is the important part: without it one dead
 * destination takes the whole broadcast down with it, and the one that dies is
 * usually the one whose key expired without telling you.
 */
export function teeOutput(url: string, options: string[] = ["f=flv"]): string {
  return `[${[...options, "onfail=ignore"].join(":")}]${url}`;
}

export interface BroadcastPlan {
  source: string;
  destinations: Destination[];
  settings: EncoderSettings;
  /** Also produce web-playable audio on stdout, from the same decode. */
  webAudio: boolean;
  /** The source has no video track, so one has to be invented for RTMP. */
  needsVideo: boolean;
}

/**
 * The whole ffmpeg command.
 *
 * RTMP platforms want a video track even when what you are sending is music,
 * so a silent source gets a flat colour at the chosen size. It is what a radio
 * stream looks like on YouTube either way.
 */
export function buildBroadcastArgs(plan: BroadcastPlan): string[] {
  const { width, height } = resolutionOf(plan.settings.resolution);
  const gop = plan.settings.framerate * plan.settings.keyframeInterval;

  const args = ["-hide_banner", "-loglevel", "error"];

  // -re only for a file: a live source already arrives in real time, and
  // throttling it a second time drifts further behind with every track.
  if (!/^(https?|rtmps?|pipe):/i.test(plan.source) && plan.source !== "pipe:0") args.push("-re");

  if (plan.needsVideo) {
    args.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${plan.settings.framerate}`);
  }
  args.push("-i", plan.source);

  // Video is always input 0: either the invented colour, or the source's own.
  // Audio moves to input 1 when a colour was pushed in front of it.
  args.push("-map", "0:v", "-map", plan.needsVideo ? "1:a" : "0:a");

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-b:v", `${plan.settings.videoBitrate}k`,
    "-maxrate", `${Math.round(plan.settings.videoBitrate * 1.1)}k`,
    "-bufsize", `${plan.settings.videoBitrate * 2}k`,
    // A strict constant frame rate. A source that only produces frames when
    // something changes reads to YouTube as a stream that is falling behind.
    "-vf", `scale=${width}:${height},fps=${plan.settings.framerate}`,
    "-pix_fmt", "yuv420p",
    "-g", String(gop),
    "-c:a", "aac",
    "-b:a", `${plan.settings.audioBitrate}k`,
    "-ar", "44100",
  );

  const outputs = plan.destinations
    .filter((d) => d.enabled && isRtmp(d.url))
    .map((d) => teeOutput(ingestUrl(d)));

  // The web copy rides along on the same encode, audio only, down stdout.
  if (plan.webAudio) outputs.push(teeOutput("pipe:1", ["select=a", "f=mp3"]));

  if (outputs.length === 0) return [];

  // One output does not need the tee muxer, and ffmpeg reports its errors more
  // clearly without it.
  if (outputs.length === 1 && !plan.webAudio) {
    const only = plan.destinations.find((d) => d.enabled && isRtmp(d.url));
    args.push("-f", "flv", ingestUrl(only as Destination));
    return args;
  }

  args.push("-flags", "+global_header", "-f", "tee", outputs.join("|"));
  return args;
}

export type BroadcastState = "idle" | "live" | "failed";

export interface BroadcastStatus {
  state: BroadcastState;
  since: number | null;
  /** Names only, and never a key. */
  destinations: string[];
  error: string;
}

/**
 * One broadcast at a time, restarted when it dies. A live stream that stops
 * because a platform hiccupped, and stays stopped, is worse than no feature.
 */
export class Broadcaster {
  private child: ChildProcess | null = null;
  private plan: BroadcastPlan | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private state: BroadcastState = "idle";
  private since: number | null = null;
  private error = "";

  constructor(
    private readonly ffmpeg: string[] = ["ffmpeg"],
    /** Injected so a test never waits five real seconds. */
    private readonly delay = (ms: number, run: () => void) => setTimeout(run, ms),
  ) {}

  status(): BroadcastStatus {
    return {
      state: this.state,
      since: this.since,
      destinations: (this.plan?.destinations ?? []).filter((d) => d.enabled).map((d) => d.name),
      error: this.error,
    };
  }

  start(plan: BroadcastPlan): { ok: boolean; error: string } {
    const args = buildBroadcastArgs(plan);
    if (args.length === 0) return { ok: false, error: "no enabled destination with an rtmp url" };

    this.stop();
    this.plan = plan;
    this.attempts = 0;
    this.error = "";
    this.spawn(args);
    return { ok: true, error: "" };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.plan = null;
    this.state = "idle";
    this.since = null;
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
  }

  private spawn(args: string[]): void {
    const [command, ...prefix] = this.ffmpeg as [string, ...string[]];
    const child = spawn(command, [...prefix, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.state = "live";
    this.since = Date.now();

    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });

    child.on("error", (error) => {
      this.error = error.message;
      this.state = "failed";
    });

    child.on("close", (code) => {
      if (this.child !== child) return; // stopped on purpose, or replaced
      this.child = null;
      if (code === 0) {
        this.state = "idle";
        this.since = null;
        return;
      }
      this.error = tail.trim().split("\n").pop() ?? `ffmpeg exited ${code}`;
      this.state = "failed";
      this.retry();
    });
  }

  /** Back off, but never give up entirely while a plan is set. */
  private retry(): void {
    const plan = this.plan;
    if (plan === null) return;
    this.attempts++;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts - 1));
    this.timer = this.delay(wait, () => {
      if (this.plan !== plan) return;
      this.spawn(buildBroadcastArgs(plan));
    }) as ReturnType<typeof setTimeout>;
  }
}

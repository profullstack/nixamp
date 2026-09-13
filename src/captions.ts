/**
 * Captions: what a live channel is saying, written down as it says it.
 *
 * One captioner per channel, started when the first person asks for the
 * transcript and stopped a minute after the last one leaves, because it
 * costs a CPU somewhere for as long as it runs. It listens to the channel
 * exactly as a browser does -- the same bytes, from the same backlog --
 * hands them to an ffmpeg that turns them into 16 kHz mono PCM, cuts that
 * into five-second windows, and sends each window to nixamp.com's ear
 * (see speech.ts) signed in as this server. The words come back as a
 * line, stamped with the wall-clock moment the sound was heard, so a page
 * can hold each line until its own playback gets there and the subtitles
 * land close to the voice.
 *
 * Five seconds is the trade. Shorter windows hear less context and cost
 * more asks; longer ones make the words later than the sound. A line is a
 * window: no word-level timing, because the ear takes twice as long when
 * asked for it and the page is only ever close to the voice, not on it.
 *
 * A quiet window -- the gap between songs, a picture with no talking -- is
 * never sent. Most of a music channel is that, and hearing it costs the
 * same as hearing speech.
 */
import { spawn } from "node:child_process";
import type { Listener } from "./channels.ts";
import { RATE } from "./speech.ts";

export interface CaptionLine {
  /** The channel's id. */
  channel: string;
  /** When the sound this line is from began and ended, wall clock, ms. */
  at: number;
  until: number;
  text: string;
}

/** What turns a channel's bytes into 16 kHz mono 16-bit PCM. ffmpeg, or a test's stand-in. */
export interface Decoder {
  write(chunk: Buffer): boolean;
  end(): void;
}

export interface CaptionsOptions {
  /** A listener on a channel, or null when there is no such channel. */
  listen: (id: string, listener: Listener) => (() => void) | null;
  ffmpeg: string[];
  /** Whose ear to use: this server's own sign-in, read when a captioner starts. Null means no captions. */
  session: () => { site: string; token: string } | null;
  fetcher?: typeof fetch;
  /** How bytes become PCM. The default spawns ffmpeg; the tests hand in something quieter. */
  decoder?: (onPcm: (pcm: Buffer) => void, onEnd: () => void) => Decoder;
  now?: () => number;
  onEvent?: (message: string) => void;
  windowMs?: number;
  idleMs?: number;
}

export const WINDOW_MS = 5000;
/** Lines kept per channel for whoever arrives late. */
export const KEEP = 200;
export const IDLE_MS = 60_000;
/** Below this RMS (about -48 dBFS) a window is silence, and never sent. */
export const QUIET = 0.004;
/** Windows waiting on the ear at once. Past this the sound is dropped, not queued: late words are worse than none. */
export const IN_FLIGHT = 2;

/**
 * The ffmpeg arguments: whatever arrives on stdin, as PCM on stdout, with
 * a short probe so the first line is not long in coming. Never `-fflags
 * nobuffer`: it drops the packets it probed, which took the first 1.7
 * seconds out of every captioner and began every transcript mid-sentence.
 */
export function decoderArgs(): string[] {
  return [
    "-v", "error", "-nostats",
    "-flags", "low_delay",
    "-analyzeduration", "500000", "-probesize", "262144",
    "-i", "pipe:0",
    "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1",
  ];
}

function ffmpegDecoder(ffmpeg: string[], onPcm: (pcm: Buffer) => void, onEnd: () => void): Decoder {
  const [command, ...prefix] = ffmpeg;
  const child = spawn(command as string, [...prefix, ...decoderArgs()], { stdio: ["pipe", "pipe", "ignore"] });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk: Buffer) => onPcm(chunk));
  child.on("error", end);
  child.on("close", end);
  return {
    write: (chunk) => {
      if (ended || child.stdin.destroyed) return false;
      try {
        child.stdin.write(chunk);
      } catch {
        return false;
      }
      return true;
    },
    end: () => {
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
      if (!ended) {
        const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
        kill.unref?.();
      }
    },
  };
}

/** Whether a window of 16-bit PCM has anything in it worth hearing. */
export function isQuiet(pcm: Buffer, threshold = QUIET): boolean {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return true;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples) < threshold;
}

/** A WAV around 16-bit mono PCM, without copying it through floats. */
export function wavAround(pcm: Buffer, rate = RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type Subscriber = (line: CaptionLine) => void;

class Captioner {
  readonly lines: CaptionLine[] = [];
  readonly subscribers = new Set<Subscriber>();
  /** The last thing that went wrong, for whoever asks why there are no lines. */
  error = "";
  private decoder: Decoder | null = null;
  private detach: (() => void) | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private inFlight = 0;
  private stopped = false;
  private complainedAt = 0;

  constructor(
    readonly id: string,
    private readonly options: CaptionsOptions,
    private readonly onStop: () => void,
  ) {}

  private get windowBytes(): number {
    return Math.round(((this.options.windowMs ?? WINDOW_MS) / 1000) * RATE) * 2;
  }

  start(): boolean {
    const make = this.options.decoder ?? ((onPcm, onEnd) => ffmpegDecoder(this.options.ffmpeg, onPcm, onEnd));
    this.decoder = make((pcm) => this.onPcm(pcm), () => this.stop());
    this.detach = this.options.listen(this.id, {
      write: (chunk) => this.decoder?.write(chunk) ?? false,
      end: () => this.stop(),
    });
    if (this.detach === null) {
      this.stop();
      return false;
    }
    return true;
  }

  private onPcm(pcm: Buffer): void {
    if (this.stopped) return;
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    const size = this.windowBytes;
    while (this.pendingBytes >= size) {
      const all = Buffer.concat(this.pending);
      const window = all.subarray(0, size);
      const rest = all.subarray(size);
      this.pending = rest.length > 0 ? [Buffer.from(rest)] : [];
      this.pendingBytes = rest.length;
      const until = (this.options.now ?? Date.now)();
      void this.hear(Buffer.from(window), until - (this.options.windowMs ?? WINDOW_MS), until);
    }
  }

  private async hear(pcm: Buffer, at: number, until: number): Promise<void> {
    if (isQuiet(pcm)) return;
    if (this.inFlight >= IN_FLIGHT) return;
    const session = this.options.session();
    if (session === null) {
      this.complain("this server is not signed in, so it cannot caption; `nixamp login` on it");
      return;
    }
    this.inFlight += 1;
    try {
      const wav = wavAround(pcm);
      const response = await (this.options.fetcher ?? fetch)(`${session.site.replace(/\/+$/, "")}/api/v1/speech/transcribe`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "audio/wav" },
        body: new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer]),
      });
      const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!response.ok) {
        this.complain(body.error ?? `nixamp.com answered ${response.status}`);
        return;
      }
      const text = (body.text ?? "").trim();
      if (text === "" || this.stopped) return;
      this.error = "";
      const line: CaptionLine = { channel: this.id, at, until, text };
      this.lines.push(line);
      while (this.lines.length > KEEP) this.lines.shift();
      for (const subscriber of this.subscribers) {
        try {
          subscriber(line);
        } catch {
          // A listener that throws is not this channel's problem.
        }
      }
    } catch (error) {
      this.complain(`could not reach the ear: ${(error as Error).message}`);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Said once a minute at most: a broken ear would otherwise say so twelve times a minute. */
  private complain(message: string): void {
    this.error = message;
    const now = (this.options.now ?? Date.now)();
    if (now - this.complainedAt < 60_000) return;
    this.complainedAt = now;
    this.options.onEvent?.(`captions for "${this.id}": ${message}`);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0 && !this.stopped) {
        this.idle = setTimeout(() => {
          if (this.subscribers.size === 0) this.stop();
        }, this.options.idleMs ?? IDLE_MS);
        this.idle.unref?.();
      }
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.detach?.();
    this.detach = null;
    this.decoder?.end();
    this.decoder = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.subscribers.clear();
    this.onStop();
  }
}

export class Captions {
  private readonly running = new Map<string, Captioner>();

  constructor(private readonly options: CaptionsOptions) {}

  /** Whether this server can caption at all: it has to be signed in for the ear to answer it. */
  available(): boolean {
    return this.options.session() !== null;
  }

  /**
   * Lines for a channel as they are heard, starting the captioner if it is
   * not running. Null when there is no such channel. The returned function
   * is how to stop listening; the captioner itself stops a minute after the
   * last listener does.
   */
  subscribe(id: string, subscriber: Subscriber): (() => void) | null {
    let captioner = this.running.get(id);
    if (!captioner) {
      const made = new Captioner(id, this.options, () => {
        if (this.running.get(id) === made) this.running.delete(id);
      });
      this.running.set(id, made);
      if (!made.start()) return null;
      this.options.onEvent?.(`captions for "${id}": started`);
      captioner = made;
    }
    return captioner.subscribe(subscriber);
  }

  /** The recent lines of a channel, oldest first, after a moment when given. Empty when nobody has asked for them. */
  recent(id: string, after = 0): CaptionLine[] {
    const captioner = this.running.get(id);
    if (!captioner) return [];
    return after > 0 ? captioner.lines.filter((line) => line.at > after) : [...captioner.lines];
  }

  /** Whether a channel is being captioned, and what last went wrong if the lines are not coming. */
  status(id: string): { on: boolean; lines: number; error: string } {
    const captioner = this.running.get(id);
    return captioner ? { on: true, lines: captioner.lines.length, error: captioner.error } : { on: false, lines: 0, error: "" };
  }

  stopAll(): void {
    for (const captioner of [...this.running.values()]) captioner.stop();
  }
}

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
 *
 * What is heard is kept (see transcripts.ts): every line goes to nixamp.com
 * under the identity of what the channel is playing, as seconds into it.
 * When a captioner starts it asks for what is already known, and a window
 * whose moment the store has been through is read out of it instead of
 * heard. A film captioned once is captioned by nobody again; a live is
 * kept as the broadcast it was. And a viewer may ask for the lines in
 * another language: each heard line is translated once, on nixamp.com,
 * handed to whoever wanted that language, and kept beside the original.
 */
import { spawn } from "node:child_process";
import type { Listener } from "./channels.ts";
import { NATIVE_REVISION, RATE, SpeechError, reliableText } from "./speech.ts";
import { voiceProfile } from "./voice-profile.ts";
import { fetchTranscript, keepLines, keepMedia, translateTexts, type MediaToKeep } from "./transcript-client.ts";
import { covered, lineAt, transcriptIdOf, type TranscriptLine } from "./transcripts.ts";

export interface CaptionLine {
  /** The channel's id. */
  channel: string;
  /** When the sound this line is from began and ended, wall clock, ms. */
  at: number;
  until: number;
  text: string;
  /** The language of the words, as heard or as translated into; absent when nobody said. */
  language?: string;
  /** What was heard, when this line is a translation of it. */
  original?: string;
  sourceLanguage?: string;
  voiceProfile?: "lower" | "higher" | "unknown";
}

/** What turns a channel's bytes into 16 kHz mono 16-bit PCM. ffmpeg, or a test's stand-in. */
export interface Decoder {
  write(chunk: Buffer): boolean;
  end(): void;
}

/**
 * What a channel is playing, for the store: its identity, and how the
 * sound a new listener gets maps onto seconds of it.
 */
export interface ChannelMedia {
  /** The media identity, as transcripts.ts spells one. */
  media: string;
  title: string;
  /** Seconds into the media at this moment, for a film; absent for anything live. */
  position?: number;
  /** When the channel began, wall clock, ms. A live's seconds count from here. */
  startedAt: number;
  /** How many seconds behind the live edge a new listener's sound starts. */
  backlog: number;
  /**
   * The file itself, described for the record at nixamp.com/hash/<id>:
   * its SHA-256 and what is known about it. Absent for anything that is
   * not a file on this machine. Asked once when the captioner starts.
   */
  describe?: () => Promise<{ id: string; keep: MediaToKeep } | null>;
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
  /** What a channel is playing, for the store. Null, or absent, means the lines are not kept. */
  mediaOf?: (id: string) => ChannelMedia | null;
  now?: () => number;
  onEvent?: (message: string) => void;
  windowMs?: number;
  idleMs?: number;
  /** How often heard lines go to the store. */
  flushMs?: number;
}

export const WINDOW_MS = 5000;
/** Lines kept per channel for whoever arrives late. */
export const KEEP = 200;
export const IDLE_MS = 60_000;
/** Below this RMS (about -48 dBFS) a window is silence, and never sent. */
export const QUIET = 0.004;
/** Windows waiting on the ear at once. Past this the sound is dropped, not queued: late words are worse than none. */
export const IN_FLIGHT = 2;
export const LIVE_DEADLINE_MS = 12_000;
export const MAX_CAPTIONERS = 4;
/** Heard lines wait this long, at most, before they are kept. */
export const FLUSH_MS = 20_000;
/** Or this many. */
export const FLUSH_LINES = 12;

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

/**
 * Seconds into the media that a window covers. A film is paced in real
 * time from a known position, so a new listener's first byte is that
 * position less the backlog it was handed, and every window after it is
 * one window further on. Anything live counts from when the channel
 * began, in wall-clock time.
 */
export function mediaSpan(media: ChannelMedia, windowIndex: number, windowSeconds: number, at: number, until: number): { start: number; end: number } {
  if (typeof media.position === "number") {
    const join = Math.max(0, media.position - media.backlog);
    return { start: round(join + windowIndex * windowSeconds), end: round(join + (windowIndex + 1) * windowSeconds) };
  }
  return { start: round(Math.max(0, (at - media.startedAt) / 1000)), end: round(Math.max(0, (until - media.startedAt) / 1000)) };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

export { lineAt };

type Subscriber = (line: CaptionLine) => void;

export interface CaptionStatus {
  on: boolean;
  lines: number;
  error: string;
  /** The language heard, when known. */
  language: string;
  /** How many lines the store already had for this media when the captioner began. */
  known: number;
  /** The languages lines are being given in besides the original. */
  languages: string[];
  /** The file's SHA-256, once it has been described for nixamp.com/hash/<id>; "" until then, or for a live. */
  hash: string;
}

class Captioner {
  /** The lines as heard, oldest first. */
  readonly lines: CaptionLine[] = [];
  /** The lines in each other language somebody asked for. */
  readonly linesBy = new Map<string, CaptionLine[]>();
  readonly subscribers = new Map<Subscriber, string>();
  /** The last thing that went wrong, for whoever asks why there are no lines. */
  error = "";
  /** What the ear says the sound is in, or the store said it was; "" until one of them has. */
  language = "";
  /** The file's SHA-256, once described. */
  hash = "";
  private model = "";
  private decoder: Decoder | null = null;
  private detach: (() => void) | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private inFlight = 0;
  private stopped = false;
  private complainedAt = 0;
  private windows = 0;
  private audioUntil = 0;
  private lastEmittedAt = -Infinity;
  private readonly requests = new Set<AbortController>();
  /** What the channel is playing, when the store is to be told. */
  private readonly media: ChannelMedia | null;
  private readonly transcriptId: string | null;
  /** What the store had, by language ("" for the original), and which stored moments have been read out. */
  private readonly known = new Map<string, TranscriptLine[]>();
  private readonly readOut = new Set<number>();
  private readonly asked = new Set<string>();
  /** Lines heard or translated here and not yet kept, by language. */
  private readonly unsaved = new Map<string, TranscriptLine[]>();
  private flush: ReturnType<typeof setTimeout> | null = null;
  /** Translations in order, per language: a slow one must not overtake the next. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly translating = new Set<string>();
  private readonly nextTranslation = new Map<string, { line: CaptionLine; mediaStart: number | null }>();

  constructor(
    readonly id: string,
    private readonly options: CaptionsOptions,
    private readonly onStop: () => void,
  ) {
    this.media = options.mediaOf?.(id) ?? null;
    this.transcriptId = this.media ? transcriptIdOf(this.media.media) : null;
  }

  private get windowBytes(): number {
    return Math.round(((this.options.windowMs ?? WINDOW_MS) / 1000) * RATE) * 2;
  }

  private get windowSeconds(): number {
    return (this.options.windowMs ?? WINDOW_MS) / 1000;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
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
    void this.consult("");
    void this.record();
    return true;
  }

  /** Tell nixamp.com about the file itself, once: its hash and what this server knows of it. */
  private async record(): Promise<void> {
    const describe = this.media?.describe;
    if (!describe) return;
    const session = this.options.session();
    if (session === null) return;
    try {
      const described = await describe();
      if (!described || this.stopped) return;
      this.hash = described.id;
      const got = await keepMedia(session, described.id, described.keep, this.options.fetcher ?? fetch);
      if (!got.ok) this.complain(`the record was not kept: ${got.error}`);
      else this.options.onEvent?.(`captions for "${this.id}": nixamp.com/hash/${described.id.slice(0, 12)}… knows this file`);
    } catch (error) {
      this.complain(`could not describe the file: ${(error as Error).message}`);
    }
  }

  /** Ask the store what it already knows of this media in a language, once. */
  private async consult(language: string): Promise<void> {
    if (!this.transcriptId || this.asked.has(language)) return;
    this.asked.add(language);
    const session = this.options.session();
    if (session === null) return;
    const got = await fetchTranscript(session, this.transcriptId, language, this.options.fetcher ?? fetch, true);
    if (this.stopped) return;
    if (!got.ok) {
      if (got.status !== 404) this.complain(`the store did not answer: ${got.error}`);
      return;
    }
    // A row's model/language could have been updated while its old bad lines remained.
    // Trust individual lines made with the corrected native pipeline only.
    const usable = got.body.lines.filter((line) => line.revision === NATIVE_REVISION && reliableText(line.text, line.end - line.start));
    this.known.set(language, usable);
    if (usable.length > 0) {
      this.options.onEvent?.(`captions for "${this.id}": the store knows ${usable.length} lines of this${language ? ` in ${language}` : ""}`);
    }
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
      const duration = this.options.windowMs ?? WINDOW_MS;
      const until = Math.max(this.audioUntil + duration, this.now() - rest.length / (RATE * 2) * 1000);
      this.audioUntil = until;
      const index = this.windows;
      this.windows += 1;
      void this.hear(Buffer.from(window), until - (this.options.windowMs ?? WINDOW_MS), until, index);
    }
  }

  private async hear(pcm: Buffer, at: number, until: number, index: number): Promise<void> {
    if (isQuiet(pcm)) return;
    const span = this.media ? mediaSpan(this.media, index, this.windowSeconds, at, until) : null;
    if (span) {
      const stored = covered(this.known.get("") ?? [], span.start, span.end);
      if (stored.length > 0) {
        // The store has been through this moment: read it out, and let the ear rest.
        for (const line of stored) {
          if (this.readOut.has(line.start)) continue;
          this.readOut.add(line.start);
          const lineAt = at + (line.start - span.start) * 1000;
          this.emit({ channel: this.id, at: lineAt, until: lineAt + (line.end - line.start) * 1000, text: line.text,
            ...(line.language ? { language: line.language } : {}), ...(line.voiceProfile ? { voiceProfile: line.voiceProfile } : {}) }, line.start);
        }
        return;
      }
    }
    if (this.inFlight >= IN_FLIGHT) return;
    const session = this.options.session();
    if (session === null) {
      this.complain("this server is not signed in, so it cannot caption; `nixamp login` on it");
      return;
    }
    this.inFlight += 1;
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), LIVE_DEADLINE_MS);
    try {
      const wav = wavAround(pcm);
      const url = new URL(`${session.site.replace(/\/+$/, "")}/api/v1/speech/transcribe`);
      // Let each audio window detect its own language. Cached text and a viewer's
      // translation selection must never constrain the recognizer.
      url.searchParams.set("live", "1");
      const response = await (this.options.fetcher ?? fetch)(url.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "audio/wav" },
        body: new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer]),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as { text?: string; language?: string; model?: string; error?: string };
      if (!response.ok) {
        this.complain(body.error ?? `nixamp.com answered ${response.status}`);
        return;
      }
      const text = reliableText(body.text ?? "", (until - at) / 1000);
      if (text === "" || this.stopped || controller.signal.aborted || this.now() - until > LIVE_DEADLINE_MS) return;
      this.error = "";
      if (body.model) this.model = body.model;
      const line: CaptionLine = { channel: this.id, at, until, text, ...(body.language ? { language: body.language } : {}), voiceProfile: voiceProfile(pcm) };
      this.emit(line, span?.start ?? null);
      if (span) this.keep("", { start: span.start, end: span.end, text, language: line.language, voiceProfile: line.voiceProfile, revision: NATIVE_REVISION });
    } catch (error) {
      this.complain(`could not reach the ear: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
      this.inFlight -= 1;
    }
  }

  /** A line as heard, to whoever wants the original, and translated to whoever wants another language. */
  private emit(line: CaptionLine, mediaStart: number | null): void {
    if (line.at <= this.lastEmittedAt) return;
    this.lastEmittedAt = line.at;
    this.language = line.language ?? "";
    this.lines.push(line);
    while (this.lines.length > KEEP) this.lines.shift();
    for (const [subscriber, language] of this.subscribers) {
      if (language === "" || language === this.language) this.tell(subscriber, line);
    }
    for (const language of this.wanted()) this.translated(language, line, mediaStart);
  }

  private tell(subscriber: Subscriber, line: CaptionLine): void {
    try {
      subscriber(line);
    } catch {
      // A listener that throws is not this channel's problem.
    }
  }

  /** The languages somebody wants besides the one being heard. */
  private wanted(): Set<string> {
    const languages = new Set<string>();
    for (const language of this.subscribers.values()) if (language !== "" && language !== this.language) languages.add(language);
    return languages;
  }

  /** The line in another language: from the store when it has been through this moment, from nixamp.com otherwise. */
  private translated(language: string, line: CaptionLine, mediaStart: number | null): void {
    // One active request and the latest pending line per target, never a promise
    // chain containing minutes of stale commentary.
    if (this.translating.has(language)) {
      this.nextTranslation.set(language, { line, mediaStart });
      return;
    }
    this.translating.add(language);
    const chain = Promise.resolve().then(async () => {
      if (this.stopped || !this.wanted().has(language) || this.now() - line.until > LIVE_DEADLINE_MS) return;
      let text = "";
      const stored = mediaStart === null ? null : lineAt(this.known.get(language) ?? [], mediaStart);
      if (stored && stored.original === line.text) {
        text = stored.text;
      } else {
        const session = this.options.session();
        if (session === null) return;
        if (!line.language) return;
        const got = await translateTexts(session, [line.text], line.language, language, this.options.fetcher ?? fetch, AbortSignal.timeout(LIVE_DEADLINE_MS));
        if (!got.ok) {
          this.complain(`could not translate to ${language}: ${got.error}`);
          return;
        }
        text = reliableText(got.body.texts[0] ?? "", (line.until - line.at) / 1000);
        if (text === "") return;
        if (mediaStart !== null) this.keep(language, { start: mediaStart, end: round(mediaStart + (line.until - line.at) / 1000), text, original: line.text, revision: NATIVE_REVISION });
      }
      if (this.stopped || !this.wanted().has(language) || this.now() - line.until > LIVE_DEADLINE_MS) return;
      const said: CaptionLine = { ...line, text, language, sourceLanguage: line.language, original: line.text };
      const lines = this.linesBy.get(language) ?? [];
      lines.push(said);
      while (lines.length > KEEP) lines.shift();
      this.linesBy.set(language, lines);
      for (const [subscriber, wanted] of this.subscribers) if (wanted === language) this.tell(subscriber, said);
    });
    this.chains.set(language, chain.catch(() => undefined).finally(() => {
      this.translating.delete(language);
      const next = this.nextTranslation.get(language);
      this.nextTranslation.delete(language);
      if (next && !this.stopped) this.translated(language, next.line, next.mediaStart);
    }));
  }

  /** A line for the store, kept with the others of its language until the next flush. */
  private keep(language: string, line: TranscriptLine): void {
    if (!this.media) return;
    const lines = this.unsaved.get(language) ?? [];
    lines.push(line);
    this.unsaved.set(language, lines);
    if (lines.length >= FLUSH_LINES) {
      void this.flushNow();
      return;
    }
    if (this.flush === null) {
      this.flush = setTimeout(() => void this.flushNow(), this.options.flushMs ?? FLUSH_MS);
      this.flush.unref?.();
    }
  }

  /** Everything not yet kept, to the store. Never throws; a store that is away costs nothing but the keeping. */
  private async flushNow(): Promise<void> {
    if (this.flush) clearTimeout(this.flush);
    this.flush = null;
    if (!this.media || !this.transcriptId) return;
    const session = this.options.session();
    if (session === null) return;
    const batches = [...this.unsaved.entries()].filter(([, lines]) => lines.length > 0);
    this.unsaved.clear();
    for (const [language, lines] of batches) {
      const got = await keepLines(session, this.transcriptId, {
        media: this.media.media,
        title: this.media.title,
        language,
        ...(language === "" ? {} : { translatedFrom: this.language }),
        ...(this.model ? { model: this.model } : {}),
        lines,
      }, this.options.fetcher ?? fetch);
      if (!got.ok) this.complain(`the store did not keep ${lines.length} lines: ${got.error}`);
    }
  }

  /** Said once a minute at most: a broken ear would otherwise say so twelve times a minute. */
  private complain(message: string): void {
    this.error = message;
    const now = this.now();
    if (now - this.complainedAt < 60_000) return;
    this.complainedAt = now;
    this.options.onEvent?.(`captions for "${this.id}": ${message}`);
  }

  subscribe(subscriber: Subscriber, language = ""): () => void {
    this.subscribers.set(subscriber, language);
    if (language !== "") void this.consult(language);
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

  recent(after: number, language = ""): CaptionLine[] {
    const lines = language === "" ? this.lines : [...this.lines.filter((line) => line.language === language), ...(this.linesBy.get(language) ?? [])].sort((a, b) => a.at - b.at);
    return after > 0 ? lines.filter((line) => line.at > after) : [...lines];
  }

  status(): CaptionStatus {
    return {
      on: true,
      lines: this.lines.length,
      error: this.error,
      language: this.language,
      known: this.known.get("")?.length ?? 0,
      languages: [...this.linesBy.keys()],
      hash: this.hash,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.nextTranslation.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.detach?.();
    this.detach = null;
    this.decoder?.end();
    this.decoder = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.subscribers.clear();
    void this.flushNow();
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

  capacity(id: string): boolean { return this.running.has(id) || this.running.size < MAX_CAPTIONERS; }

  /** Voice requests are constrained to captions this channel actually produced. */
  async voiceRequest(id: string, at: number | null, language: string, voice: string, signal: AbortSignal, grant = ""): Promise<Response> {
    const session = this.options.session();
    if (!session) throw new SpeechError("this server must sign in to use translated audio", 503);
    if (at === null) return (this.options.fetcher ?? fetch)(`${session.site.replace(/\/+$/, "")}/api/v1/speech/voices`, {
      headers: { authorization: `Bearer ${session.token}` }, signal,
    });
    if (!language) throw new SpeechError("choose a translation language first", 400);
    if (!/^nxd_[A-Za-z0-9_-]{43}$/.test(grant)) throw new SpeechError("sign in to enable translated audio", 401);
    const line = this.recent(id, 0, language).find(line => line.at === at);
    if (!line || (this.options.now ?? Date.now)() - line.until > 30_000) throw new SpeechError("that live caption is no longer available for audio", 404);
    return (this.options.fetcher ?? fetch)(`${session.site.replace(/\/+$/, "")}/api/v1/speech/synthesize`, {
      method: "POST", headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({ text: line.text, language, voice, profile: line.voiceProfile, channel: id }), signal,
    });
  }

  /**
   * Lines for a channel as they are heard, starting the captioner if it is
   * not running. Null when there is no such channel. The returned function
   * is how to stop listening; the captioner itself stops a minute after the
   * last listener does. A language asks for the lines translated into it;
   * "" is the original.
   */
  subscribe(id: string, subscriber: Subscriber, language = ""): (() => void) | null {
    if (!this.capacity(id)) return null;
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
    return captioner.subscribe(subscriber, language);
  }

  /** The recent lines of a channel, oldest first, after a moment when given, in a language when asked. Empty when nobody has asked for them. */
  recent(id: string, after = 0, language = ""): CaptionLine[] {
    const captioner = this.running.get(id);
    return captioner ? captioner.recent(after, language) : [];
  }

  /** Whether a channel is being captioned, and what last went wrong if the lines are not coming. */
  status(id: string): CaptionStatus {
    const captioner = this.running.get(id);
    return captioner ? captioner.status() : { on: false, lines: 0, error: "", language: "", known: 0, languages: [], hash: "" };
  }

  stopAll(): void {
    for (const captioner of [...this.running.values()]) captioner.stop();
  }
}

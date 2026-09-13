/**
 * Speech to text: a line said into a microphone, heard by nixamp.com.
 *
 * The ear is Whisper, run through Transformers.js: an Apache-2.0 library
 * carrying MIT-licensed models, on this machine's own CPU. Nothing leaves
 * for a speech vendor, and nothing is billed. The web page, the CLI and the
 * MCP tools all send the same thing -- a short WAV -- to the same route,
 * and get words back; the route can also drop those words straight into a
 * trollbox, which is what dictating a line to a room means.
 *
 * The library is an optional dependency on purpose. It is hundreds of
 * megabytes with the ONNX runtime under it, native per platform, and the
 * CLI tarball's promise is "pure JavaScript, runs anywhere a Node does".
 * So a `nixamp serve` on a laptop answers 503 to this, and every client
 * asks nixamp.com instead -- which is where a trollbox line has to be
 * signed in anyway.
 *
 * A WAV is decoded here rather than by ffmpeg because nixamp.com has no
 * ffmpeg (see the Dockerfile). Anything else is converted before it is
 * sent: the browser resamples what it recorded, the CLI runs ffmpeg.
 */
import { join } from "node:path";
import { stateDir } from "./daemon.ts";

/** What Whisper listens at. Everything is brought to this before it is heard. */
export const RATE = 16_000;
/** A trollbox line, said out loud, is seconds long; a minute is the ceiling. */
export const MAX_SECONDS = 60;
/** A minute of 16-bit mono at 16 kHz is under 2 MB; 48 kHz stereo is under 12. */
export const MAX_BYTES = 12 * 1024 * 1024;
/** How often one account may ask. Twelve a minute is a conversation, not a firehose. */
export const ASKS_PER_MINUTE = 12;
/** How many may wait for the one CPU. Past this, the honest answer is "later". */
export const QUEUE_LIMIT = 8;
export const DEFAULT_MODEL = "onnx-community/whisper-base";

export class SpeechError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface Heard {
  text: string;
  /** How long the audio was, in seconds. */
  seconds: number;
}

/** Mono samples in [-1, 1] at RATE -> words. What the loaded model is, to this file. */
export type Recognizer = (pcm: Float32Array, options: { language?: string }) => Promise<{ text: string }>;

export interface SpeechOptions {
  /** A Hugging Face model id; NIXAMP_STT_MODEL otherwise; whisper-base by default. */
  model?: string;
  /** Where the model's files are kept between runs. */
  cacheDir?: string;
  /** How the model is loaded. The tests hand in a fake; nothing else does. */
  load?: (model: string, cacheDir: string) => Promise<Recognizer>;
  now?: () => number;
}

export interface Wav {
  rate: number;
  channels: number;
  /** Mixed down to one channel, in [-1, 1]. */
  samples: Float32Array;
}

/** Whether these bytes are a RIFF/WAVE file, whatever the request called them. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
}

/**
 * A WAV file's samples, mixed to mono. PCM of 8, 16, 24 or 32 bits, or
 * 32-bit float; the WAVE_FORMAT_EXTENSIBLE wrapper around either. That is
 * what every encoder that matters writes, including the one in the page.
 */
export function decodeWav(bytes: Uint8Array): Wav {
  if (!isWav(bytes)) throw new SpeechError("send a WAV file", 415);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && length >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // Extensible: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && length >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataAt = body;
      // A streamed WAV says 0 or 0xFFFFFFFF for a length it did not know yet.
      dataLength = length === 0 || body + length > bytes.length ? bytes.length - body : length;
      break;
    }
    at = body + length + (length & 1);
  }
  if (dataAt < 0 || channels < 1 || rate < 8000 || rate > 192_000) throw new SpeechError("that WAV has no sound in it", 415);
  const pcm = format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32);
  const float = format === 3 && bits === 32;
  if (!pcm && !float) throw new SpeechError(`WAV format ${format} at ${bits} bits is not one this reads: send 16-bit PCM`, 415);
  const width = bits / 8;
  const frames = Math.floor(dataLength / (width * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = dataAt + (frame * channels + channel) * width;
      if (float) sum += view.getFloat32(offset, true);
      else if (bits === 8) sum += (bytes[offset] as number) / 128 - 1;
      else if (bits === 16) sum += view.getInt16(offset, true) / 32768;
      else if (bits === 24) sum += (((bytes[offset + 2] as number) << 24) | ((bytes[offset + 1] as number) << 16) | ((bytes[offset] as number) << 8)) / 2147483648;
      else sum += view.getInt32(offset, true) / 2147483648;
    }
    samples[frame] = sum / channels;
  }
  return { rate, channels, samples };
}

/**
 * Samples at one rate, at another. Down is an average over each output
 * sample's span, which is a crude low-pass and enough for speech; up is a
 * straight line between neighbours. Whisper resamples nothing itself.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j] as number;
      out[i] = sum / (end - start);
    }
  } else {
    for (let i = 0; i < length; i++) {
      const position = i * ratio;
      const left = Math.floor(position);
      const right = Math.min(samples.length - 1, left + 1);
      const mix = position - left;
      out[i] = (samples[left] as number) * (1 - mix) + (samples[right] as number) * mix;
    }
  }
  return out;
}

/** 16-bit mono PCM WAV bytes from samples: what the CLI's tests, and anybody, can send. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
  }
  return bytes;
}

/** Whisper's own spacing and blank-audio tokens, tidied into a line. */
export function tidy(text: string): string {
  return text.replace(/\[[A-Z_ ]+\]|\([A-Za-z ]+\)/g, " ").replace(/\s+/g, " ").trim();
}

/** A two-letter language code, or nothing: Whisper guesses when not told. */
export function languageOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : undefined;
}

/** The module, as much of it as this file touches. Typed here so the import can be by name. */
interface Transformers {
  env: { cacheDir?: string; allowLocalModels?: boolean };
  pipeline(task: "automatic-speech-recognition", model: string, options: { dtype: string }): Promise<
    (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>
  >;
}

async function loadWhisper(model: string, cacheDir: string): Promise<Recognizer> {
  // By name held in a variable: an optional dependency that is not on disk
  // must fail here, at the first ask, and not when the file is imported.
  const name = "@huggingface/transformers";
  let transformers: Transformers;
  try {
    transformers = (await import(name)) as Transformers;
  } catch {
    throw new SpeechError("this nixamp cannot hear: @huggingface/transformers is not installed here. nixamp.com can.", 503);
  }
  transformers.env.cacheDir = cacheDir;
  const recognize = await transformers.pipeline("automatic-speech-recognition", model, { dtype: "q8" });
  return async (pcm, { language }) => {
    const heard = await recognize(pcm, {
      // Whisper hears thirty seconds at a time; longer is heard in overlapping pieces.
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language, task: "transcribe" } : {}),
    });
    return { text: Array.isArray(heard) ? heard.map((piece) => piece.text).join(" ") : heard.text };
  };
}

export class Speech {
  readonly model: string;
  private readonly cacheDir: string;
  private readonly load: (model: string, cacheDir: string) => Promise<Recognizer>;
  private readonly now: () => number;
  private recognizer: Promise<Recognizer> | null = null;
  /** One at a time: the model is CPU-bound, and two at once is slower than two in turn. */
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly asked = new Map<string, { minute: number; count: number }>();

  constructor(options: SpeechOptions = {}) {
    this.model = options.model ?? process.env["NIXAMP_STT_MODEL"] ?? DEFAULT_MODEL;
    this.cacheDir = options.cacheDir ?? process.env["NIXAMP_STT_CACHE"] ?? join(stateDir(), "models");
    this.load = options.load ?? loadWhisper;
    this.now = options.now ?? (() => Date.now());
  }

  private ear(): Promise<Recognizer> {
    this.recognizer ??= this.load(this.model, this.cacheDir).catch((error: unknown) => {
      // A failed load is tried again next time, not remembered forever.
      this.recognizer = null;
      throw error;
    });
    return this.recognizer;
  }

  /**
   * Load the model now, so the first person to speak is not the one who
   * waits for the download. Says whether it could; never throws.
   */
  async warm(): Promise<boolean> {
    try {
      await this.ear();
      return true;
    } catch {
      return false;
    }
  }

  /** Whether this account may ask now, and the bookkeeping if so. */
  allow(accountId: string): void {
    const minute = Math.floor(this.now() / 60_000);
    const record = this.asked.get(accountId) ?? { minute, count: 0 };
    if (record.minute !== minute) {
      record.minute = minute;
      record.count = 0;
    }
    if (record.count >= ASKS_PER_MINUTE) throw new SpeechError(`${ASKS_PER_MINUTE} a minute is plenty`, 429);
    record.count += 1;
    this.asked.set(accountId, record);
    if (this.asked.size > 5000) {
      for (const [id, one] of this.asked) if (one.minute !== minute) this.asked.delete(id);
    }
  }

  /** The words in a WAV. Refuses what is not a WAV, or is too long, with a status. */
  async transcribe(bytes: Uint8Array, options: { language?: string } = {}): Promise<Heard> {
    if (bytes.length > MAX_BYTES) throw new SpeechError(`that is too much sound: ${MAX_SECONDS} seconds at most`, 413);
    const wav = decodeWav(bytes);
    const seconds = wav.samples.length / wav.rate;
    if (seconds > MAX_SECONDS) throw new SpeechError(`that is ${Math.round(seconds)} seconds; ${MAX_SECONDS} at most`, 413);
    if (wav.samples.length < wav.rate / 10) return { text: "", seconds };
    const pcm = resample(wav.samples, wav.rate, RATE);
    if (this.waiting >= QUEUE_LIMIT) throw new SpeechError("too many people are talking at once; try again in a moment", 503);
    this.waiting += 1;
    const turn = this.tail.then(async () => {
      const recognize = await this.ear();
      return recognize(pcm, options.language ? { language: options.language } : {});
    });
    // The queue moves on whether or not this one was heard.
    this.tail = turn.catch(() => undefined);
    try {
      const heard = await turn;
      return { text: tidy(heard.text), seconds };
    } finally {
      this.waiting -= 1;
    }
  }
}

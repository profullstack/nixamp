/**
 * Dictating a line: the parts of it that are arithmetic.
 *
 * The page records with MediaRecorder, which hands back whatever the
 * browser likes to write (webm/opus in Chrome and Firefox, mp4/aac in
 * Safari), decodes that with the audio API, and sends nixamp.com a small
 * 16 kHz mono WAV -- the one shape every browser can make and the server
 * can read without ffmpeg. This file is the WAV and the choices; the DOM
 * and the microphone stay in app.ts.
 */

/** What Whisper listens at. */
export const DICTATE_RATE = 16_000;
/** Tap, talk, tap: past this it stops by itself. A trollbox line is short. */
export const DICTATE_MAX_MS = 30_000;

/** The first container this browser records, out of the ones the decoder reads back. */
export function recordingMime(supported: (type: string) => boolean): string {
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]
    .find((type) => supported(type)) ?? "";
}

/** 16-bit mono PCM WAV bytes from samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, rate = DICTATE_RATE): Uint8Array {
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

/** What was heard, added to what was already typed: after a space, never over it. */
export function joinDictated(typed: string, heard: string): string {
  const before = typed.trimEnd();
  const words = heard.trim();
  if (words === "") return typed;
  return before === "" ? words : `${before} ${words}`;
}

/** The seconds a recording has run, as the button shows them. */
export function listeningLabel(startedAt: number, now: number): string {
  return `● ${Math.max(0, Math.floor((now - startedAt) / 1000))}s`;
}

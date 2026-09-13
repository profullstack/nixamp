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

export { encodeWav } from "../../src/pcm-wav.ts";

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

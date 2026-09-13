import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASKS_PER_MINUTE, MAX_SECONDS, QUEUE_LIMIT, RATE, Speech, SpeechError,
  decodeWav, encodeWav, isWav, languageOf, resample, tidy,
} from "../src/speech.ts";

/** A sine at `hz`, `seconds` long, at `rate`. */
function tone(hz: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

test("a WAV round-trips through the encoder and the decoder, at any common shape", () => {
  const wav = encodeWav(tone(440, 0.5, RATE));
  assert.ok(isWav(wav));
  assert.equal(isWav(new TextEncoder().encode("not a wav at all")), false);
  const back = decodeWav(wav);
  assert.equal(back.rate, RATE);
  assert.equal(back.channels, 1);
  assert.equal(back.samples.length, RATE / 2);
  assert.ok(Math.abs((back.samples[4] as number) - (tone(440, 0.5, RATE)[4] as number)) < 1e-4);

  // Stereo 24-bit 48 kHz, hand-built: the decoder mixes the channels down.
  const frames = 480;
  const stereo = new Uint8Array(44 + frames * 6);
  stereo.set(encodeWav(new Float32Array(0), 48_000).subarray(0, 44));
  const view = new DataView(stereo.buffer);
  view.setUint16(22, 2, true);
  view.setUint16(34, 24, true);
  view.setUint32(28, 48_000 * 6, true);
  view.setUint16(32, 6, true);
  view.setUint32(40, frames * 6, true);
  view.setUint32(4, 36 + frames * 6, true);
  for (let frame = 0; frame < frames; frame++) {
    // Left is full scale positive, right is silence: the mix is half.
    const at = 44 + frame * 6;
    stereo[at] = 0xff; stereo[at + 1] = 0xff; stereo[at + 2] = 0x7f;
    stereo[at + 3] = 0; stereo[at + 4] = 0; stereo[at + 5] = 0;
  }
  const mixed = decodeWav(stereo);
  assert.equal(mixed.rate, 48_000);
  assert.equal(mixed.channels, 2);
  assert.equal(mixed.samples.length, frames);
  assert.ok(Math.abs((mixed.samples[0] as number) - 0.5) < 1e-3);

  // Float WAV, and the extensible wrapper naming PCM inside.
  const float = encodeWav(new Float32Array(0), RATE);
  const fl = new Uint8Array(44 + 8);
  fl.set(float.subarray(0, 44));
  const fv = new DataView(fl.buffer);
  fv.setUint16(20, 3, true);
  fv.setUint16(34, 32, true);
  fv.setUint32(40, 8, true);
  fv.setFloat32(44, -0.25, true);
  fv.setFloat32(48, 0.25, true);
  assert.deepEqual([...decodeWav(fl).samples], [-0.25, 0.25]);

  // Not a WAV, and a WAV of a kind this does not read, are refused with a status.
  assert.throws(() => decodeWav(new Uint8Array(10)), (error: unknown) => error instanceof SpeechError && error.status === 415);
  const odd = encodeWav(tone(440, 0.1, RATE));
  new DataView(odd.buffer).setUint16(20, 85, true); // MP3 inside a WAV
  assert.throws(() => decodeWav(odd), /send 16-bit PCM/);
});

test("resampling keeps the length in proportion and the signal recognisable", () => {
  const at48 = tone(440, 1, 48_000);
  const down = resample(at48, 48_000, RATE);
  assert.equal(down.length, RATE);
  // The peak survives the averaging, roughly.
  assert.ok(Math.max(...down.subarray(0, 200)) > 0.4);
  const up = resample(tone(440, 1, 8000), 8000, RATE);
  assert.equal(up.length, RATE);
  assert.equal(resample(at48, 48_000, 48_000), at48);
  assert.equal(resample(new Float32Array(0), 8000, RATE).length, 0);
});

test("whisper's asides are tidied out and a language is two letters or nothing", () => {
  assert.equal(tidy("  hello   there [BLANK_AUDIO] (upbeat music) "), "hello there");
  assert.equal(languageOf("EN"), "en");
  assert.equal(languageOf(" de "), "de");
  assert.equal(languageOf("english"), undefined);
  assert.equal(languageOf(42), undefined);
  assert.equal(languageOf(null), undefined);
});

test("the ear is loaded once, hears one at a time, and refuses what is too long or too many", async () => {
  let loads = 0;
  let running = 0;
  let mostAtOnce = 0;
  const heard: { length: number; language?: string }[] = [];
  let now = 60_000 * 100;
  const speech = new Speech({
    model: "fake/whisper",
    cacheDir: "/nowhere",
    now: () => now,
    load: async () => {
      loads += 1;
      return async (pcm, options) => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        heard.push({ length: pcm.length, ...(options.language ? { language: options.language } : {}) });
        return { text: ` Hello, room. [BLANK_AUDIO] ` };
      };
    },
  });
  assert.equal(speech.model, "fake/whisper");
  assert.equal(await speech.warm(), true);

  const clip = encodeWav(tone(300, 1, 48_000), 48_000);
  const answers = await Promise.all([speech.transcribe(clip), speech.transcribe(clip, { language: "en" }), speech.transcribe(clip)]);
  assert.equal(loads, 1);
  assert.equal(mostAtOnce, 1);
  assert.deepEqual(answers.map((one) => one.text), ["Hello, room.", "Hello, room.", "Hello, room."]);
  assert.equal(answers[0]?.seconds, 1);
  // Resampled to 16 kHz before it is heard, and told the language only when given.
  assert.equal(heard[0]?.length, RATE);
  assert.equal(heard[1]?.language, "en");
  assert.equal(heard[0]?.language, undefined);

  // Under a tenth of a second is not worth waking the model for.
  assert.deepEqual(await speech.transcribe(encodeWav(new Float32Array(100))), { text: "", seconds: 100 / RATE });
  assert.equal(heard.length, 3);

  // Too long, and not a WAV, are refused with a status before anything is heard.
  await assert.rejects(
    () => speech.transcribe(encodeWav(new Float32Array((MAX_SECONDS + 1) * RATE))),
    (error: unknown) => error instanceof SpeechError && error.status === 413,
  );
  await assert.rejects(() => speech.transcribe(new Uint8Array(3)), (error: unknown) => error instanceof SpeechError && error.status === 415);

  // The throttle: so many a minute per account, and a new minute starts over.
  for (let i = 0; i < ASKS_PER_MINUTE; i++) speech.allow("acct-1");
  assert.throws(() => speech.allow("acct-1"), (error: unknown) => error instanceof SpeechError && error.status === 429);
  speech.allow("acct-2");
  now += 60_000;
  speech.allow("acct-1");

  // The queue has a ceiling, and the ceiling is a 503, not a wait.
  const slow = new Speech({
    load: async () => async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { text: "late" };
    },
  });
  const pending = Array.from({ length: QUEUE_LIMIT }, () => slow.transcribe(clip));
  await assert.rejects(() => slow.transcribe(clip), /too many people/);
  assert.equal((await Promise.all(pending)).length, QUEUE_LIMIT);
});

test("an ear that fails to load says so with a status, and is tried again next time", async () => {
  let attempts = 0;
  const speech = new Speech({
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new SpeechError("this nixamp cannot hear", 503);
      return async () => ({ text: "now it can" });
    },
  });
  assert.equal(await speech.warm(), false);
  const clip = encodeWav(tone(300, 0.5, RATE));
  assert.equal((await speech.transcribe(clip)).text, "now it can");
  assert.equal(attempts, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Captions, type CaptionLine } from "../src/captions.ts";
import { RATE, Speech, encodeWav, reliableText, whisperRecognizer, type AsrPipeline, type Transformers } from "../src/speech.ts";
import { voiceProfile } from "../src/voice-profile.ts";

function pcm(hz = 120, seconds = 5): Buffer {
  const bytes = Buffer.alloc(RATE * seconds * 2);
  for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * i / RATE)), i * 2);
  return bytes;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test("automatic recognition detects Spanish and requests native transcription with a short decoding budget", async () => {
  const calls: Record<string, unknown>[] = [];
  const pipeline = Object.assign(async (_pcm: Float32Array, options: Record<string, unknown>) => {
    calls.push(options); return { text: "Queda un minuto de combate." };
  }, {
    processor: async () => ({ input_features: "audio" }),
    model: Object.assign(async () => ({ logits: { data: [0, 0.1, 0.9] } }), {
      generation_config: { decoder_start_token_id: 0, is_multilingual: true, lang_to_id: { "<|en|>": 1, "<|es|>": 2 } },
    }),
  }) as AsrPipeline;
  const transformers = { Tensor: class {} } as unknown as Transformers;
  const recognize = whisperRecognizer(transformers, pipeline);
  const heard = await recognize(new Float32Array(RATE * 5), {});
  assert.equal(heard.language, "es");
  assert.equal(heard.text, "Queda un minuto de combate.");
  assert.equal(calls[0]?.task, "transcribe");
  assert.equal(calls[0]?.language, "es");
  assert.ok(Number(calls[0]?.max_new_tokens) < 100);
});

test("silent audio never reaches ASR; runaway phrases never become captions", async () => {
  let calls = 0;
  const speech = new Speech({ load: async () => async () => { calls++; return { text: "silence hallucination" }; } });
  assert.equal((await speech.transcribe(encodeWav(new Float32Array(RATE * 5)))).text, "");
  assert.equal(calls, 0);
  for (const phrase of ["We'll get 2. ", "from the side, ", "the arms, ", "Salen Apacarcy, "]) {
    assert.equal(reliableText(phrase.repeat(30), 5), "");
  }
  assert.equal(reliableText("No, no, no. Moreno avanza.", 5), "No, no, no. Moreno avanza.");
});

test("voice matching measures pitch and leaves silence and ambiguous pitch unknown", () => {
  assert.equal(voiceProfile(pcm(120)), "lower");
  assert.equal(voiceProfile(pcm(230)), "higher");
  assert.equal(voiceProfile(pcm(170)), "unknown");
  assert.equal(voiceProfile(Buffer.alloc(RATE * 10)), "unknown");
});

test("native language switches follow the audio while translations use each line's source and keep only the latest pending work", async () => {
  let feed: (bytes: Buffer) => void = () => undefined;
  let now = 1_000_000;
  let heard = 0;
  let finish: (() => void) | undefined;
  const sources: string[] = [];
  const native: CaptionLine[] = [], german: CaptionLine[] = [];
  const captions = new Captions({
    ffmpeg: [], session: () => ({ site: "https://example.test", token: "server" }), now: () => now,
    listen: () => () => undefined,
    decoder: onPcm => { feed = onPcm; return { write: () => true, end: () => undefined }; },
    fetcher: (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("transcribe")) {
        assert.equal(url.searchParams.has("language"), false);
        heard++;
        return Response.json({ text: `line ${heard}`, language: heard === 1 ? "es" : "pt" });
      }
      const ask = JSON.parse(String(init?.body));
      sources.push(ask.from);
      if (sources.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ texts: [`translated ${ask.texts[0]}`] });
    }) as typeof fetch,
  });
  captions.subscribe("ufc", line => native.push(line));
  captions.subscribe("ufc", line => german.push(line), "de");
  for (let i = 0; i < 3; i++) { now += 5000; feed(pcm()); await settle(); }
  assert.deepEqual(native.map(line => line.language), ["es", "pt", "pt"]);
  assert.equal(sources.length, 1);
  finish?.(); await settle();
  assert.deepEqual(sources, ["es", "pt"]);
  assert.deepEqual(german.map(line => line.original), ["line 1", "line 3"]);
  assert.deepEqual(captions.recent("ufc", 0, "es").map(line => line.text), ["line 1"]);
  captions.stopAll();
});

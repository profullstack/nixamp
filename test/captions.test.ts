import { test } from "node:test";
import assert from "node:assert/strict";
import { Captions, IN_FLIGHT, KEEP, WINDOW_MS, decoderArgs, isQuiet, wavAround, type CaptionLine, type Decoder } from "../src/captions.ts";
import { RATE, decodeWav } from "../src/speech.ts";
import type { Listener } from "../src/channels.ts";

/** Five seconds of 16-bit mono at 16 kHz, loud or silent. */
function window(loud: boolean, seconds = WINDOW_MS / 1000): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2);
  if (loud) for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  return pcm;
}

/** A channel that keeps its listeners, so the test can feed them; and a decoder that passes bytes straight through as PCM. */
function fakeWorld(options: { answer?: (wav: Uint8Array) => { status: number; body: unknown }; hasChannel?: (id: string) => boolean } = {}) {
  const listeners = new Map<string, Listener>();
  const detached: string[] = [];
  const asked: Uint8Array[] = [];
  let decodersEnded = 0;
  let now = 1_000_000;
  const decoder = (onPcm: (pcm: Buffer) => void, _onEnd: () => void): Decoder => ({
    write: (chunk) => { onPcm(chunk); return true; },
    end: () => { decodersEnded += 1; },
  });
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const blob = init?.body as Blob;
    const wav = new Uint8Array(await blob.arrayBuffer());
    asked.push(wav);
    const reply = options.answer ? options.answer(wav) : { status: 200, body: { text: `heard ${asked.length}`, seconds: 5 } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const events: string[] = [];
  const captions = new Captions({
    ffmpeg: ["ffmpeg"],
    listen: (id, listener) => {
      if (options.hasChannel && !options.hasChannel(id)) return null;
      listeners.set(id, listener);
      return () => { listeners.delete(id); detached.push(id); };
    },
    session: () => ({ site: "https://nixamp.test/", token: "nxa_server" }),
    fetcher,
    decoder,
    now: () => now,
    onEvent: (message) => events.push(message),
    idleMs: 10,
  });
  return {
    captions, listeners, detached, asked, events,
    feed: (id: string, pcm: Buffer) => listeners.get(id)?.write(pcm),
    tick: (ms: number) => { now += ms; },
    endedDecoders: () => decodersEnded,
    settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
  };
}

test("a window of silence is silence, a WAV wraps PCM without touching it, and ffmpeg is asked for low-latency PCM", () => {
  assert.equal(isQuiet(window(false)), true);
  assert.equal(isQuiet(window(true)), false);
  assert.equal(isQuiet(Buffer.alloc(0)), true);
  const pcm = window(true, 0.1);
  const wav = wavAround(pcm);
  const back = decodeWav(new Uint8Array(wav));
  assert.equal(back.rate, RATE);
  assert.equal(back.channels, 1);
  assert.equal(back.samples.length, pcm.length / 2);
  assert.ok(Math.abs((back.samples[5] as number) - pcm.readInt16LE(10) / 32768) < 1e-6);
  const args = decoderArgs();
  assert.ok(args.includes("pipe:0") && args.includes("s16le") && args.includes(String(RATE)));
  assert.equal(args[args.indexOf("-ac") + 1], "1");
});

test("the first listener starts a captioner, five-second windows go to the ear, silence does not, and lines are stamped with when they were heard", async () => {
  const world = fakeWorld();
  const got: CaptionLine[] = [];
  const off = world.captions.subscribe("tv", (line) => got.push(line));
  assert.ok(off);
  assert.ok(world.listeners.has("tv"));
  assert.match(world.events[0] ?? "", /started/);
  // Two and a half seconds is not a window yet; the rest of it is.
  world.feed("tv", window(true, 2.5));
  await world.settle();
  assert.equal(world.asked.length, 0);
  world.tick(2500);
  world.feed("tv", window(true, 2.5));
  await world.settle();
  assert.equal(world.asked.length, 1);
  assert.equal(world.asked[0]?.length, 44 + (WINDOW_MS / 1000) * RATE * 2);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.text, "heard 1");
  assert.equal(got[0]?.channel, "tv");
  assert.equal(got[0]?.until, 1_002_500);
  assert.equal(got[0]?.at, 1_002_500 - WINDOW_MS);
  // A silent window is never sent; the next loud one is, and the lines are kept in order.
  world.tick(5000);
  world.feed("tv", window(false));
  await world.settle();
  assert.equal(world.asked.length, 1);
  world.tick(5000);
  world.feed("tv", window(true));
  await world.settle();
  assert.equal(world.asked.length, 2);
  assert.deepEqual(world.captions.recent("tv").map((line) => line.text), ["heard 1", "heard 2"]);
  assert.deepEqual(world.captions.recent("tv", got[0]?.at ?? 0).map((line) => line.text), ["heard 2"]);
  assert.deepEqual(world.captions.status("tv"), { on: true, lines: 2, error: "" });
  assert.deepEqual(world.captions.status("radio"), { on: false, lines: 0, error: "" });
  assert.deepEqual(world.captions.recent("radio"), []);
  // A second listener joins the same captioner: no second ffmpeg.
  const more: CaptionLine[] = [];
  const offMore = world.captions.subscribe("tv", (line) => more.push(line));
  assert.equal(world.listeners.size, 1);
  world.tick(5000);
  world.feed("tv", window(true));
  await world.settle();
  assert.equal(more.length, 1);
  assert.equal(got.length, 3);
  // Nobody left: a moment later the captioner stops, the channel is let go, ffmpeg is ended.
  off();
  offMore?.();
  assert.equal(world.detached.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(world.detached, ["tv"]);
  assert.equal(world.endedDecoders(), 1);
  assert.deepEqual(world.captions.status("tv"), { on: false, lines: 0, error: "" });
  // Asking again starts a fresh one.
  const again = world.captions.subscribe("tv", () => undefined);
  assert.ok(again);
  assert.equal(world.listeners.size, 1);
  again?.();
});

test("a channel that is not there is null, a channel that ends stops its captioner, and the ear's refusals are said once a minute", async () => {
  const world = fakeWorld({
    hasChannel: (id) => id !== "gone",
    answer: () => ({ status: 429, body: { error: "300 seconds of sound a minute is plenty" } }),
  });
  assert.equal(world.captions.subscribe("gone", () => undefined), null);
  assert.equal(world.captions.status("gone").on, false);
  const off = world.captions.subscribe("tv", () => undefined);
  assert.ok(off);
  for (let i = 0; i < 3; i++) {
    world.tick(5000);
    world.feed("tv", window(true));
    await world.settle();
  }
  assert.equal(world.asked.length, 3);
  assert.equal(world.captions.recent("tv").length, 0);
  assert.equal(world.captions.status("tv").error, "300 seconds of sound a minute is plenty");
  assert.equal(world.events.filter((one) => one.includes("plenty")).length, 1);
  world.tick(60_000);
  world.feed("tv", window(true));
  await world.settle();
  assert.equal(world.events.filter((one) => one.includes("plenty")).length, 2);
  // The channel ends under it: the captioner is gone with it.
  world.listeners.get("tv")?.end();
  assert.equal(world.captions.status("tv").on, false);
  assert.deepEqual(world.detached, ["tv"]);
  off();
});

test("windows the ear has not answered yet are not stacked up: past a couple in flight the sound is dropped", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const world = fakeWorld();
  // A slow ear: every ask waits for the gate.
  const slow = new Captions({
    ffmpeg: ["ffmpeg"],
    listen: (id, listener) => {
      world.listeners.set(id, listener);
      return () => world.listeners.delete(id);
    },
    session: () => ({ site: "https://nixamp.test", token: "t" }),
    fetcher: (async () => {
      await gate;
      return new Response(JSON.stringify({ text: "late", seconds: 5 }), { status: 200 });
    }) as typeof fetch,
    decoder: (onPcm) => ({ write: (chunk) => { onPcm(chunk); return true; }, end: () => undefined }),
    now: () => 5_000_000,
  });
  const lines: CaptionLine[] = [];
  const off = slow.subscribe("tv", (line) => lines.push(line));
  assert.ok(off);
  for (let i = 0; i < IN_FLIGHT + 3; i++) world.feed("tv", window(true));
  await world.settle();
  assert.equal(lines.length, 0);
  (release as unknown as () => void)();
  await world.settle();
  assert.equal(lines.length, IN_FLIGHT);
  off?.();
  assert.ok(KEEP >= 100);
});

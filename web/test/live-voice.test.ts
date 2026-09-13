import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveVoicePlayer } from "../src/live-voice.ts";

function context() {
  const samples: number[][] = [];
  let stopped = 0;
  let clock = 0;
  return { samples, stopped: () => stopped, audio: {
    get currentTime() { clock += 1; return clock; }, state: "running", destination: {}, resume: async () => undefined,
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
    createBuffer: (_channels: number, size: number, rate: number) => {
      const data = new Float32Array(size);
      return { duration: size / rate, getChannelData: () => data, data };
    },
    createBufferSource: () => {
      const source = { buffer: null as unknown as { data: Float32Array }, connect: () => undefined, disconnect: () => undefined, stop: () => { stopped++; }, start: () => { samples.push([...source.buffer.data]); }, onended: null };
      return source;
    },
  } as unknown as AudioContext };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const line = { channel: "ufc", at: 1000, until: 6000, text: "One minute left.", language: "en" };

test("PCM starts before the response ends, handles split samples, and restores original audio on disable", async () => {
  const sound = context(), active: boolean[] = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const player = new LiveVoicePlayer({
    audioContext: () => sound.audio, now: () => 7000, volume: () => 0.5, playing: () => true,
    active: on => active.push(on), failed: () => assert.fail("unexpected failure"), status: () => undefined,
    fetcher: (async () => new Response(new ReadableStream({ start(controller) { output = controller; } }), { headers: { "content-type": "audio/pcm" } })) as typeof fetch,
  });
  await player.enable(); player.push(line, "/voice", 0); await settle();
  output.enqueue(new Uint8Array([0, 64, 0])); await settle();
  assert.deepEqual(sound.samples, [[0.5]]);
  output.enqueue(new Uint8Array([192])); output.close(); await settle();
  assert.deepEqual(sound.samples, [[0.5], [-0.5]]);
  assert.ok(active.includes(true));
  player.disable();
  assert.equal(active.at(-1), false);
  assert.equal(sound.stopped(), 2);
});

test("late responses after a channel change cannot play, and authorization failures restore sound", async () => {
  const sound = context(), active: boolean[] = [];
  let resolve!: (response: Response) => void;
  let failures = 0;
  const player = new LiveVoicePlayer({
    audioContext: () => sound.audio, now: () => 7000, volume: () => 1, playing: () => true,
    active: on => active.push(on), failed: () => failures++, status: () => undefined,
    fetcher: (() => new Promise<Response>(done => { resolve = done; })) as typeof fetch,
  });
  await player.enable(); player.push(line, "/voice", 0); await settle();
  player.reset(); resolve(new Response(new Uint8Array([0, 64]), { headers: { "content-type": "audio/pcm" } })); await settle();
  assert.equal(sound.samples.length, 0);
  player.push({ ...line, at: 2000 }, "/voice", 0); await settle();
  resolve(Response.json({ error: "Sign in again" }, { status: 401 })); await settle();
  assert.equal(failures, 1);
  assert.equal(active.at(-1), false);
});

test('a window with multiple speakers plays each turn with its own request body', async () => {
  const sound = context(), bodies: string[] = [];
  const player = new LiveVoicePlayer({
    audioContext: () => sound.audio, now: () => 7000, volume: () => 1, playing: () => true,
    active: () => {}, failed: () => assert.fail('unexpected failure'), status: () => {},
    authorization: async () => ({ authorization: 'Bearer scoped' }),
    fetcher: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer scoped');
      bodies.push(String(init?.body));
      return new Response(new Uint8Array([0, 64]), { headers: { 'content-type': 'audio/pcm' } });
    }) as typeof fetch,
  });
  await player.enable();
  player.pushBatch(['one', 'two'].map((speaker, index) => ({
    line: { ...line, speaker, at: line.at + index }, url: '/synthesize', lag: 0,
    init: { method: 'POST', body: JSON.stringify({ voice: speaker }) },
  })));
  await settle(); await settle();
  assert.deepEqual(bodies.map(body => JSON.parse(body).voice), ['one', 'two']);
  assert.equal(sound.samples.length, 2); player.disable();
});

test('translation owns the output through initial wait, silent gaps and resets until the session is disabled', async () => {
  const sound = context(), active: boolean[] = [];
  const player = new LiveVoicePlayer({
    audioContext: () => sound.audio, now: () => 7000, volume: () => 1, playing: () => true,
    active: on => active.push(on), failed: () => assert.fail('unexpected failure'), status: () => {},
    fetcher: (async () => new Response(new Uint8Array([0, 64]), { headers: { 'content-type': 'audio/pcm' } })) as typeof fetch,
  });
  await player.enable();
  assert.deepEqual(active, [true], 'mute native audio before the first translated line arrives');
  await settle();
  player.push(line, '/voice', 0); await settle();
  player.reset(); // Seeking, changing speaker or resuming capture cannot restore native voices.
  await settle();
  player.push({ ...line, at: 2000 }, '/voice', 0); await settle();
  assert.ok(active.every(Boolean), 'never switch to original sound between utterances or resets');
  assert.equal(sound.samples.length, 2);
  player.disable(); assert.equal(active.at(-1), false);
});

test('fetches the next voice while audio plays, preserves queued turns across batches, and bounds lookahead', async () => {
  let clock = 0;
  const sound = context(), requested: string[] = [], starts: { at: number; duration: number }[] = [];
  Object.defineProperty(sound.audio, 'currentTime', { get: () => clock });
  sound.audio.createBufferSource = (() => {
    const node = { buffer: null as AudioBuffer | null, connect() {}, disconnect() {}, stop() {}, onended: null,
      start(at: number) { starts.push({ at, duration: node.buffer!.duration }); } };
    return node;
  }) as unknown as typeof sound.audio.createBufferSource;
  let release!: () => void;
  const player = new LiveVoicePlayer({
    audioContext: () => sound.audio, now: () => 7000, volume: () => 1, playing: () => true,
    active: () => {}, failed: () => assert.fail('unexpected failure'), status: () => {},
    fetcher: (async url => {
      requested.push(String(url));
      if (requested.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return new Response(new Uint8Array(32000), { headers: { 'content-type': 'audio/pcm' } });
    }) as typeof fetch,
  });
  await player.enable();
  const item = (id: number) => ({ line: { ...line, at: line.at + id, speaker: String(id) }, url: '/voice/' + id, lag: 0 });
  player.pushBatch([item(1), item(2)]); await settle();
  player.pushBatch([item(3), item(4)]); release(); await settle();
  assert.deepEqual(requested, ['/voice/1', '/voice/2', '/voice/3'], 'next turns fetched without waiting for first audio to end');
  assert.ok(starts.length > 3, 'a large response is scheduled in bounded chunks');
  for (let i = 1; i < starts.length; i++) assert.ok(Math.abs(starts[i]!.at - starts[i-1]!.at - starts[i-1]!.duration) < 1e-9, 'continuous scheduled voice timeline');
  clock = 1; await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(requested, ['/voice/1', '/voice/2', '/voice/3', '/voice/4']);
  player.disable();
});

test('a transient voice failure preserves output ownership and plays the next phrase', async () => {
  const sound = context(), active: boolean[] = [];
  let requests = 0;
  const player = new LiveVoicePlayer({ audioContext: () => sound.audio, now: () => 7000, volume: () => 1, playing: () => true,
    active: on => active.push(on), failed: () => assert.fail('unexpected failure'), status() {},
    fetcher: (async () => ++requests === 1 ? Response.json({ error: 'Temporary outage' }, { status: 502 })
      : new Response(new Uint8Array([0, 64]), { headers: { 'content-type': 'audio/pcm' } })) as typeof fetch });
  try {
    await player.enable(); player.pushBatch([1, 2].map(id => ({ line: { ...line, at: id }, url: '/voice', lag: 0 })));
    await settle(); assert.equal(requests, 2); assert.equal(sound.samples.length, 1);
    assert.ok(active.every(Boolean), 'transient recovery must never restore native announcers');
  } finally { player.disable(); }
});

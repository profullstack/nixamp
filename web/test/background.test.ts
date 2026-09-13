import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BackgroundSeparator, BACKGROUND_HOP, type FrameDenoiser } from "../src/background-core.ts";
import { BackgroundAudio } from "../src/background.ts";
import { createBackgroundSeparator } from "../src/background-model.ts";

const frame = (value: number) => new Float32Array(BACKGROUND_HOP).fill(value);
function speechEstimate(): FrameDenoiser {
  let previous = frame(0);
  return { processFrame(input) { const result = previous; previous = input.map(value => value * 0.75); return result; }, destroy() {} };
}

test("the bundled Base model processes the complete downmix without non-finite output", async () => {
  const separator = await createBackgroundSeparator();
  try {
    for (let step = 0; step < 12; step++) {
      const output = separator.process([frame(0.1), frame(-0.1), frame(0.2), frame(0), frame(0.3), frame(-0.2)]);
      assert.equal(output.length, 2);
      assert.ok(output.every(channel => channel.every(Number.isFinite)));
    }
  } finally { separator.destroy(); }
});

test("spectral removal rejects a phase-shifted, underestimated voice while retaining other frequencies", () => {
  let step = -BACKGROUND_HOP;
  const voice = (i: number, phase = 0) => 0.2 * Math.sin(2 * Math.PI * 375 * i / 48000 + phase);
  const crowd = (i: number) => 0.1 * Math.sin(2 * Math.PI * 6000 * i / 48000);
  const model = { processFrame() { const result = Float32Array.from({ length: BACKGROUND_HOP }, (_, i) => step < 0 ? 0 : voice(step + i, 0.7) * 0.5); step += BACKGROUND_HOP; return result; }, destroy() {} };
  const separator = new BackgroundSeparator([model]);
  let speech = 0, ambience = 0, length = 0;
  for (let hop = 0; hop < 40; hop++) {
    const output = separator.process([Float32Array.from({ length: BACKGROUND_HOP }, (_, i) => voice(hop * BACKGROUND_HOP + i) + crowd(hop * BACKGROUND_HOP + i))]);
    assert.deepEqual(output[0], output[1], "mono remains centred");
    if (hop < 4) continue;
    for (let i = 0; i < BACKGROUND_HOP; i++) {
      const at = (hop - 2) * BACKGROUND_HOP + i;
      speech += output[0]![i]! * voice(at); ambience += output[0]![i]! * crowd(at); length++;
    }
  }
  assert.ok(Math.abs(speech / length / 0.02) < 0.02, "voice survives imperfect phase subtraction");
  assert.ok(ambience / length / 0.005 > 0.9, "background frequencies must remain at a steady level");
});

test("rear and side speech cannot bypass removal in quad, 5.1 or 7.1 recordings", () => {
  for (const count of [2, 4, 6, 8]) {
    const models = Array.from({ length: 2 }, () => {
      let previous = frame(0);
      return { processFrame(input: Float32Array) { const output = previous; previous = input.slice(); return output; }, destroy() {} };
    });
    const separator = new BackgroundSeparator(models);
    for (let hop = 0; hop < 8; hop++) {
      const input = Array.from({ length: count }, (_, channel) => frame(channel >= count - 2 ? 0.3 : 0));
      const output = separator.process(input);
      assert.ok(output.every(channel => channel.every(value => Math.abs(value) < 1e-6)), `${count}-channel commentary bypassed the separator`);
    }
  }
});

test("invalid inference fails closed, and a cut clears overlap without replaying old sound", () => {
  const separator = new BackgroundSeparator([speechEstimate(), speechEstimate()]);
  assert.throws(() => separator.process([frame(1), frame(1), frame(1)]));
  assert.throws(() => separator.process([frame(NaN), frame(1)]));
  let destroyed = 0;
  const broken = { processFrame: () => frame(Infinity), destroy: () => { destroyed++; } };
  const failed = new BackgroundSeparator([broken, broken]);
  assert.throws(() => failed.process([frame(1), frame(1)]));
  failed.destroy(); assert.equal(destroyed, 2);
  const clean = new BackgroundSeparator([{ processFrame: () => frame(0), destroy() {} }]);
  for (let i = 0; i < 5; i++) clean.process([frame(0.3)]);
  clean.discontinuity();
  for (let i = 0; i < 3; i++) assert.ok(clean.process([frame(0)]).every(channel => channel.every(value => value === 0)));
});

test("a stalled worker stays bounded, discards stale results, and resumes background without raw commentary", () => {
  const messages: { error?: boolean }[] = [];
  let Processor: any;
  runInNewContext(readFileSync(new URL("../src/background.worklet.js", import.meta.url), "utf8"), {
    Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (message: { error?: boolean }) => messages.push(message) }; },
    registerProcessor: (_name: string, constructor: unknown) => { Processor = constructor; },
  });
  const processor = new Processor();
  const requests: { id: number }[] = [];
  const port = { postMessage: (message: { id: number }) => { requests.push(message); }, start() {}, close() {}, onmessage: (_event: any) => {} };
  processor.port.onmessage({ data: { port } });
  const tick = () => {
    const output = [new Float32Array(128), new Float32Array(128)];
    const running = processor.process([[new Float32Array(128).fill(0.75)]], [output]);
    return { running, output };
  };
  for (let i = 0; i < 200; i++) {
    const { running, output } = tick();
    assert.equal(running, true);
    assert.ok(output.every(channel => channel.every(value => value === 0)), "stalled inference must never bypass to original commentary");
  }
  assert.equal(requests.length, 32, "pending work must remain bounded during a long stall");
  for (const request of requests.splice(0)) port.onmessage({ data: { id: request.id - 1, channels: [frame(0.25), frame(-0.125)] } });
  assert.equal(processor.queue.length, 0, "old background must not be replayed late");
  for (let frameIndex = 0; frameIndex < 5; frameIndex++) {
    for (let quantum = 0; quantum < 4; quantum++) tick();
    const request = requests.shift()!;
    port.onmessage({ data: { id: request.id - 1, channels: [frame(0.25), frame(-0.125)] } });
  }
  const resumed = tick();
  assert.equal(resumed.running, true);
  assert.ok(resumed.output[0]!.every(value => value === 0.25));
  assert.ok(resumed.output[1]!.every(value => value === -0.125));
  assert.equal(messages.length, 0, "ordinary scheduling delays must not permanently disable background");
  processor.port.onmessage({ data: { stop: true } });
  assert.equal(tick().running, false);
});

test("cancelled model loading settles immediately; stale workers cannot reconnect and failure disconnects only background", async () => {
  const originalWorker = globalThis.Worker, originalNode = globalThis.AudioWorkletNode;
  const workers: FakeWorker[] = [];
  let disconnects = 0, closed = 0, failures = 0;
  const gains: { value: number }[] = [];
  class FakeWorker {
    onmessage: ((event: { data: object }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage({ port }: { port: MessagePort }) { port.close(); }
    terminate() { this.terminated = true; }
    ready() { this.onmessage?.({ data: { ready: true } }); }
  }
  class FakeNode {
    port = { postMessage: ({ port }: { port?: MessagePort }) => port?.close(), close: () => { closed++; } };
    connect() {} disconnect() { disconnects++; }
  }
  Object.assign(globalThis, { Worker: FakeWorker, AudioWorkletNode: FakeNode });
  const context = { sampleRate: 48000, audioWorklet: { addModule: async () => {} }, destination: {}, createGain: () => {
    const gain = { value: 0 }; gains.push(gain); return { gain, connect() {}, disconnect() {} };
  } } as unknown as AudioContext;
  let connections = 0, inputDisconnects = 0;
  const input = { connect: () => { connections++; }, disconnect: () => { inputDisconnects++; } } as unknown as AudioNode;
  const background = new BackgroundAudio(() => { failures++; });
  try {
    const pending = background.start(context, input); await Promise.resolve();
    assert.equal(workers.length, 1);
    background.stop(); assert.equal(await pending, false);
    assert.equal(workers[0]!.terminated, true);
    assert.equal(failures, 0, "cancellation is not an error");

    const restarted = background.start(context, input); await Promise.resolve();
    workers[0]!.ready(); workers[1]!.ready();
    assert.equal(await restarted, true); assert.equal(connections, 1);
    assert.equal(gains[0]!.value, 0, "background must wait until translated playback starts");
    background.active(true); assert.equal(gains[0]!.value, 3);
    background.setLevel(1.5); assert.equal(gains[0]!.value, 4.5);
    background.active(false); background.setLevel(2); assert.equal(gains[0]!.value, 0);
    background.active(true); assert.equal(gains[0]!.value, 6);
    background.setLevel(NaN); assert.equal(gains[0]!.value, 6);
    workers[1]!.onerror?.();
    assert.equal(failures, 1); assert.equal(inputDisconnects, 1);
    assert.equal(disconnects, 1); assert.equal(closed, 1);
    assert.equal(workers[1]!.terminated, true);
    background.stop(); assert.equal(disconnects, 1);
  } finally {
    background.stop(); Object.assign(globalThis, { Worker: originalWorker, AudioWorkletNode: originalNode });
  }
});

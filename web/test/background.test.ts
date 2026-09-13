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

test("the real bundled model initializes all three dialogue channels and leaves surround ambience untouched", async () => {
  const separator = await createBackgroundSeparator();
  try {
    const surround = [frame(0), frame(0), frame(0), frame(0), frame(0.3), frame(-0.2)];
    separator.process(surround);
    const output = separator.process(surround);
    assert.ok(output[0]!.every(value => Math.abs(value - Math.SQRT1_2 * 0.3) < 1e-6));
    assert.ok(output[1]!.every(value => Math.abs(value + Math.SQRT1_2 * 0.2) < 1e-6));
  } finally { separator.destroy(); }
});

test("subtracts speech from the aligned preceding frame independently in stereo", () => {
  const separator = new BackgroundSeparator([speechEstimate(), speechEstimate()]);
  const first = separator.process([frame(0.8), frame(-0.4)]);
  assert.ok(first.every(channel => channel.every(value => value === 0)), "startup must not pass through commentary");
  const next = separator.process([frame(-0.1), frame(0.9)]);
  assert.ok(next[0]!.every(value => Math.abs(value - 0.2) < 1e-6));
  assert.ok(next[1]!.every(value => Math.abs(value + 0.1) < 1e-6));
  const third = separator.process([frame(0), frame(0)]);
  assert.ok(third[0]!.every(value => Math.abs(value + 0.025) < 1e-6));
  assert.ok(third[1]!.every(value => Math.abs(value - 0.225) < 1e-6));
});

test("invalid input or failed inference never falls back to original commentary", () => {
  const separator = new BackgroundSeparator([speechEstimate(), speechEstimate()]);
  assert.throws(() => separator.process([frame(1), frame(1), frame(1)]));
  assert.throws(() => separator.process([frame(NaN), frame(1)]));
  let destroyed = 0;
  const broken = { processFrame: () => frame(Infinity), destroy: () => { destroyed++; } };
  const failed = new BackgroundSeparator([broken, broken]);
  assert.throws(() => failed.process([frame(1), frame(1)]));
  failed.destroy(); assert.equal(destroyed, 2);
});

test("mono stays centred; quad, 5.1 and 7.1 retain their original ambience channels", () => {
  const mono = new BackgroundSeparator([speechEstimate()]);
  mono.process([frame(0.8)]);
  const centred = mono.process([frame(0)]);
  assert.deepEqual(centred[0], centred[1]);
  assert.ok(centred[0]!.every(value => Math.abs(value - 0.2) < 1e-6));
  for (const count of [4, 6, 8]) {
    let heard = 0;
    const dialogue = Array.from({ length: 3 }, () => {
      let previous = frame(0);
      return { processFrame(input: Float32Array) { heard++; const result = previous; previous = input.slice(); return result; }, destroy() {} };
    });
    const separator = new BackgroundSeparator(dialogue);
    // Complete foreground suppression leaves the surround recordings untouched.
    const input = count === 4 ? [0.1, 0.2, 0.3, -0.2]
      : count === 6 ? [0.1, 0.2, 0.4, 0.9, 0.3, -0.2]
      : [0.1, 0.2, 0.4, 0.9, 0.3, -0.2, 0.1, 0.4];
    separator.process(input.map(frame));
    const output = separator.process(input.map(() => frame(0)));
    const left = count === 4 ? 0.15 : count === 6 ? Math.SQRT1_2 * 0.3 : 0.5 * (0.3 + 0.1);
    const right = count === 4 ? -0.1 : count === 6 ? Math.SQRT1_2 * -0.2 : 0.5 * (-0.2 + 0.4);
    assert.ok(output[0]!.every(value => Math.abs(value - left) < 1e-6), `${count} channels: left ambience lost`);
    assert.ok(output[1]!.every(value => Math.abs(value - right) < 1e-6), `${count} channels: right ambience lost`);
    assert.equal(heard, count === 4 ? 4 : 6, "surround sound must never enter the speech model");
  }
});

test("a cut in captured audio does not replay the preceding input as background", () => {
  const separator = new BackgroundSeparator([speechEstimate(), speechEstimate()]);
  separator.process([frame(0.8), frame(-0.4)]);
  separator.discontinuity();
  const cut = separator.process([frame(-0.1), frame(0.9)]);
  assert.ok(cut.every(channel => channel.every(value => value === 0)));
  const next = separator.process([frame(0), frame(0)]);
  assert.ok(next[0]!.every(value => Math.abs(value + 0.025) < 1e-6));
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
    background.active(true); assert.equal(gains[0]!.value, 1);
    background.setLevel(1.5); assert.equal(gains[0]!.value, 1.5);
    background.active(false); background.setLevel(2); assert.equal(gains[0]!.value, 0);
    background.active(true); assert.equal(gains[0]!.value, 2);
    background.setLevel(NaN); assert.equal(gains[0]!.value, 2);
    workers[1]!.onerror?.();
    assert.equal(failures, 1); assert.equal(inputDisconnects, 1);
    assert.equal(disconnects, 1); assert.equal(closed, 1);
    assert.equal(workers[1]!.terminated, true);
    background.stop(); assert.equal(disconnects, 1);
  } finally {
    background.stop(); Object.assign(globalThis, { Worker: originalWorker, AudioWorkletNode: originalNode });
  }
});

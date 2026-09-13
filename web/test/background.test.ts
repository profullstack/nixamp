import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { BackgroundSeparator, BACKGROUND_HOP, type FrameDenoiser } from "../src/background-core.ts";
import { BackgroundAudio } from "../src/background.ts";

const frame = (value: number) => new Float32Array(BACKGROUND_HOP).fill(value);
function speechEstimate(): FrameDenoiser {
  let previous = frame(0);
  return { processFrame(input) { const result = previous; previous = input.map(value => value * 0.75); return result; }, destroy() {} };
}

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
  assert.throws(() => separator.process([frame(1)]));
  assert.throws(() => separator.process([frame(NaN), frame(1)]));
  let destroyed = 0;
  const broken = { processFrame: () => frame(Infinity), destroy: () => { destroyed++; } };
  const failed = new BackgroundSeparator([broken, broken]);
  assert.throws(() => failed.process([frame(1), frame(1)]));
  failed.destroy(); assert.equal(destroyed, 2);
});

test("a worker that falls behind is bounded and silenced without passing through the original", () => {
  const messages: { error?: boolean }[] = [];
  let Processor: any;
  runInNewContext(readFileSync(new URL("../src/background.worklet.js", import.meta.url), "utf8"), {
    Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (message: { error?: boolean }) => messages.push(message) }; },
    registerProcessor: (_name: string, constructor: unknown) => { Processor = constructor; },
  });
  const processor = new Processor();
  let sent = 0;
  processor.port.onmessage({ data: { port: { postMessage: () => { sent++; }, start() {} } } });
  for (let i = 0; i < 20; i++) {
    const output = [new Float32Array(128), new Float32Array(128)];
    const running = processor.process([[new Float32Array(128).fill(0.75)]], [output]);
    assert.equal(running, i < 19);
    assert.ok(output.every(channel => channel.every(value => value === 0)), "stalled inference must never bypass to original commentary");
  }
  assert.equal(sent, 4); assert.equal(messages.length, 1); assert.equal(messages[0]!.error, true);
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
    workers[1]!.onerror?.();
    assert.equal(failures, 1); assert.equal(inputDisconnects, 1);
    assert.equal(disconnects, 1); assert.equal(closed, 1);
    assert.equal(workers[1]!.terminated, true);
    background.stop(); assert.equal(disconnects, 1);
  } finally {
    background.stop(); Object.assign(globalThis, { Worker: originalWorker, AudioWorkletNode: originalNode });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "../src/compression/codec.ts";
import { encodeDataFrame, encodeEndFrame, encodeStreamHeader, RelayError, sha256 } from "../src/compression/envelope.ts";
import { ChannelMetrics } from "../src/compression/metrics.ts";
import { DEFAULT_LOSSLESS, type LosslessPolicy } from "../src/compression/policy.ts";
import { GIVE_UP_AFTER, RelayDecoder, RelayEncoder, type RelayListener } from "../src/compression/relay.ts";

const MODES = new Set(["stored", "zstd", "ts-zstd"] as const);

/** A listener that keeps what it was sent, and can pretend to be behind. */
class Sink implements RelayListener {
  chunks: Buffer[] = [];
  ended = false;
  behind = 0;
  write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(): void {
    this.ended = true;
  }
  pending(): number {
    return this.behind;
  }
  get all(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function policy(over: Partial<LosslessPolicy> = {}): LosslessPolicy {
  return { ...DEFAULT_LOSSLESS, mode: "zstd", maxBlockBytes: 4096, maxHoldMs: 5, ...over };
}

/** Run the whole envelope through a decoder and hand back the original bytes. */
async function decodeAll(bytes: Buffer, chunk = 1000): Promise<{ out: Buffer; decoder: RelayDecoder }> {
  const pieces: Buffer[] = [];
  const decoder = new RelayDecoder({ modes: MODES, onBytes: (b) => { pieces.push(b); } });
  for (let at = 0; at < bytes.length; at += chunk) await decoder.feed(bytes.subarray(at, at + chunk));
  await decoder.end();
  return { out: Buffer.concat(pieces), decoder };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 25));

test("what goes into the encoder comes out of the decoder, byte for byte, with a clean end", async () => {
  const metrics = new ChannelMetrics();
  const encoder = new RelayEncoder({ generation: 3, policy: policy(), pool: new Pool(), metrics, boundary: "channel", onAbort: () => undefined, onIdle: () => undefined });
  const sink = new Sink();
  encoder.join(sink, [Buffer.from("opening bytes ".repeat(40))]);
  encoder.attach();
  const live = Buffer.concat([Buffer.from("tick tock ".repeat(2000)), randomBytes(9000)]);
  for (let at = 0; at < live.length; at += 1500) encoder.write(live.subarray(at, at + 1500));
  await tick();
  encoder.end();
  await tick();
  assert.ok(sink.ended);
  const { out, decoder } = await decodeAll(sink.all);
  assert.ok(out.equals(Buffer.concat([Buffer.from("opening bytes ".repeat(40)), live])));
  assert.ok(decoder.ended);
  assert.equal(decoder.header?.generation, 3);
  assert.ok(metrics.compressedBlocks > 0, "the text compressed");
  assert.ok(metrics.storedBlocks > 0, "the noise was stored");
  assert.equal(metrics.inputBytes, live.length);
  assert.ok(metrics.wireBytes < metrics.inputBytes + 560, `wire ${metrics.wireBytes} against input ${metrics.inputBytes}`);
  assert.ok(metrics.snapshot().latencyMs.p95 < 500);
});

test("one encoder serves every session: a late joiner gets its preface and then the shared blocks, nothing twice", async () => {
  const metrics = new ChannelMetrics();
  const encoder = new RelayEncoder({ generation: 1, policy: policy(), pool: new Pool(), metrics, boundary: "channel", onAbort: () => undefined, onIdle: () => undefined });
  const first = new Sink();
  encoder.join(first, []);
  encoder.attach();
  const part1 = Buffer.from("first part ".repeat(1000));
  encoder.write(part1);
  await tick();
  // The channel has remembered part1 as its backlog; a newcomer is handed it.
  const second = new Sink();
  encoder.join(second, [part1]);
  const part2 = Buffer.from("second part ".repeat(1000));
  encoder.write(part2);
  await tick();
  encoder.end();
  await tick();
  assert.equal(encoder.sessionCount, 0);
  const a = await decodeAll(first.all);
  const b = await decodeAll(second.all);
  assert.ok(a.out.equals(Buffer.concat([part1, part2])));
  assert.ok(b.out.equals(Buffer.concat([part1, part2])), "the late joiner saw part1 exactly once, then part2");
  assert.equal(metrics.blocks, Math.ceil(part1.length / 4096) + Math.ceil(part2.length / 4096), "shared blocks were encoded once, not per session");
});

test("auto gives up on noise after a run of stored blocks and comes back after the cooldown", async () => {
  const metrics = new ChannelMetrics();
  let now = 0;
  const pool = new Pool();
  const encoder = new RelayEncoder({
    generation: 1, policy: policy({ mode: "auto", resampleAfterMs: 1000 }), pool, metrics, boundary: "channel",
    onAbort: () => undefined, onIdle: () => undefined, now: () => now,
  });
  const sink = new Sink();
  encoder.join(sink, []);
  encoder.attach();
  for (let i = 0; i < GIVE_UP_AFTER + 4; i += 1) encoder.write(randomBytes(4096));
  await tick();
  assert.equal(metrics.bypassed, true);
  assert.equal(metrics.fallbackReason, "already efficiently compressed");
  assert.equal(metrics.storedBlocks, GIVE_UP_AFTER + 4);
  assert.equal(pool.stats.completed, GIVE_UP_AFTER, "the blocks after giving up never went to the pool");
  const text = Buffer.from("compressible ".repeat(300)); // one block
  encoder.write(text);
  await tick();
  assert.equal(metrics.compressedBlocks, 0, "still bypassed: not even tried");
  assert.equal(pool.stats.completed, GIVE_UP_AFTER);
  now = 2000;
  encoder.write(text);
  await tick();
  assert.equal(metrics.bypassed, false, "sampled again after the cooldown");
  assert.equal(metrics.compressedBlocks, 1);
  assert.equal(pool.stats.completed, GIVE_UP_AFTER + 1);
  encoder.end();
  await tick();
  const { out } = await decodeAll(sink.all);
  assert.equal(out.length, (GIVE_UP_AFTER + 4) * 4096 + text.length * 2, "stored is still every byte");
});

test("a listener that stops draining is cut off; the others carry on", async () => {
  const metrics = new ChannelMetrics();
  const encoder = new RelayEncoder({ generation: 1, policy: policy({ maxListenerQueueBytes: 16 * 1024 }), pool: new Pool(), metrics, boundary: "channel", onAbort: () => undefined, onIdle: () => undefined });
  const healthy = new Sink();
  const stuck = new Sink();
  encoder.join(healthy, []);
  encoder.join(stuck, []);
  encoder.attach();
  stuck.behind = 20 * 1024;
  encoder.write(Buffer.from("x".repeat(5000)));
  await tick();
  assert.ok(stuck.ended, "cut off");
  assert.equal(healthy.ended, false);
  assert.equal(metrics.droppedListeners, 1);
  assert.equal(metrics.fallbackReason, "slow listener");
  encoder.write(Buffer.from("y".repeat(5000)));
  await tick();
  encoder.end();
  await tick();
  const { out } = await decodeAll(healthy.all);
  assert.equal(out.length, 10000);
  await assert.rejects(decodeAll(stuck.all), (e: RelayError) => e.code === "TRUNCATED", "the cut-off one has no end marker");
});

test("a compressor that falls too far behind ends its relays rather than growing", async () => {
  const metrics = new ChannelMetrics();
  let aborted: string | null = null;
  // A pool that never finishes: every block queues behind it.
  const stuckPool = new Pool({ concurrency: 1, maxQueued: 1000, timeoutMs: 60_000 });
  void stuckPool.run(() => new Promise(() => undefined), { timeoutMs: 60_000 }).catch(() => undefined);
  const encoder = new RelayEncoder({
    generation: 1, policy: policy({ maxChannelQueueBytes: 64 * 1024 }), pool: stuckPool, metrics, boundary: "channel",
    onAbort: (reason) => { aborted = reason; }, onIdle: () => undefined,
  });
  const sink = new Sink();
  encoder.join(sink, []);
  encoder.attach();
  for (let i = 0; i < 20; i += 1) encoder.write(Buffer.alloc(4096, 1));
  await tick();
  assert.equal(aborted, "processing budget exceeded");
  assert.ok(sink.ended);
  assert.equal(metrics.fallbackReason, "processing budget exceeded");
});

test("off means stored frames: the envelope still works, nothing is compressed", async () => {
  const metrics = new ChannelMetrics();
  const encoder = new RelayEncoder({ generation: 1, policy: policy({ mode: "off" }), pool: new Pool(), metrics, boundary: "channel", onAbort: () => undefined, onIdle: () => undefined });
  const sink = new Sink();
  encoder.join(sink, []);
  encoder.attach();
  encoder.write(Buffer.from("a".repeat(10000)));
  await tick();
  encoder.end();
  await tick();
  assert.equal(metrics.compressedBlocks, 0);
  const { out } = await decodeAll(sink.all);
  assert.equal(out.length, 10000);
});

test("the decoder refuses corruption of every kind, and says which", async () => {
  const original = Buffer.from("payload ".repeat(500));
  const header = encodeStreamHeader({ version: 1, boundary: "channel", generation: 1, maxFrameBytes: 8192 });
  const frame = encodeDataFrame(0, "stored", original, original);
  const end = encodeEndFrame(1, original.length, sha256(original));
  const good = Buffer.concat([header, frame, end]);
  const { out } = await decodeAll(good, 7);
  assert.ok(out.equals(original), "fed seven bytes at a time it still works");

  const expect = async (bytes: Buffer, code: string, cap?: number): Promise<void> => {
    const decoder = new RelayDecoder({ modes: MODES, onBytes: () => undefined, ...(cap ? { maxFrameBytes: cap } : {}) });
    await assert.rejects(decoder.feed(bytes).then(() => decoder.end()), (e: RelayError) => e.code === code, code);
  };
  await expect(good.subarray(0, good.length - 10), "TRUNCATED");
  await expect(Buffer.concat([good, Buffer.from("more")]), "AFTER_END");
  await expect(good, "BAD_LIMIT", 1024);
  const flipped = Buffer.from(good);
  flipped[16 + 48 + 10] ^= 0xff;
  await expect(flipped, "CHECKSUM_MISMATCH");
  const wrongTotal = Buffer.concat([header, frame, encodeEndFrame(1, original.length - 1, sha256(original))]);
  await expect(wrongTotal, "LENGTH_MISMATCH");
  const wrongDigest = Buffer.concat([header, frame, encodeEndFrame(1, original.length, sha256(Buffer.from("other")))]);
  await expect(wrongDigest, "CHECKSUM_MISMATCH");
  const outOfOrder = Buffer.concat([header, encodeDataFrame(5, "stored", original, original)]);
  await expect(outOfOrder, "BAD_SEQUENCE");
  const lying = Buffer.concat([header, encodeDataFrame(0, "zstd", Buffer.alloc(100), Buffer.from("not zstd"))]);
  await expect(lying, "DECODE_FAILED");
  // A frame whose zstd payload is real but decodes to something other than it promised.
  const { encode } = await import("../src/compression/codec.ts");
  const zbig = await encode("zstd", Buffer.alloc(5000, 7), 1);
  const short = Buffer.concat([header, encodeDataFrame(0, "zstd", Buffer.alloc(100), zbig)]);
  await expect(short, "FRAME_TOO_LARGE");
});

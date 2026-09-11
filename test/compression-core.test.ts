import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CEILING_FRAME_BYTES,
  decodeFrameHeader,
  decodeStreamHeader,
  encodeDataFrame,
  encodeEndFrame,
  encodeStreamHeader,
  endFrameTotal,
  FRAME_END,
  FRAME_HEADER_BYTES,
  parseModes,
  RelayError,
  sha256,
  STREAM_HEADER_BYTES,
} from "../src/compression/envelope.ts";
import { decode, encode, Pool, PoolError } from "../src/compression/codec.ts";
import { Blocker } from "../src/compression/blocks.ts";
import { TS_PACKET, tsJoin, tsLayout, tsSplit } from "../src/compression/ts-transform.ts";
import { eligible, normalizePolicy, defaultPolicy } from "../src/compression/policy.ts";

const ALL = new Set(["stored", "zstd", "gzip", "ts-zstd"] as const);

test("the stream header is sixteen bytes, big-endian, and reads back", () => {
  const bytes = encodeStreamHeader({ version: 1, boundary: "channel", generation: 7, maxFrameBytes: 262144 });
  assert.equal(bytes.length, STREAM_HEADER_BYTES);
  assert.equal(bytes.toString("hex"), "4e58533101000100000000070004" + "0000");
  assert.deepEqual(decodeStreamHeader(bytes), { version: 1, boundary: "channel", generation: 7, maxFrameBytes: 262144 });
});

test("a stream header from somebody else is refused for the right reason", () => {
  const good = encodeStreamHeader({ version: 1, boundary: "source", generation: 1, maxFrameBytes: 1024 });
  const bad = (edit: (b: Buffer) => void): RelayError => {
    const copy = Buffer.from(good);
    edit(copy);
    try {
      decodeStreamHeader(copy);
    } catch (error) {
      return error as RelayError;
    }
    throw new Error("accepted");
  };
  assert.equal(bad((b) => b.write("NXS2", 0, "latin1")).code, "BAD_MAGIC");
  assert.equal(bad((b) => b.writeUInt8(2, 4)).code, "BAD_VERSION");
  assert.equal(bad((b) => b.writeUInt8(9, 6)).code, "BAD_BOUNDARY");
  assert.equal(bad((b) => b.writeUInt32BE(0, 12)).code, "BAD_LIMIT");
  assert.equal(bad((b) => b.writeUInt32BE(CEILING_FRAME_BYTES + 1, 12)).code, "BAD_LIMIT");
  assert.throws(() => decodeStreamHeader(good.subarray(0, 10)), (e: RelayError) => e.code === "TRUNCATED");
});

test("a data frame carries its lengths and the digest of the original; the vector in the docs is this one", () => {
  const original = Buffer.from("hello");
  const frame = encodeDataFrame(3, "stored", original, original);
  assert.equal(frame.length, FRAME_HEADER_BYTES + 5);
  assert.equal(
    frame.toString("hex"),
    "0100" + "0000" + "00000003" + "00000005" + "00000005" + sha256(original).toString("hex") + "68656c6c6f",
  );
  const header = decodeFrameHeader(frame, { maxFrameBytes: 1024, modes: ALL, expectSeq: 3 });
  assert.equal(header.mode, "stored");
  assert.equal(header.originalLength, 5);
  assert.ok(header.sha256.equals(sha256(original)));
});

test("the end frame vector in the docs: one frame of `hello`, then the end", () => {
  const original = Buffer.from("hello");
  const frame = encodeEndFrame(1, 5, sha256(original));
  assert.equal(frame.toString("hex"), "0200" + "0000" + "00000001" + "00000000" + "00000005" + sha256(original).toString("hex"));
});

test("the end frame carries a 64-bit total and the stream digest", () => {
  const digest = sha256(Buffer.from("everything"));
  const total = 2 ** 32 + 12345;
  const frame = encodeEndFrame(9, total, digest);
  const header = decodeFrameHeader(frame, { maxFrameBytes: 1, modes: new Set(), expectSeq: 9 });
  assert.equal(header.type, FRAME_END);
  assert.equal(endFrameTotal(header), total);
  assert.ok(header.sha256.equals(digest));
});

test("a frame header is checked before anything is allocated for it", () => {
  const original = Buffer.alloc(100, 1);
  const frame = encodeDataFrame(0, "zstd", original, Buffer.alloc(40));
  const limits = { maxFrameBytes: 100, modes: ALL, expectSeq: 0 };
  const refuse = (edit: (b: Buffer) => void, with_ = limits): string => {
    const copy = Buffer.from(frame);
    edit(copy);
    try {
      decodeFrameHeader(copy, with_);
    } catch (error) {
      return (error as RelayError).code;
    }
    return "accepted";
  };
  assert.equal(refuse(() => undefined), "accepted");
  assert.equal(refuse((b) => b.writeUInt8(7, 0)), "BAD_FRAME_TYPE");
  assert.equal(refuse((b) => b.writeUInt8(200, 1)), "BAD_MODE");
  assert.equal(refuse((b) => b.writeUInt8(2, 1), { ...limits, modes: new Set(["stored"] as const) }), "UNSUPPORTED_MODE");
  assert.equal(refuse((b) => b.writeUInt32BE(1, 4)), "BAD_SEQUENCE");
  assert.equal(refuse((b) => b.writeUInt32BE(101, 8)), "FRAME_TOO_LARGE");
  assert.equal(refuse((b) => b.writeUInt32BE(100 + 1024 + 1, 12)), "EXPANSION_BUDGET");
  assert.equal(refuse((b) => b.writeUInt8(0, 1)), "LENGTH_MISMATCH", "stored must carry exactly its bytes");
  assert.equal(refuse((b) => b.writeUInt32BE(0xffff_ffff, 8)), "FRAME_TOO_LARGE", "a gigabyte is refused on paper");
});

test("codec names in a negotiation header are kept to the known ones", () => {
  assert.deepEqual([...parseModes("zstd, Stored ,brotli,ts-zstd")], ["zstd", "stored", "ts-zstd"]);
  assert.deepEqual([...parseModes(undefined)], []);
});

test("every codec round-trips, and a decode is capped at what its frame promised", async () => {
  const text = Buffer.from("la ".repeat(50_000));
  for (const mode of ["stored", "zstd", "gzip"] as const) {
    const encoded = await encode(mode, text, 3);
    const back = await decode(mode, encoded, text.length);
    assert.ok(back.equals(text), mode);
    if (mode !== "stored") {
      assert.ok(encoded.length < text.length / 10, `${mode} squeezed repeated text`);
      await assert.rejects(decode(mode, encoded, 1000), (e: RelayError) => e.code === "FRAME_TOO_LARGE");
    }
  }
  await assert.rejects(decode("zstd", Buffer.from("not zstd at all"), 100), (e: RelayError) => e.code === "DECODE_FAILED");
});

test("random bytes do not compress, and the eligibility rule says so", async () => {
  const noise = randomBytes(64 * 1024);
  const encoded = await encode("zstd", noise, 1);
  assert.equal(eligible(noise.length, encoded.length, { minSavingsPercent: 3, minSavingsBytes: 512 }), false);
  assert.equal(eligible(100_000, 96_000, { minSavingsPercent: 3, minSavingsBytes: 512 }), true);
  assert.equal(eligible(1000, 900, { minSavingsPercent: 3, minSavingsBytes: 512 }), false, "10% but under 512 bytes");
  assert.equal(eligible(100_000, 99_000, { minSavingsPercent: 3, minSavingsBytes: 512 }), false, "1000 bytes but under 3%");
  assert.equal(eligible(0, 0, { minSavingsPercent: 0, minSavingsBytes: 0 }), false);
});

test("the pool bounds how many run, refuses when full, and times out a slow job", async () => {
  const pool = new Pool({ concurrency: 2, maxQueued: 1, timeoutMs: 50 });
  let running = 0;
  let peak = 0;
  const slow = (ms: number) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, ms));
    running -= 1;
    return ms;
  };
  const a = pool.run(slow(20));
  const b = pool.run(slow(20));
  const c = pool.run(slow(20)); // queued
  await assert.rejects(pool.run(slow(1)), (e: PoolError) => e.code === "BUSY");
  assert.deepEqual(await Promise.all([a, b, c]), [20, 20, 20]);
  assert.equal(peak, 2);
  await assert.rejects(pool.run(slow(200)), (e: PoolError) => e.code === "TIMEOUT");
  await new Promise((done) => setTimeout(done, 220));
  assert.equal(pool.stats.running, 0);
  assert.equal(pool.stats.refused, 1);
  assert.equal(pool.stats.timedOut, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pool.run(slow(1), { signal: controller.signal }), (e: PoolError) => e.code === "CANCELLED");
});

test("a block is flushed when full or when its first byte has waited long enough", () => {
  const blocks: Buffer[] = [];
  let fire: (() => void) | null = null;
  const blocker = new Blocker({
    maxBlockBytes: 10,
    maxHoldMs: 100,
    onBlock: (b) => blocks.push(Buffer.from(b)),
    setTimer: (fn) => {
      fire = fn;
      return { clear: () => { fire = null; } };
    },
  });
  blocker.push(Buffer.from("abc"));
  assert.equal(blocks.length, 0);
  assert.ok(fire, "the clock started with the first byte");
  blocker.push(Buffer.from("defghijklmnop")); // 16 held: one full block, 6 left over
  assert.deepEqual(blocks.map(String), ["abcdefghij"]);
  assert.equal(blocker.pendingBytes, 6);
  assert.ok(fire, "the remainder started a new clock");
  (fire as unknown as () => void)();
  assert.deepEqual(blocks.map(String), ["abcdefghij", "klmnop"]);
  assert.equal(blocker.pendingBytes, 0);
  fire = null;
  blocker.push(Buffer.alloc(35, 0x41));
  assert.equal(blocks.length, 5, "a chunk bigger than a block is sliced");
  assert.equal(blocker.pendingBytes, 5);
  blocker.end();
  assert.equal(blocks.length, 6);
  blocker.push(Buffer.from("late"));
  assert.equal(blocks.length, 6, "nothing after end");
});

test("an aligned blocker cuts a full block at the packet boundary and keeps the rest", () => {
  const blocks: Buffer[] = [];
  const blocker = new Blocker({ maxBlockBytes: 1000, maxHoldMs: 100, align: 188, onBlock: (b) => blocks.push(b), setTimer: () => ({ clear: () => undefined }) });
  blocker.push(Buffer.alloc(1000, 0x47));
  assert.equal(blocks[0]?.length, 940, "five whole packets");
  assert.equal(blocker.pendingBytes, 60);
});

/** A plausible transport stream: N packets on a few PIDs with adaptation fields here and there. */
function fakeTs(packets: number, seed = 1): Buffer {
  const out = Buffer.alloc(packets * TS_PACKET);
  let x = seed;
  const rnd = (): number => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x;
  };
  for (let i = 0; i < packets; i += 1) {
    const at = i * TS_PACKET;
    const pid = i % 7 === 0 ? 0x1fff : [0x100, 0x101, 0x102][i % 3] as number;
    out[at] = 0x47;
    out[at + 1] = (pid >> 8) & 0x1f;
    out[at + 2] = pid & 0xff;
    const withAf = i % 5 === 0;
    out[at + 3] = (withAf ? 0x30 : 0x10) | (i & 0xf);
    let payloadAt = at + 4;
    if (withAf) {
      const len = 7 + (rnd() % 20);
      out[at + 4] = len;
      out[at + 5] = 0x10; // PCR flag
      payloadAt = at + 5 + len;
    }
    for (let j = payloadAt; j < at + TS_PACKET; j += 1) out[j] = pid === 0x1fff ? 0xff : rnd() & 0xff;
  }
  return out;
}

test("the transport-stream transform is exactly reversible, ragged edges and all", () => {
  const stream = fakeTs(300);
  for (const [head, tail] of [[0, 0], [17, 0], [0, 100], [50, 187], [187, 1]] as const) {
    const sample = Buffer.concat([randomBytes(head), stream, randomBytes(tail)]);
    const split = tsSplit(sample);
    assert.ok(split, `head ${head} tail ${tail}`);
    assert.ok(tsJoin(split).equals(sample), `head ${head} tail ${tail} joins back`);
  }
  assert.equal(tsSplit(randomBytes(5000)), null, "noise is not a transport stream");
  assert.equal(tsSplit(Buffer.alloc(0)), null);
  assert.equal(tsJoin(Buffer.from("junk")), null);
});

test("a packet with an adaptation length that overruns is kept whole, and a stream that loses sync keeps every byte", () => {
  const stream = fakeTs(40);
  stream[5 * TS_PACKET + 3] = 0x30;
  stream[5 * TS_PACKET + 4] = 250; // longer than a packet
  const broken = Buffer.concat([stream.subarray(0, 20 * TS_PACKET), Buffer.from("garbage in the middle"), stream.subarray(20 * TS_PACKET)]);
  const split = tsSplit(broken);
  assert.ok(split);
  assert.ok(tsJoin(split).equals(broken));
});

test("192- and 204-byte layouts are recognised and left alone", () => {
  const packets = fakeTs(20);
  const timestamped = Buffer.alloc(20 * 192);
  for (let i = 0; i < 20; i += 1) packets.copy(timestamped, i * 192 + 4, i * TS_PACKET, (i + 1) * TS_PACKET);
  assert.deepEqual(tsLayout(timestamped), { packetSize: 192, offset: 0 });
  assert.equal(tsSplit(timestamped), null);
  const fec = Buffer.alloc(20 * 204);
  for (let i = 0; i < 20; i += 1) packets.copy(fec, i * 204, i * TS_PACKET, (i + 1) * TS_PACKET);
  assert.deepEqual(tsLayout(fec), { packetSize: 204, offset: 0 });
  assert.equal(tsSplit(fec), null);
});

test("ts-zstd beats plain zstd on a padded transport stream, and both restore it", async () => {
  const stream = fakeTs(1400);
  const plain = await encode("zstd", stream, 1);
  const aware = await encode("ts-zstd", stream, 1);
  assert.ok(aware.length < plain.length, `ts-zstd ${aware.length} < zstd ${plain.length}`);
  assert.ok((await decode("ts-zstd", aware, stream.length)).equals(stream));
  await assert.rejects(encode("ts-zstd", randomBytes(3000), 1), (e: RelayError) => e.code === "BAD_MODE");
});

test("a policy change is checked field by field and never silently drops a typo", () => {
  const base = defaultPolicy();
  const ok = normalizePolicy({ losslessCompression: { mode: "auto", zstdLevel: 3 } }, base);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.policy.losslessCompression.mode, "auto");
    assert.equal(ok.policy.losslessCompression.zstdLevel, 3);
    assert.equal(ok.policy.hlsPackaging, "mpegts", "untouched");
    assert.equal(base.losslessCompression.mode, "off", "the base was not edited in place");
  }
  const bad = normalizePolicy({ losslessCompression: { mode: "brotli", zstdLevel: 99, typo: 1 }, qualityProfile: "low", extra: true }, base);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.length, 5, bad.errors.join("; "));
    assert.ok(bad.errors.some((e) => e.includes("typo")));
  }
  assert.equal(normalizePolicy("auto", base).ok, false);
  const contradictory = normalizePolicy({ losslessCompression: { minSavingsBytes: 262144 } }, base);
  assert.equal(contradictory.ok, false);
});

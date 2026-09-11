import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { analyzeSample, analyzeTs, benchmark, sniffContainer } from "../src/compression/analyze.ts";
import { TS_PACKET } from "../src/compression/ts-transform.ts";

/** Packets with a PCR every so often on PID 0x100, ticking at a known rate. */
function timedTs(packets: number, kbps: number): Buffer {
  const out = Buffer.alloc(packets * TS_PACKET);
  const ticksPerPacket = (TS_PACKET * 8 * 27_000_000) / (kbps * 1000);
  for (let i = 0; i < packets; i += 1) {
    const at = i * TS_PACKET;
    const pid = i % 4 === 3 ? 0x1fff : 0x100;
    out[at] = 0x47;
    out[at + 1] = (pid >> 8) & 0x1f;
    out[at + 2] = pid & 0xff;
    const pcrHere = pid === 0x100 && i % 8 === 0;
    out[at + 3] = (pcrHere ? 0x30 : 0x10) | (i & 0xf);
    let payloadAt = at + 4;
    if (pcrHere) {
      out[at + 4] = 7;
      out[at + 5] = 0x10;
      const ticks = Math.round(i * ticksPerPacket);
      const base = Math.floor(ticks / 300);
      const ext = ticks % 300;
      out[at + 6] = Math.floor(base / 2 ** 25) & 0xff;
      out[at + 7] = (base >> 17) & 0xff;
      out[at + 8] = (base >> 9) & 0xff;
      out[at + 9] = (base >> 1) & 0xff;
      out[at + 10] = ((base & 1) << 7) | 0x7e | (ext >> 8);
      out[at + 11] = ext & 0xff;
      payloadAt = at + 12;
    }
    out.fill(pid === 0x1fff ? 0xff : 0x55, payloadAt, at + TS_PACKET);
  }
  return out;
}

test("a container is told by its bytes, not its name", () => {
  assert.equal(sniffContainer(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypiso5"), Buffer.alloc(8)])), "fmp4");
  assert.equal(sniffContainer(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(8)])), "mp4");
  assert.equal(sniffContainer(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("moof"), Buffer.alloc(8)])), "fmp4");
  assert.equal(sniffContainer(timedTs(10, 2000)), "mpegts");
  assert.equal(sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), "webm");
  assert.equal(sniffContainer(Buffer.from("ID3\x04\x00")), "mp3");
  assert.equal(sniffContainer(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "mp3");
  assert.equal(sniffContainer(randomBytes(4000).fill(0, 0, 12)), "unknown");
  assert.equal(sniffContainer(Buffer.alloc(0)), "unknown");
});

test("the transport-stream report counts packets, padding, PIDs and the bitrate the PCR implies", () => {
  const stream = timedTs(4000, 3000);
  const report = analyzeTs(Buffer.concat([Buffer.from("xx"), stream, Buffer.from("tail")]));
  assert.ok(report);
  assert.equal(report.packetSize, 188);
  assert.equal(report.offset, 2);
  assert.equal(report.packets, 4000);
  assert.equal(report.nullPackets, 1000);
  assert.equal(report.nullShare, 0.25);
  assert.equal(report.unsynced, 6);
  assert.deepEqual(report.pids.map((p) => p.pid), [0x100, 0x1fff]);
  assert.ok(report.pcrBitrateKbps && Math.abs(report.pcrBitrateKbps - 3000) < 30, `pcr says ${report.pcrBitrateKbps} kbps`);
  assert.equal(analyzeTs(randomBytes(2000)), null);
});

test("the benchmark reports complete wire sizes with a checked round trip, and stored is the honest floor", async () => {
  const stream = timedTs(2000, 3000);
  const rows = await benchmark(stream, { blockBytes: 64 * 1024, zstdLevels: [1], tsAware: true });
  const by = Object.fromEntries(rows.map((r) => [r.mode, r]));
  assert.ok(by["stored"] && by["gzip"] && by["zstd"] && by["ts-zstd"]);
  for (const row of rows) assert.equal(row.roundTrip, true, row.mode);
  assert.ok(by["stored"]!.wireBytes > stream.length, "the envelope costs something");
  assert.ok(by["stored"]!.savingsPercent < 0);
  assert.ok(by["zstd"]!.wireBytes < by["stored"]!.wireBytes);
  // On a synthetic stream this regular both codecs squeeze it to almost
  // nothing, so which wins is noise; the core test shows the transform
  // winning on packets with real-looking payloads. Here: it took part.
  assert.ok(by["ts-zstd"]!.compressedBlocks > 0 && by["ts-zstd"]!.note === undefined, "ts-zstd was applied and round-tripped");
  assert.equal(by["zstd"]!.blocks, Math.ceil(stream.length / (64 * 1024)));

  const noise = await benchmark(randomBytes(100_000), { blockBytes: 32 * 1024, zstdLevels: [1] });
  const z = noise.find((r) => r.mode === "zstd")!;
  assert.equal(z.compressedBlocks, 0, "nothing qualified");
  assert.equal(z.storedBlocks, 4);
  assert.equal(z.wireBytes, noise.find((r) => r.mode === "stored")!.wireBytes, "stored blocks cost exactly what stored costs");
  const ts = await benchmark(randomBytes(10_000), { tsAware: true, zstdLevels: [] });
  assert.ok(ts.find((r) => r.mode === "ts-zstd")?.note, "ts-zstd on noise is reported as not applicable, not as a saving");
});

test("an analysis names its boundary, its sample, and a recommendation that never claims a saving it did not measure", async () => {
  const noise = randomBytes(50_000);
  const a = await analyzeSample(noise, { boundary: "channel", source: { kind: "bytes", name: "noise" }, zstdLevels: [1], sampleMs: 2000 });
  assert.equal(a.boundary, "channel");
  assert.equal(a.container, "unknown");
  assert.equal(a.ts, null);
  assert.equal(a.recommendation.mode, "stored");
  assert.equal(a.observedKbps, 200);
  assert.equal(a.sha256.length, 64);
  assert.ok(a.tools.runtime);
  const text = Buffer.from("the same line again and again\n".repeat(3000));
  const b = await analyzeSample(text, { boundary: "source", source: { kind: "file", name: "lines.txt" }, zstdLevels: [1, 3] });
  assert.equal(b.recommendation.mode, "zstd");
  assert.ok(b.recommendation.reason.includes("saves"));
  assert.equal(b.observedKbps, undefined, "no duration, no bitrate");
});

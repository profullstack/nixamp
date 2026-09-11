import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyStore } from "../src/compression/store.ts";
import { AnalysisJobs } from "../src/compression/jobs.ts";
import { StaticCache } from "../src/compression/static.ts";
import { RelayDecoder } from "../src/compression/relay.ts";
import { DEFAULT_LOSSLESS, variantOf } from "../src/compression/policy.ts";
import { packagerArgs, playlistReport, segmentName, segmentType, withKey } from "../src/hls.ts";
import { Channels } from "../src/channels.ts";
import { CompressionService, STATIC_CHANNEL } from "../src/compression/service.ts";
import type { Analysis } from "../src/compression/analyze.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "nixamp-compression-"));

test("a policy store keeps each channel's settings by port, checks what it reads back, and refuses a stale version", () => {
  const dir = scratch();
  try {
    const store = new PolicyStore(dir, 4321);
    assert.equal(store.get("main").losslessCompression.mode, "off", "off until somebody says otherwise");
    const first = store.set("main", { losslessCompression: { mode: "auto", zstdLevel: 3 } });
    assert.ok(first.ok);
    assert.equal(first.ok && first.policy.version, 1);
    const stale = store.set("main", { losslessCompression: { mode: "zstd" } }, 0);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.status, 412);
    const bad = store.set("main", { losslessCompression: { mode: "lzma" } }, 1);
    assert.equal(!bad.ok && bad.status, 400);
    assert.equal(store.get("main").losslessCompression.mode, "auto", "a refused change changes nothing");
    store.setGlobal({ enabled: false });

    const again = new PolicyStore(dir, 4321);
    assert.equal(again.get("main").losslessCompression.zstdLevel, 3);
    assert.equal(again.get("main").version, 1);
    assert.equal(again.global.enabled, false);
    assert.equal(new PolicyStore(dir, 9999).get("main").losslessCompression.mode, "off", "another port is another line-up");

    // Edited by hand into something impossible: dropped, not trusted.
    const raw = JSON.parse(readFileSync(join(dir, "compression.json"), "utf8")) as Record<string, { channels: Record<string, unknown> }>;
    raw["4321"]!.channels["main"] = { losslessCompression: { mode: "auto", zstdLevel: 900 }, version: 7 };
    writeFileSync(join(dir, "compression.json"), JSON.stringify(raw));
    assert.equal(new PolicyStore(dir, 4321).get("main").losslessCompression.mode, "off");
    assert.equal(new PolicyStore(null, 1).set("x", { hlsPackaging: "fmp4" }).ok, true, "no directory: works, remembers nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs run one at a time, share a running one, can be cancelled, and are forgotten in time", async () => {
  const jobs = new AnalysisJobs({ concurrency: 1, ttlMs: 50, maxJobs: 3 });
  const fake = { boundary: "channel" } as unknown as Analysis;
  let release: (() => void) | null = null;
  const slow = (signal: AbortSignal): Promise<Analysis> =>
    new Promise((done, fail) => {
      release = () => done(fake);
      signal.addEventListener("abort", () => fail(new Error("cancelled")));
    });
  const a = jobs.start("k1", "one", "control", slow)!;
  const same = jobs.start("k1", "one", "control", slow)!;
  assert.equal(same.existing, true);
  assert.equal(same.job.id, a.job.id);
  const b = jobs.start("k2", "two", "control", slow)!;
  assert.equal(b.job.status, "queued");
  assert.equal(jobs.start("k3", "three", "control", slow)!.job.status, "queued");
  assert.equal(jobs.start("k4", "four", "control", slow), null, "full");
  assert.equal(jobs.get(a.job.id, "somebody-else"), null, "not theirs to see");
  assert.equal(jobs.cancel(b.job.id, "control"), true);
  assert.equal(b.job.status, "cancelled");
  (release as unknown as () => void)();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(a.job.status, "done");
  assert.equal(jobs.counts.running, 1, "the third moved up");
  await new Promise((done) => setTimeout(done, 80));
  assert.equal(jobs.get(a.job.id, "control"), null, "forgotten after the TTL");
});

/** Read a whole envelope file back through the decoder. */
async function unpack(path: string): Promise<{ bytes: Buffer; frames: number }> {
  const pieces: Buffer[] = [];
  const decoder = new RelayDecoder({ modes: new Set(["stored", "zstd", "ts-zstd"] as const), onBytes: (b) => { pieces.push(b); } });
  await decoder.feed(readFileSync(path));
  await decoder.end();
  return { bytes: Buffer.concat(pieces), frames: decoder.frames };
}

test("a static representation is built once, published whole, restores the file exactly, and is dropped when the file changes", async () => {
  const dir = scratch();
  try {
    const file = join(dir, "film.ts");
    const content = Buffer.concat([Buffer.from("header ".repeat(5000)), randomBytes(50_000), Buffer.from("trailer ".repeat(5000))]);
    writeFileSync(file, content);
    const cache = new StaticCache(join(dir, "cache"));
    const policy = { ...DEFAULT_LOSSLESS, mode: "zstd" as const, maxBlockBytes: 16 * 1024 };
    const variant = variantOf(policy);
    assert.equal(cache.lookup(file, variant), null);
    const [one, two] = await Promise.all([cache.prepare(file, policy, variant), cache.prepare(file, policy, variant)]);
    assert.ok(one.ok && two.ok);
    assert.equal(one.ok && one.entry.blocks, Math.ceil(content.length / (16 * 1024)));
    assert.ok(one.ok && one.entry.compressedBlocks > 0 && one.entry.compressedBlocks < one.entry.blocks, "text squeezed, noise stored");
    assert.equal(one.ok && one.entry.bytes, one.ok ? readFileSync(one.path).length : -1, "the entry knows its own size");
    const back = await unpack(one.ok ? one.path : "");
    assert.ok(back.bytes.equals(content), "byte for byte");
    assert.ok(cache.lookup(file, variant), "found next time");
    assert.equal(cache.lookup(file, "other-variant"), null, "another variant is another entry");
    assert.ok(cache.totalBytes > 0);

    // The file changes: the entry no longer describes it and goes.
    writeFileSync(file, Buffer.concat([content, Buffer.from("!")]));
    assert.equal(cache.lookup(file, variant), null);
    assert.equal(cache.entries().length, 0);

    // A tiny budget: the second entry pushes the first out.
    const small = new StaticCache(join(dir, "small"), { maxBytes: 70_000 });
    const other = join(dir, "other.bin");
    writeFileSync(other, randomBytes(40_000));
    utimesSync(other, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    assert.ok((await small.prepare(file, policy, variant)).ok);
    assert.ok((await small.prepare(other, policy, variant)).ok);
    assert.equal(small.entries().length, 1, "only the newest fits");
    assert.equal(small.lookup(other, variant)?.entry.file, other);
    assert.equal((await small.prepare(join(dir, "missing"), policy, variant)).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fMP4 packaging names its init segment per run, keys the EXT-X-MAP line, and types segments by name", () => {
  const args = packagerArgs("/tmp/x", "fmp4", "abcd1234");
  assert.equal(args[args.indexOf("-hls_segment_type") + 1], "fmp4");
  assert.equal(args[args.indexOf("-hls_fmp4_init_filename") + 1], "init-abcd1234.mp4");
  assert.equal(args[args.indexOf("-hls_segment_filename") + 1], "/tmp/x/seg%05d.m4s");
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "copy"], "still never re-encodes");
  assert.ok(!packagerArgs("/tmp/x").includes("-hls_fmp4_init_filename"), "TS is as it was");

  assert.equal(segmentName("seg00003.m4s"), "seg00003.m4s");
  assert.equal(segmentName("init-abcd1234.mp4"), "init-abcd1234.mp4");
  assert.equal(segmentName("init.mp4"), "", "an init without a run token is not one of ours");
  assert.equal(segmentName("init-abcd1234.mp4/../x"), "");
  assert.equal(segmentType("seg00003.m4s"), "video/iso.segment");
  assert.equal(segmentType("init-abcd1234.mp4"), "video/mp4");
  assert.equal(segmentType("seg00003.ts"), "video/mp2t");

  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MAP:URI="init-abcd1234.mp4"',
    "#EXTINF:2.000000,",
    "seg00012.m4s",
    "#EXTINF:6.500000,",
    "seg00013.m4s",
    "",
  ].join("\n");
  const keyed = withKey(playlist, "k/1");
  assert.ok(keyed.includes('#EXT-X-MAP:URI="init-abcd1234.mp4?k=k%2F1"'), keyed);
  assert.ok(keyed.includes("seg00013.m4s?k=k%2F1"));
  const report = playlistReport(playlist, "fmp4");
  assert.deepEqual(report, { packaging: "fmp4", targetSeconds: 2, independent: true, longestSegmentSeconds: 6.5, segments: 2, initialised: true });
});

test("the service answers a relay only for a channel that is on, with compression on, to a receiver that can decode it", () => {
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const service = new CompressionService({ channels, stateDir: null, port: 1 });
  const listener = { write: () => true, end: () => undefined };
  const zstd = new Set(["zstd"] as const);
  let answer = service.relay("nope", listener, zstd);
  assert.equal(!answer.ok && answer.status, 404);

  const channel = channels.attach("live", "a device", "mp3", "http")!;
  answer = service.relay("live", listener, zstd);
  assert.equal(!answer.ok && answer.code, "COMPRESSION_OFF", "off by default");
  assert.equal(service.status("live").effective.reason, null);

  service.set("live", { losslessCompression: { mode: "auto", boundary: "source" } });
  answer = service.relay("live", listener, zstd);
  assert.equal(!answer.ok && answer.code, "SOURCE_BOUNDARY_UNAVAILABLE");
  assert.ok(service.status("live").effective.reason?.includes("original source bytes are unavailable"));

  service.set("live", { losslessCompression: { boundary: "channel" } });
  answer = service.relay("live", listener, new Set(["stored"] as const));
  assert.equal(!answer.ok && answer.status, 406, "a receiver that decodes nothing gets nothing");

  service.setGlobal({ enabled: false });
  answer = service.relay("live", listener, zstd);
  assert.equal(!answer.ok && answer.code, "COMPRESSION_OFF");
  assert.ok(service.status("live").effective.reason?.includes("whole server"));
  service.setGlobal({ enabled: true });

  answer = service.relay("live", listener, zstd);
  assert.ok(answer.ok);
  assert.deepEqual(answer.ok && answer.codecs, ["stored", "zstd"], "ts-zstd only when the policy asks for it");
  const status = service.status("live");
  assert.equal(status.relay?.sessions, 1);
  assert.equal(status.metrics?.generation, status.relay?.generation);
  assert.equal(channel.listeners.size, 1, "one encoder is one listener on the channel, however many receivers");
  const second = service.relay("live", { write: () => true, end: () => undefined }, zstd);
  assert.ok(second.ok && second.generation === (answer.ok ? answer.generation : -1), "the second receiver joined the same encoder");
  assert.equal(channel.listeners.size, 1);

  // The static pseudo-channel governs file representations.
  assert.equal(service.representation("/nonexistent").state, "off", "no cache directory");
  assert.equal(service.status(STATIC_CHANNEL).configured.losslessCompression.mode, "off");
  assert.equal(service.packagingOf("live"), "mpegts");
  service.setGlobal({ hlsPackaging: "fmp4" });
  assert.equal(service.packagingOf("never-configured"), "fmp4", "the server's default for a channel with no policy");
  assert.equal(service.packagingOf("live"), "mpegts", "a channel with its own policy keeps its own packaging");
  service.stopAll();
  channels.stopAll();
});

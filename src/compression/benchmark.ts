/**
 * The OpenStream benchmark: what a codec makes of a defined corpus, on this
 * machine, with every number reproducible and nothing claimed that was not
 * measured.
 *
 * It proves the honest things: that decompression restores every byte, that
 * an incompressible sample costs only the envelope overhead and never more,
 * that a compressible one saves what it says against the complete wire size,
 * and how long each takes. It does not prove a production saving -- a
 * synthetic padded stream compresses to almost nothing, which says more about
 * the padding than the codec, and the report labels it so. Point it at real
 * authorized samples with `--corpus` for numbers that mean something.
 *
 * The corpus is built from bytes alone by default, so anyone can run it with
 * no ffmpeg and no media: random data, zeros, repetitive text, tiny and empty
 * inputs, and hand-built transport-stream packets with a known share of null
 * padding. ffmpeg, when present, adds real encoded media; a directory of your
 * own files replaces the lot.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { type BenchRow, benchmark } from "./analyze.ts";
import { toolVersions } from "./codec.ts";
import { ENVELOPE_VERSION, FRAME_HEADER_BYTES, MAGIC, STREAM_HEADER_BYTES } from "./envelope.ts";
import { DEFAULT_LOSSLESS } from "./policy.ts";
import { SYNC, TS_PACKET } from "./ts-transform.ts";

/** The report schema version, bumped when the shape below changes. */
export const REPORT_SCHEMA = 1;

export interface Sample {
  name: string;
  /** synthetic bytes we generated, or a real file the runner supplied. */
  kind: "synthetic" | "real";
  bytes: Buffer;
  /** A word on what it is and why it is in the corpus. */
  notes: string;
}

export interface SampleResult {
  sample: string;
  kind: Sample["kind"];
  inputBytes: number;
  sha256: string;
  container: string;
  rows: BenchRow[];
  /** The mode the policy would pick for this sample, and why. */
  recommendation: { mode: string; level: number; reason: string };
}

export interface BenchmarkReport {
  schema: number;
  spec: "openstream";
  specVersion: string;
  generatedAt: string;
  implementation: { name: string; version: string };
  environment: {
    runtime: string;
    zstd: string;
    zlib: string;
    os: string;
    arch: string;
    cpu: string;
    cores: number;
    memoryGiB: number;
  };
  envelope: { magic: string; streamHeaderBytes: number; frameHeaderBytes: number };
  policy: { minSavingsPercent: number; minSavingsBytes: number; maxBlockBytes: number; zstdLevels: number[] };
  samples: SampleResult[];
  /** Per mode, summed across the corpus: the honest aggregate. */
  summary: {
    corpusBytes: number;
    byMode: { mode: string; level: number; wireBytes: number; savingsPercent: number; roundTrip: boolean; encodeMs: number; decodeMs: number }[];
  };
  caveats: string[];
}

/**
 * A deterministic, genuinely incompressible fill: a SHA-256 keystream from a
 * fixed seed. Reproducible byte-for-byte across runs (so two reports compare)
 * and uncompressible (so the "floor" sample is really the floor, unlike a
 * linear-congruential stream, whose periodicity a compressor crushes).
 */
function keystream(size: number, seed: string): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash("sha256").update(seed).digest();
  let at = 0;
  while (at < size) {
    const take = Math.min(block.length, size - at);
    block.copy(out, at, 0, take);
    at += take;
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

/** Transport-stream packets, a given share of them null padding, payloads incompressible. */
function fakeTs(packets: number, nullEvery: number, seed = "ts"): Buffer {
  const out = Buffer.alloc(packets * TS_PACKET);
  const fill = keystream(packets * TS_PACKET, seed);
  for (let i = 0; i < packets; i += 1) {
    const at = i * TS_PACKET;
    const isNull = nullEvery > 0 && i % nullEvery === 0;
    const pid = isNull ? 0x1fff : [0x100, 0x101, 0x102][i % 3] as number;
    out[at] = SYNC;
    out[at + 1] = (pid >> 8) & 0x1f;
    out[at + 2] = pid & 0xff;
    out[at + 3] = 0x10 | (i & 0xf);
    for (let j = at + 4; j < at + TS_PACKET; j += 1) out[j] = isNull ? 0xff : (fill[j] as number);
  }
  return out;
}

/** The default corpus: bytes only, no ffmpeg, deterministic. */
export function syntheticCorpus(): Sample[] {
  return [
    { name: "random-1mib", kind: "synthetic", bytes: keystream(1024 * 1024, "random"), notes: "incompressible: the floor, where a codec must not grow the data beyond envelope overhead" },
    { name: "zeros-1mib", kind: "synthetic", bytes: Buffer.alloc(1024 * 1024, 0), notes: "maximally compressible: the ceiling" },
    { name: "text-repeat-1mib", kind: "synthetic", bytes: Buffer.from("the quick brown fox jumps over the lazy dog\n".repeat(24000)).subarray(0, 1024 * 1024), notes: "repetitive text: ordinary redundancy" },
    { name: "ts-padded-50pct", kind: "synthetic", bytes: fakeTs(4000, 2), notes: "transport stream, half null packets: padding a copy must keep and a codec removes; the synthetic case that flatters a codec" },
    { name: "ts-unpadded", kind: "synthetic", bytes: fakeTs(4000, 0), notes: "transport stream, no padding: closer to an efficient real feed" },
    { name: "tiny-3b", kind: "synthetic", bytes: Buffer.from("abc"), notes: "smaller than a frame header: proves overhead is reported honestly" },
    { name: "empty", kind: "synthetic", bytes: Buffer.alloc(0), notes: "the empty stream" },
  ];
}

/** Real files a runner points us at, each read whole (capped) as a sample. */
export function fileCorpus(dir: string, capBytes = 64 * 1024 * 1024): Sample[] {
  const out: Sample[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const whole = readFileSync(path);
      out.push({ name, kind: "real", bytes: whole.subarray(0, capBytes), notes: whole.length > capBytes ? `real file, first ${capBytes} bytes of ${whole.length}` : "real file" });
    } catch {
      // Unreadable entries are skipped, not fatal.
    }
  }
  return out;
}

export interface RunOptions {
  implementationVersion: string;
  zstdLevels?: number[];
  blockBytes?: number;
  signal?: AbortSignal;
}

/** Run the corpus and build the report. */
export async function runBenchmark(corpus: Sample[], options: RunOptions): Promise<BenchmarkReport> {
  const zstdLevels = options.zstdLevels ?? [1, 3, 9];
  const blockBytes = options.blockBytes ?? DEFAULT_LOSSLESS.maxBlockBytes;
  const policy = { minSavingsPercent: DEFAULT_LOSSLESS.minSavingsPercent, minSavingsBytes: DEFAULT_LOSSLESS.minSavingsBytes };
  const samples: SampleResult[] = [];
  for (const sample of corpus) {
    if (options.signal?.aborted) break;
    const rows = await benchmark(sample.bytes, { blockBytes, zstdLevels, tsAware: true, policy, ...(options.signal ? { signal: options.signal } : {}) });
    const stored = rows.find((r) => r.mode === "stored");
    const best = rows.filter((r) => r.roundTrip && r.mode !== "stored").sort((a, b) => a.wireBytes - b.wireBytes)[0];
    const beats = stored && best && stored.wireBytes - best.wireBytes >= policy.minSavingsBytes && ((stored.wireBytes - best.wireBytes) * 100) / stored.wireBytes >= policy.minSavingsPercent;
    samples.push({
      sample: sample.name,
      kind: sample.kind,
      inputBytes: sample.bytes.length,
      sha256: createHash("sha256").update(sample.bytes).digest("hex"),
      container: rows.length ? sniff(sample.bytes) : "empty",
      rows,
      recommendation: beats && best
        ? { mode: best.mode, level: best.level, reason: `saves ${best.savingsPercent}% of the complete wire size` }
        : { mode: "stored", level: 0, reason: "no codec beat stored by the configured margin" },
    });
  }
  const byMode = aggregate(samples);
  const cpu = cpus()[0]?.model ?? "unknown";
  return {
    schema: REPORT_SCHEMA,
    spec: "openstream",
    specVersion: MAGIC,
    generatedAt: new Date().toISOString(),
    implementation: { name: "nixamp", version: options.implementationVersion },
    environment: {
      ...toolVersions(),
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu,
      cores: cpus().length,
      memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    },
    envelope: { magic: MAGIC, streamHeaderBytes: STREAM_HEADER_BYTES, frameHeaderBytes: FRAME_HEADER_BYTES },
    policy: { ...policy, maxBlockBytes: blockBytes, zstdLevels },
    samples,
    summary: { corpusBytes: corpus.reduce((n, s) => n + s.bytes.length, 0), byMode },
    caveats: [
      `Envelope v${ENVELOPE_VERSION}: a ${STREAM_HEADER_BYTES}-byte stream header, a ${FRAME_HEADER_BYTES}-byte header per frame, plus one end frame.`,
      "OpenStream is a framing envelope over Zstandard and gzip, not a new compression algorithm; these numbers are those codecs at the block boundary, honestly framed.",
      "Synthetic samples do not predict production savings. A padded transport stream flatters a codec by its padding; an efficient real feed saves far less. Use --corpus with authorized real samples for numbers that mean something.",
      "Timings are wall-clock on the machine and runtime named in `environment` and do not transfer to other hardware.",
      "roundTrip:false in any row is a failure of exactness and must block a release.",
    ],
  };
}

function sniff(bytes: Buffer): string {
  // A light container guess for the report; the full analyzer is elsewhere.
  if (bytes.length >= 8 && bytes.toString("latin1", 4, 8) === "ftyp") return "mp4";
  if (bytes.length >= TS_PACKET && bytes[0] === SYNC && bytes[TS_PACKET] === SYNC) return "mpegts";
  return "bytes";
}

function aggregate(samples: SampleResult[]): BenchmarkReport["summary"]["byMode"] {
  const modes = new Map<string, { mode: string; level: number; wireBytes: number; input: number; roundTrip: boolean; encodeMs: number; decodeMs: number }>();
  for (const sample of samples) {
    for (const row of sample.rows) {
      // A row with a note is a mode that did not apply to this sample (ts-zstd
      // on non-transport bytes, say). It is not a saving and not a failure, so
      // it is left out of the aggregate rather than dragging a mode down.
      if (row.note) continue;
      const key = `${row.mode}:${row.level}`;
      const acc = modes.get(key) ?? { mode: row.mode, level: row.level, wireBytes: 0, input: 0, roundTrip: true, encodeMs: 0, decodeMs: 0 };
      acc.wireBytes += row.wireBytes;
      acc.input += row.inputBytes;
      acc.roundTrip = acc.roundTrip && row.roundTrip;
      acc.encodeMs += row.encodeMs;
      acc.decodeMs += row.decodeMs;
      modes.set(key, acc);
    }
  }
  return [...modes.values()].map((m) => ({
    mode: m.mode,
    level: m.level,
    wireBytes: m.wireBytes,
    savingsPercent: m.input === 0 ? 0 : Math.round(((m.input - m.wireBytes) * 100) / m.input * 100) / 100,
    roundTrip: m.roundTrip,
    encodeMs: Math.round(m.encodeMs * 100) / 100,
    decodeMs: Math.round(m.decodeMs * 100) / 100,
  }));
}

/** The report as Markdown, for a human and for the reports page. */
export function reportMarkdown(report: BenchmarkReport): string {
  const e = report.environment;
  const lines: string[] = [];
  lines.push(`# OpenStream benchmark — ${report.implementation.name} ${report.implementation.version}`);
  lines.push("");
  lines.push(`Generated ${report.generatedAt} · envelope ${report.specVersion} · schema ${report.schema}`);
  lines.push("");
  lines.push(`**Environment.** ${e.runtime}, zstd ${e.zstd}, zlib ${e.zlib}, on ${e.os} ${e.arch}, ${e.cores}× ${e.cpu}, ${e.memoryGiB} GiB.`);
  lines.push("");
  lines.push(`**Policy.** block ${report.policy.maxBlockBytes} B; eligible at ${report.policy.minSavingsPercent}% and ${report.policy.minSavingsBytes} B; zstd levels ${report.policy.zstdLevels.join(", ")}.`);
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push("| sample | kind | bytes | container | best mode | saves |");
  lines.push("| --- | --- | ---: | --- | --- | ---: |");
  for (const s of report.samples) {
    const best = s.rows.filter((r) => r.roundTrip && r.mode !== "stored").sort((a, b) => a.wireBytes - b.wireBytes)[0];
    const saves = s.recommendation.mode === "stored" ? "stored" : `${best?.savingsPercent ?? 0}%`;
    lines.push(`| ${s.sample} | ${s.kind} | ${s.inputBytes} | ${s.container} | ${s.recommendation.mode}${s.recommendation.level ? ` L${s.recommendation.level}` : ""} | ${saves} |`);
  }
  lines.push("");
  lines.push("## Aggregate, per mode across the corpus");
  lines.push("");
  lines.push("| mode | wire bytes | saving | enc ms | dec ms | round trip |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const m of report.summary.byMode) {
    lines.push(`| ${m.mode}${m.level ? ` L${m.level}` : ""} | ${m.wireBytes} | ${m.savingsPercent >= 0 ? "+" : ""}${m.savingsPercent}% | ${m.encodeMs} | ${m.decodeMs} | ${m.roundTrip ? "ok" : "FAILED"} |`);
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  for (const c of report.caveats) lines.push(`- ${c}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Whether every applicable codec restored exactly: the gate a release must
 * pass. A row with a note is a mode that did not apply to that sample, not a
 * corrupted round trip, so it does not fail the gate.
 */
export function reportPasses(report: BenchmarkReport): boolean {
  return report.samples.every((s) => s.rows.every((r) => r.roundTrip || Boolean(r.note)));
}

/** The rows that are a real exactness failure: ran, and did not restore. */
export function exactnessFailures(report: BenchmarkReport): { sample: string; mode: string; level: number }[] {
  const out: { sample: string; mode: string; level: number }[] = [];
  for (const s of report.samples) {
    for (const r of s.rows) {
      if (!r.roundTrip && !r.note) out.push({ sample: s.sample, mode: r.mode, level: r.level });
    }
  }
  return out;
}

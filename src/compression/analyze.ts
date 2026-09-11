/**
 * What is in a sample, and what each codec makes of it.
 *
 * Bytes are inspected, not filenames: a .ts that is really an MP4 is told
 * apart by its sync bytes, or their absence. The transport-stream report
 * counts what can be counted without decoding anything -- packets, null
 * packets, PIDs, the bitrate the PCR clock implies. The benchmark then runs
 * every codec over the same blocks and reports the complete wire size,
 * headers included, with a round trip checked on every block. Nothing here
 * is a promise about production sources; it is a measurement of this
 * sample on this machine, and says so.
 */
import { createHash } from "node:crypto";
import { decode, encode, toolVersions } from "./codec.ts";
import { type Boundary, FRAME_HEADER_BYTES, type Mode, STREAM_HEADER_BYTES } from "./envelope.ts";
import { DEFAULT_LOSSLESS, eligible, type LosslessPolicy } from "./policy.ts";
import { SYNC, TS_PACKET, tsLayout } from "./ts-transform.ts";

/** Sample limits: bytes, and seconds of a live channel. */
export const SAMPLE_MAX_BYTES = 25 * 1024 * 1024;
export const SAMPLE_MAX_SECONDS = 30;

export type Container = "mpegts" | "fmp4" | "mp4" | "mp3" | "webm" | "unknown";

/** Which container the first bytes say they are. */
export function sniffContainer(bytes: Uint8Array): Container {
  if (bytes.length >= 12) {
    const box = Buffer.from(bytes.subarray(4, 8)).toString("latin1");
    if (box === "ftyp" || box === "styp") {
      const brand = Buffer.from(bytes.subarray(8, 12)).toString("latin1");
      return brand === "iso5" || brand === "iso6" || brand === "dash" || brand === "cmfc" ? "fmp4" : "mp4";
    }
    if (box === "moof" || box === "moov" || box === "sidx") return "fmp4";
  }
  if (tsLayout(bytes) !== null) return "mpegts";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

export interface TsReport {
  packetSize: 188 | 192 | 204;
  offset: number;
  packets: number;
  nullPackets: number;
  /** Of all packets. Padding a compressor removes for free, and that a copy must keep. */
  nullShare: number;
  scrambled: number;
  transportErrors: number;
  adaptationOnly: number;
  /** Bytes not inside an aligned packet: a ragged head or tail. Kept, always. */
  unsynced: number;
  pids: { pid: number; packets: number }[];
  /** What the PCR clock says the whole stream runs at, when there is a PCR to read. */
  pcrBitrateKbps?: number;
}

/** PCR base and extension, as a count of 27 MHz ticks, from an adaptation field that has one. */
function pcrOf(packet: Uint8Array, at: number): number | null {
  const afc = ((packet[at + 3] as number) >> 4) & 0x3;
  if ((afc & 0b10) === 0) return null;
  const length = packet[at + 4] as number;
  if (length < 7) return null;
  const flags = packet[at + 5] as number;
  if ((flags & 0x10) === 0) return null;
  const b = packet.subarray(at + 6, at + 12);
  const base =
    ((b[0] as number) * 2 ** 25) + ((b[1] as number) << 17) + ((b[2] as number) << 9) + ((b[3] as number) << 1) + ((b[4] as number) >> 7);
  const ext = (((b[4] as number) & 0x1) << 8) | (b[5] as number);
  return base * 300 + ext;
}

/** The transport-stream report, or null for something that is not one. */
export function analyzeTs(bytes: Uint8Array): TsReport | null {
  const layout = tsLayout(bytes);
  if (layout === null) return null;
  const { packetSize, offset } = layout;
  const skip = packetSize === 192 ? 4 : 0;
  const pids = new Map<number, number>();
  let packets = 0;
  let nullPackets = 0;
  let scrambled = 0;
  let transportErrors = 0;
  let adaptationOnly = 0;
  let firstPcr: { pid: number; value: number; at: number } | null = null;
  let lastPcr: { value: number; at: number } | null = null;
  let cursor = offset;
  while (cursor + packetSize <= bytes.length && bytes[cursor + skip] === SYNC) {
    const at = cursor + skip;
    const b1 = bytes[at + 1] as number;
    const b2 = bytes[at + 2] as number;
    const b3 = bytes[at + 3] as number;
    const pid = ((b1 & 0x1f) << 8) | b2;
    packets += 1;
    pids.set(pid, (pids.get(pid) ?? 0) + 1);
    if (pid === 0x1fff) nullPackets += 1;
    if (b1 & 0x80) transportErrors += 1;
    if (b3 & 0xc0) scrambled += 1;
    if (((b3 >> 4) & 0x3) === 0b10) adaptationOnly += 1;
    const pcr = pcrOf(bytes, at);
    if (pcr !== null) {
      if (firstPcr === null) firstPcr = { pid, value: pcr, at: cursor };
      else if (firstPcr.pid === pid && pcr > firstPcr.value) lastPcr = { value: pcr, at: cursor };
    }
    cursor += packetSize;
  }
  const report: TsReport = {
    packetSize,
    offset,
    packets,
    nullPackets,
    nullShare: packets === 0 ? 0 : nullPackets / packets,
    scrambled,
    transportErrors,
    adaptationOnly,
    unsynced: offset + (bytes.length - cursor),
    pids: [...pids.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([pid, count]) => ({ pid, packets: count })),
  };
  if (firstPcr && lastPcr) {
    const seconds = (lastPcr.value - firstPcr.value) / 27_000_000;
    if (seconds > 0.5) report.pcrBitrateKbps = Math.round(((lastPcr.at - firstPcr.at) * 8) / seconds / 1000);
  }
  return report;
}

export interface BenchRow {
  mode: Mode;
  level: number;
  blocks: number;
  inputBytes: number;
  /** Payload bytes after the eligibility rule: stored where compression did not pay. */
  payloadBytes: number;
  /** The complete representation: stream header, every frame header, every payload. */
  wireBytes: number;
  storedBlocks: number;
  compressedBlocks: number;
  /** Against the unwrapped original, headers included. Negative means it grew. */
  savingsPercent: number;
  encodeMs: number;
  decodeMs: number;
  roundTrip: boolean;
  /** Set when a mode could not be applied at all, e.g. ts-zstd on an MP4. */
  note?: string;
}

export interface BenchOptions {
  blockBytes?: number;
  zstdLevels?: number[];
  policy?: Pick<LosslessPolicy, "minSavingsPercent" | "minSavingsBytes">;
  /** Try the transport-stream transform too. */
  tsAware?: boolean;
  signal?: AbortSignal;
}

/**
 * Every codec over the same blocks. The identity row is the honest floor:
 * what the envelope costs when nothing is saved.
 */
export async function benchmark(bytes: Buffer, options: BenchOptions = {}): Promise<BenchRow[]> {
  const blockBytes = options.blockBytes ?? DEFAULT_LOSSLESS.maxBlockBytes;
  const policy = options.policy ?? DEFAULT_LOSSLESS;
  const plan: { mode: Mode; level: number }[] = [{ mode: "stored", level: 0 }, { mode: "gzip", level: 6 }];
  for (const level of options.zstdLevels ?? [1, 3]) plan.push({ mode: "zstd", level });
  if (options.tsAware) plan.push({ mode: "ts-zstd", level: 1 });
  const rows: BenchRow[] = [];
  for (const { mode, level } of plan) {
    if (options.signal?.aborted) break;
    const row: BenchRow = {
      mode, level, blocks: 0, inputBytes: bytes.length, payloadBytes: 0, wireBytes: STREAM_HEADER_BYTES + FRAME_HEADER_BYTES,
      storedBlocks: 0, compressedBlocks: 0, savingsPercent: 0, encodeMs: 0, decodeMs: 0, roundTrip: true,
    };
    try {
      for (let at = 0; at < bytes.length; at += blockBytes) {
        if (options.signal?.aborted) throw new Error("cancelled");
        const block = bytes.subarray(at, Math.min(bytes.length, at + blockBytes));
        row.blocks += 1;
        const t0 = performance.now();
        const encoded = mode === "stored" ? block : await encode(mode, block, level);
        row.encodeMs += performance.now() - t0;
        const keep = mode !== "stored" && eligible(block.length, encoded.length, policy);
        const payload = keep ? encoded : block;
        if (keep) row.compressedBlocks += 1;
        else row.storedBlocks += 1;
        row.payloadBytes += payload.length;
        row.wireBytes += FRAME_HEADER_BYTES + payload.length;
        const t1 = performance.now();
        const back = keep ? await decode(mode, payload, block.length) : payload;
        row.decodeMs += performance.now() - t1;
        if (!back.equals(block)) row.roundTrip = false;
      }
    } catch (error) {
      row.note = (error as Error).message;
      row.roundTrip = false;
    }
    row.savingsPercent = bytes.length === 0 ? 0 : ((bytes.length - row.wireBytes) * 100) / bytes.length;
    row.encodeMs = Math.round(row.encodeMs * 100) / 100;
    row.decodeMs = Math.round(row.decodeMs * 100) / 100;
    row.savingsPercent = Math.round(row.savingsPercent * 100) / 100;
    rows.push(row);
  }
  return rows;
}

export interface Analysis {
  /** Which bytes these are: the source as it arrived, or the channel's output. */
  boundary: Boundary;
  source: { kind: "file" | "channel" | "bytes"; name: string };
  sampleBytes: number;
  sampleMs?: number;
  truncated: boolean;
  sha256: string;
  container: Container;
  ts: TsReport | null;
  /** From ffprobe, when the caller had one to ask. */
  codecs?: { video: string; audio: string; container: string; duration?: number };
  /** What the sample's own length and duration imply, when a duration is known. */
  observedKbps?: number;
  bench: BenchRow[];
  /** The rows' verdict under the policy thresholds: which mode `auto` would take. */
  recommendation: { mode: Mode; level: number; reason: string };
  tools: ReturnType<typeof toolVersions> & { ffprobe?: string };
  at: string;
}

export interface AnalyzeOptions extends BenchOptions {
  boundary: Boundary;
  source: Analysis["source"];
  sampleMs?: number;
  truncated?: boolean;
  codecs?: Analysis["codecs"];
  ffprobeVersion?: string;
}

export async function analyzeSample(bytes: Buffer, options: AnalyzeOptions): Promise<Analysis> {
  const ts = analyzeTs(bytes);
  const bench = await benchmark(bytes, { ...options, tsAware: options.tsAware ?? ts?.packetSize === TS_PACKET });
  const stored = bench.find((row) => row.mode === "stored");
  const best = bench
    .filter((row) => row.roundTrip && row.mode !== "stored")
    .sort((a, b) => a.wireBytes - b.wireBytes)[0];
  const policy = options.policy ?? DEFAULT_LOSSLESS;
  let recommendation: Analysis["recommendation"];
  if (!best || !stored || !eligible(stored.wireBytes, best.wireBytes, policy)) {
    recommendation = { mode: "stored", level: 0, reason: "already efficiently compressed: no codec beat stored by the configured margin" };
  } else {
    recommendation = { mode: best.mode, level: best.level, reason: `${best.mode} level ${best.level} saves ${best.savingsPercent}% of the complete wire size on this sample` };
  }
  const analysis: Analysis = {
    boundary: options.boundary,
    source: options.source,
    sampleBytes: bytes.length,
    truncated: options.truncated ?? false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    container: sniffContainer(bytes),
    ts,
    bench,
    recommendation,
    tools: { ...toolVersions(), ...(options.ffprobeVersion ? { ffprobe: options.ffprobeVersion } : {}) },
    at: new Date().toISOString(),
  };
  if (options.sampleMs !== undefined) analysis.sampleMs = options.sampleMs;
  if (options.codecs) analysis.codecs = options.codecs;
  const seconds = options.sampleMs !== undefined ? options.sampleMs / 1000 : options.codecs?.duration;
  if (seconds && seconds > 0 && !options.truncated) analysis.observedKbps = Math.round((bytes.length * 8) / seconds / 1000);
  return analysis;
}

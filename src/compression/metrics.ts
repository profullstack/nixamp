/**
 * What was measured, per channel, and only what was measured.
 *
 * Input bytes are what the channel produced. Wire bytes are what went to
 * relay listeners, headers included, counted once per listener because
 * each listener is a separate cost on the network. Neither is a saving
 * until it is compared with the other, and a block that was stored saved
 * nothing -- these counters say so rather than counting what compression
 * might have done.
 */
export type FallbackReason =
  | "compression is off"
  | "already efficiently compressed"
  | "receiver does not support this format"
  | "processing budget exceeded"
  | "original source bytes are unavailable"
  | "slow listener";

export interface ChannelMetricsSnapshot {
  generation: number;
  /** Bytes in from the channel since this generation began. */
  inputBytes: number;
  /** Payload bytes out, before fan-out: what one listener would receive. */
  representationBytes: number;
  /** Payload plus headers, summed over every listener that was sent it. */
  wireBytes: number;
  blocks: number;
  storedBlocks: number;
  compressedBlocks: number;
  /** Which codec produced the most recent compressed block, or stored. */
  activeMode: string;
  bypassed: boolean;
  bypassUntil: number | null;
  /** From the first byte of a block entering to its being ready, milliseconds. */
  latencyMs: { last: number; p50: number; p95: number; max: number; samples: number };
  queueBytes: number;
  listeners: number;
  droppedListeners: number;
  codecFailures: number;
  fallbackReason: FallbackReason | null;
}

const LATENCY_WINDOW = 512;

export class ChannelMetrics {
  generation = 0;
  inputBytes = 0;
  representationBytes = 0;
  wireBytes = 0;
  blocks = 0;
  storedBlocks = 0;
  compressedBlocks = 0;
  activeMode = "stored";
  bypassed = false;
  bypassUntil: number | null = null;
  queueBytes = 0;
  listeners = 0;
  droppedListeners = 0;
  codecFailures = 0;
  fallbackReason: FallbackReason | null = null;
  private latencies: number[] = [];

  latency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  /** A new run of the source: the per-generation counters start over. */
  reset(generation: number): void {
    this.generation = generation;
    this.inputBytes = 0;
    this.representationBytes = 0;
    this.wireBytes = 0;
    this.blocks = 0;
    this.storedBlocks = 0;
    this.compressedBlocks = 0;
    this.queueBytes = 0;
    this.latencies = [];
  }

  snapshot(): ChannelMetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number));
    return {
      generation: this.generation,
      inputBytes: this.inputBytes,
      representationBytes: this.representationBytes,
      wireBytes: this.wireBytes,
      blocks: this.blocks,
      storedBlocks: this.storedBlocks,
      compressedBlocks: this.compressedBlocks,
      activeMode: this.activeMode,
      bypassed: this.bypassed,
      bypassUntil: this.bypassUntil,
      latencyMs: {
        last: sorted.length === 0 ? 0 : (this.latencies[this.latencies.length - 1] as number),
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
        samples: sorted.length,
      },
      queueBytes: this.queueBytes,
      listeners: this.listeners,
      droppedListeners: this.droppedListeners,
      codecFailures: this.codecFailures,
      fallbackReason: this.fallbackReason,
    };
  }
}

/**
 * One compressor per channel, however many receivers.
 *
 * The encoder is a listener on the channel like any other. What it hears
 * goes into blocks, each block is squeezed once on the pool, and the result
 * is written to every relay session -- the payload shared, the frame header
 * stamped per session because each session numbers its own frames. A
 * session that joins late is first sent the channel's opening bytes (the
 * header and the recent backlog, exactly what an ordinary listener gets)
 * compressed for it alone, and then falls in with the shared blocks from
 * the moment it joined. Nothing is sent twice and nothing is skipped: the
 * encoder flushes its half-built block before it records where "the
 * moment it joined" is.
 *
 * Bypass, overflow and slow listeners are all decided here and all bounded.
 * A block that does not compress is sent stored; `auto` stops trying after
 * a run of those and tries again later. A compressor that falls behind by
 * more than the channel's queue limit ends its relays rather than either
 * buffering for ever or stalling the channel. A session whose socket is
 * not draining is cut off, on its own, and the channel never knows.
 */
import { createHash } from "node:crypto";
import { Blocker } from "./blocks.ts";
import { decode, encode, Pool, PoolError } from "./codec.ts";
import {
  type Boundary,
  decodeFrameHeader,
  decodeStreamHeader,
  encodeEndFrame,
  encodeFrameHeader,
  encodeStreamHeader,
  FRAME_DATA,
  FRAME_END,
  FRAME_HEADER_BYTES,
  type FrameHeader,
  endFrameTotal,
  type Mode,
  RelayError,
  sha256,
  STREAM_HEADER_BYTES,
  type StreamHeader,
} from "./envelope.ts";
import type { ChannelMetrics, FallbackReason } from "./metrics.ts";
import { eligible, type LosslessPolicy } from "./policy.ts";
import { TS_PACKET, tsLayout } from "./ts-transform.ts";

/** Somewhere frames go: a response, in practice. `pending` is how far behind it is. */
export interface RelayListener {
  write(chunk: Buffer): boolean;
  end(): void;
  pending?(): number;
}

export interface EncodedBlock {
  /** Offset of this block's first byte since the encoder attached. */
  start: number;
  mode: Mode;
  original: Buffer;
  digest: Buffer;
  payload: Buffer;
}

/** How many blocks in a row may fail to pay before `auto` stops trying, for a while. */
export const GIVE_UP_AFTER = 8;

export interface RelayEncoderOptions {
  generation: number;
  policy: LosslessPolicy;
  pool: Pool;
  metrics: ChannelMetrics;
  boundary: Boundary;
  /** The compressor fell too far behind, or the channel ended: this relay is over. */
  onAbort: (reason: FallbackReason | "ended") => void;
  /** The last session left. */
  onIdle: () => void;
  now?: () => number;
}

export class RelayEncoder {
  private attached = false;
  private readonly blocker: Blocker;
  private chain: Promise<void> = Promise.resolve();
  private pushed = 0;
  private readonly sessions = new Set<RelaySession>();
  private ineligibleRun = 0;
  private bypassUntil: number | null = null;
  private closed = false;
  private readonly now: () => number;
  readonly streamHeader: Buffer;

  constructor(private readonly options: RelayEncoderOptions) {
    this.now = options.now ?? (() => performance.now());
    const { policy } = options;
    this.blocker = new Blocker({
      maxBlockBytes: policy.maxBlockBytes,
      maxHoldMs: policy.maxHoldMs,
      align: policy.tsAware ? TS_PACKET : 0,
      onBlock: (block) => this.onBlock(block),
    });
    this.streamHeader = encodeStreamHeader({
      version: 1,
      boundary: options.boundary,
      generation: options.generation,
      maxFrameBytes: policy.maxBlockBytes,
    });
    options.metrics.reset(options.generation);
    options.metrics.fallbackReason = null;
  }

  get generation(): number {
    return this.options.generation;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Call once `Channel.listen` has returned. What it wrote before then was
   * the opening bytes, which every session gets for itself as its preface;
   * taking them here too would send them twice to the first session.
   */
  attach(): void {
    this.attached = true;
  }

  /** The channel's listener face. */
  write(chunk: Buffer): boolean {
    if (!this.attached || this.closed) return true;
    this.options.metrics.inputBytes += chunk.length;
    this.blocker.push(chunk);
    return true;
  }

  /** The channel ended, or started over: finish every session cleanly. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.blocker.end();
    this.chain = this.chain.then(() => {
      for (const session of [...this.sessions]) session.finish();
      this.options.onAbort("ended");
    });
  }

  /**
   * A new receiver. `preface` is what the channel would write first to an
   * ordinary listener, snapshotted by the caller in the same tick as this
   * call, so that the shared blocks from here on follow it exactly.
   */
  join(listener: RelayListener, preface: Buffer[]): RelaySession {
    // Whatever is half-built is pre-join and is in the preface's backlog
    // already: out with it before the join point is marked.
    this.blocker.flush();
    const session = new RelaySession(listener, this, this.pushed, this.options.policy.maxListenerQueueBytes, (gone, reason) => {
      this.sessions.delete(gone);
      this.options.metrics.listeners = this.sessions.size;
      if (reason !== null) {
        this.options.metrics.droppedListeners += 1;
        this.options.metrics.fallbackReason = reason;
      }
      if (this.sessions.size === 0 && !this.closed) this.options.onIdle();
    });
    this.sessions.add(session);
    this.options.metrics.listeners = this.sessions.size;
    // The join point is marked now; the writing starts a tick later, so
    // the caller can put response headers in front of the first byte.
    // No shared block can arrive in between: every block goes through the
    // pool first, and the pool answers on a later tick than this one.
    queueMicrotask(() => void session.start(preface));
    return session;
  }

  private onBlock(block: Buffer): void {
    const start = this.pushed;
    this.pushed += block.length;
    const metrics = this.options.metrics;
    metrics.queueBytes += block.length;
    if (metrics.queueBytes > this.options.policy.maxChannelQueueBytes) {
      this.abort("processing budget exceeded");
      return;
    }
    const entered = this.now();
    this.chain = this.chain.then(async () => {
      if (this.closed && this.sessions.size === 0) return;
      const { mode, payload } = await this.encodeBytes(block);
      metrics.queueBytes -= block.length;
      metrics.latency(this.now() - entered);
      metrics.blocks += 1;
      metrics.representationBytes += payload.length;
      if (mode === "stored") metrics.storedBlocks += 1;
      else metrics.compressedBlocks += 1;
      metrics.activeMode = mode;
      const encoded: EncodedBlock = { start, mode, original: block, digest: sha256(block), payload };
      for (const session of [...this.sessions]) session.deliver(encoded);
    }).catch(() => {
      // A codec that threw something other than a pool refusal is a codec
      // that cannot be trusted with the next block either. Stop the relays;
      // the channel itself is untouched, and a receiver reconnects.
      metrics.codecFailures += 1;
      this.abort("processing budget exceeded");
    });
  }

  /**
   * The bytes in the mode the policy picks: compressed when that pays,
   * stored when it does not or cannot be done in time.
   */
  async encodeBytes(bytes: Buffer): Promise<{ mode: Mode; payload: Buffer }> {
    const policy = this.options.policy;
    const metrics = this.options.metrics;
    const stored = { mode: "stored" as const, payload: bytes };
    if (policy.mode === "off") return stored;
    if (policy.mode === "auto" && this.bypassUntil !== null) {
      if (this.now() < this.bypassUntil) return stored;
      this.bypassUntil = null;
      this.ineligibleRun = 0;
      metrics.bypassed = false;
      metrics.bypassUntil = null;
    }
    const candidates: Mode[] = ["zstd"];
    if (policy.tsAware && tsLayout(bytes)?.packetSize === TS_PACKET) candidates.push("ts-zstd");
    let results: Buffer[];
    try {
      results = await Promise.all(candidates.map((mode) => this.options.pool.run(() => encode(mode, bytes, policy.zstdLevel))));
    } catch (error) {
      metrics.codecFailures += 1;
      metrics.fallbackReason = "processing budget exceeded";
      if (!(error instanceof PoolError) && !(error instanceof RelayError)) throw error;
      return stored;
    }
    let best = 0;
    for (let i = 1; i < results.length; i += 1) if ((results[i] as Buffer).length < (results[best] as Buffer).length) best = i;
    const payload = results[best] as Buffer;
    if (eligible(bytes.length, payload.length, policy)) {
      this.ineligibleRun = 0;
      return { mode: candidates[best] as Mode, payload };
    }
    this.ineligibleRun += 1;
    if (policy.mode === "auto" && this.ineligibleRun >= GIVE_UP_AFTER) {
      this.bypassUntil = this.now() + policy.resampleAfterMs;
      metrics.bypassed = true;
      metrics.bypassUntil = Date.now() + policy.resampleAfterMs;
      metrics.fallbackReason = "already efficiently compressed";
    }
    return stored;
  }

  private abort(reason: FallbackReason): void {
    if (this.closed) return;
    this.closed = true;
    this.options.metrics.fallbackReason = reason;
    for (const session of [...this.sessions]) session.close(reason);
    this.options.onAbort(reason);
  }
}

/** One receiver's view of the relay: its own frame numbers, its own end marker. */
export class RelaySession {
  private seq = 0;
  private total = 0;
  private readonly digest = createHash("sha256");
  private queue: EncodedBlock[] = [];
  private queuedBytes = 0;
  private ready = false;
  closed = false;

  constructor(
    private readonly listener: RelayListener,
    private readonly encoder: RelayEncoder,
    private readonly from: number,
    private readonly maxQueueBytes: number,
    private readonly onClose: (session: RelaySession, reason: FallbackReason | null) => void,
  ) {}

  async start(preface: Buffer[]): Promise<void> {
    if (!this.put(this.encoder.streamHeader)) return;
    for (const piece of preface) {
      for (let at = 0; at < piece.length && !this.closed; at += this.maxBlockBytes) {
        const block = piece.subarray(at, Math.min(piece.length, at + this.maxBlockBytes));
        const { mode, payload } = await this.encoder.encodeBytes(block);
        this.send(mode, block, sha256(block), payload);
      }
    }
    if (this.closed) return;
    this.ready = true;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const block of queued) {
      if (this.closed) return;
      this.send(block.mode, block.original, block.digest, block.payload);
    }
  }

  private get maxBlockBytes(): number {
    return this.encoder.streamHeader.readUInt32BE(12);
  }

  deliver(block: EncodedBlock): void {
    if (this.closed || block.start < this.from) return;
    if (!this.ready) {
      this.queue.push(block);
      this.queuedBytes += block.original.length;
      if (this.queuedBytes > this.maxQueueBytes) this.close("slow listener");
      return;
    }
    this.send(block.mode, block.original, block.digest, block.payload);
  }

  private send(mode: Mode, original: Buffer, digest: Buffer, payload: Buffer): void {
    if (this.closed) return;
    const head = encodeFrameHeader({
      type: FRAME_DATA,
      mode,
      seq: this.seq,
      originalLength: original.length,
      encodedLength: payload.length,
      sha256: digest,
    });
    this.seq += 1;
    this.total += original.length;
    this.digest.update(original);
    if (!this.put(head) || !this.put(payload)) return;
    const behind = this.listener.pending?.() ?? 0;
    if (behind > this.maxQueueBytes) this.close("slow listener");
  }

  /** Clean end: the end frame, then the socket. */
  finish(): void {
    if (this.closed) return;
    this.put(encodeEndFrame(this.seq, this.total, this.digest.digest()));
    this.closed = true;
    try {
      this.listener.end();
    } catch {
      // Gone already.
    }
    this.onClose(this, null);
  }

  close(reason: FallbackReason): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.listener.end();
    } catch {
      // Gone already.
    }
    this.onClose(this, reason);
  }

  /** The receiver hung up. Not a fault of anybody's; nothing is counted against it. */
  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this, null);
  }

  private put(bytes: Buffer): boolean {
    try {
      this.listener.write(bytes);
      return true;
    } catch {
      this.close("slow listener");
      return false;
    }
  }
}

export interface DecoderOptions {
  /** What this decoder can undo. Anything else in a frame is refused. */
  modes: ReadonlySet<Mode>;
  /** The most a stream may negotiate; a header asking for more is refused. */
  maxFrameBytes?: number;
  /** The boundary the caller expects, when it matters. */
  boundary?: Boundary;
  onBytes: (bytes: Buffer) => void | Promise<void>;
}

/**
 * The receiving end: bytes in, original bytes out, every rule checked on
 * the way. Frames are validated before their payload is read, payloads are
 * decoded under the size the frame promised, and the result is checked
 * against the length and the digest before it is handed on. A stream that
 * stops without its end frame is reported as cut off by `end()`.
 */
export class RelayDecoder {
  header: StreamHeader | null = null;
  frames = 0;
  bytes = 0;
  ended = false;
  private buffer: Buffer = Buffer.alloc(0);
  private seq = 0;
  private pending: FrameHeader | null = null;
  private readonly digest = createHash("sha256");
  private busy: Promise<void> = Promise.resolve();

  constructor(private readonly options: DecoderOptions) {}

  /** Feed bytes as they arrive. Serialised, so callers need not await between chunks, though they may. */
  feed(chunk: Buffer): Promise<void> {
    this.busy = this.busy.then(() => this.consume(chunk));
    return this.busy;
  }

  private async consume(chunk: Buffer): Promise<void> {
    if (this.ended) throw new RelayError("AFTER_END", "bytes after the end frame");
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.header === null) {
        if (this.buffer.length < STREAM_HEADER_BYTES) return;
        const header = decodeStreamHeader(this.buffer);
        const cap = this.options.maxFrameBytes ?? Infinity;
        if (header.maxFrameBytes > cap) throw new RelayError("BAD_LIMIT", `stream asks for ${header.maxFrameBytes}-byte frames; this receiver allows ${cap}`);
        if (this.options.boundary && header.boundary !== this.options.boundary) {
          throw new RelayError("BAD_BOUNDARY", `stream is at the ${header.boundary} boundary, not ${this.options.boundary}`);
        }
        this.header = header;
        this.buffer = this.buffer.subarray(STREAM_HEADER_BYTES);
        continue;
      }
      if (this.pending === null) {
        if (this.buffer.length < FRAME_HEADER_BYTES) return;
        this.pending = decodeFrameHeader(this.buffer, {
          maxFrameBytes: this.header.maxFrameBytes,
          modes: this.options.modes,
          expectSeq: this.seq,
        });
        this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES);
        if (this.pending.type === FRAME_END) {
          const total = endFrameTotal(this.pending);
          if (total !== this.bytes) throw new RelayError("LENGTH_MISMATCH", `end frame says ${total} bytes, received ${this.bytes}`);
          if (!this.digest.digest().equals(this.pending.sha256)) throw new RelayError("CHECKSUM_MISMATCH", "the stream digest does not match");
          this.ended = true;
          this.seq += 1;
          if (this.buffer.length > 0) throw new RelayError("AFTER_END", "bytes after the end frame");
          return;
        }
      }
      const frame = this.pending;
      if (this.buffer.length < frame.encodedLength) return;
      const payload = this.buffer.subarray(0, frame.encodedLength);
      this.buffer = Buffer.from(this.buffer.subarray(frame.encodedLength));
      const original = await decode(frame.mode, payload, frame.originalLength);
      if (original.length !== frame.originalLength) throw new RelayError("LENGTH_MISMATCH", `frame ${frame.seq} decoded to ${original.length} bytes, not ${frame.originalLength}`);
      if (!sha256(original).equals(frame.sha256)) throw new RelayError("CHECKSUM_MISMATCH", `frame ${frame.seq} does not match its digest`);
      this.pending = null;
      this.seq += 1;
      this.frames += 1;
      this.bytes += original.length;
      this.digest.update(original);
      await this.options.onBytes(original);
    }
  }

  /** The connection closed. Fine after the end frame; a cut-off otherwise. */
  async end(): Promise<void> {
    await this.busy;
    if (!this.ended) throw new RelayError("TRUNCATED", `the stream stopped after ${this.frames} frames without an end marker`);
  }
}

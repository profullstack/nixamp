/**
 * The codecs, and the pool that keeps them off the event loop.
 *
 * Zstandard and gzip come from node:zlib, which both Node 24 and Bun ship
 * with libzstd built in: no native module to build, nothing to pin beyond
 * the runtime the package already requires. The asynchronous calls run on
 * the runtime's own thread pool, so a block being squeezed never holds a
 * request. What this file adds is the discipline around them: a ceiling on
 * how many run at once, a queue that refuses rather than grows, a deadline
 * on every job, and a limit on how big a decode may get before it is called
 * a bomb.
 */
import { constants, gunzip, gzip, zstdCompress, zstdDecompress } from "node:zlib";
import { type Mode, RelayError } from "./envelope.ts";
import { tsJoin, tsSplit } from "./ts-transform.ts";

export const MIN_ZSTD_LEVEL = 1;
export const MAX_ZSTD_LEVEL = 19;

/** Encode `bytes` in `mode`. Stored is the identity, so it never goes through the pool. */
export function encode(mode: Mode, bytes: Buffer, level = 1): Promise<Buffer> {
  switch (mode) {
    case "stored":
      return Promise.resolve(bytes);
    case "zstd":
      return zstd(bytes, level);
    case "gzip":
      return new Promise((resolve, reject) => gzip(bytes, { level: Math.min(9, Math.max(1, level)) }, (error, out) => (error ? reject(error) : resolve(out))));
    case "ts-zstd": {
      const split = tsSplit(bytes);
      if (split === null) return Promise.reject(new RelayError("BAD_MODE", "not a transport stream: ts-zstd does not apply"));
      return zstd(split, level);
    }
  }
}

/**
 * Decode a payload back to its original bytes. `maxOutputLength` is the
 * decoded size the frame header promised; a payload that wants to be bigger
 * than that is refused before it can be.
 */
export async function decode(mode: Mode, bytes: Buffer, maxOutputLength: number): Promise<Buffer> {
  switch (mode) {
    case "stored":
      return bytes;
    case "zstd":
      return unzstd(bytes, maxOutputLength);
    case "gzip":
      return new Promise((resolve, reject) =>
        gunzip(bytes, { maxOutputLength }, (error, out) => (error ? reject(bomb(error)) : resolve(out))),
      );
    case "ts-zstd": {
      // The split form is a few bytes longer than the original, never shorter.
      const split = await unzstd(bytes, maxOutputLength + 64);
      const joined = tsJoin(split);
      if (joined === null) throw new RelayError("DECODE_FAILED", "ts-zstd payload did not join back into packets");
      return joined;
    }
  }
}

function zstd(bytes: Buffer, level: number): Promise<Buffer> {
  const params = { [constants.ZSTD_c_compressionLevel]: Math.min(MAX_ZSTD_LEVEL, Math.max(MIN_ZSTD_LEVEL, level)) };
  return new Promise((resolve, reject) => zstdCompress(bytes, { params }, (error, out) => (error ? reject(error) : resolve(out))));
}

function unzstd(bytes: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zstdDecompress(bytes, { maxOutputLength }, (error, out) => (error ? reject(bomb(error)) : resolve(out))),
  );
}

/** A decode that failed is a decode that failed; a decode that grew past its limit is named as such. */
function bomb(error: NodeJS.ErrnoException): RelayError {
  if (error.code === "ERR_BUFFER_TOO_LARGE") return new RelayError("FRAME_TOO_LARGE", "payload decodes to more than its frame promised");
  return new RelayError("DECODE_FAILED", error.message);
}

/** What did the work, for a benchmark that has to be reproducible. */
export function toolVersions(): { runtime: string; zstd: string; zlib: string } {
  const versions = process.versions as Record<string, string | undefined>;
  return {
    runtime: versions["bun"] ? `bun ${versions["bun"]}` : `node ${process.version}`,
    zstd: versions["zstd"] ?? "bundled",
    zlib: versions["zlib"] ?? "bundled",
  };
}

export interface PoolOptions {
  /** How many jobs may be in flight at once. */
  concurrency?: number;
  /** How many may wait their turn before a new one is refused. */
  maxQueued?: number;
  /** How long one job may take before it is abandoned. */
  timeoutMs?: number;
}

export interface PoolStats {
  running: number;
  queued: number;
  completed: number;
  refused: number;
  timedOut: number;
  failed: number;
}

/** Thrown for a job the pool would not take, or would not wait for. */
export class PoolError extends Error {
  constructor(readonly code: "BUSY" | "TIMEOUT" | "CANCELLED", message: string) {
    super(message);
    this.name = "PoolError";
  }
}

/**
 * A bounded queue in front of the codecs.
 *
 * The codecs themselves already run on other threads; what would hurt is a
 * thousand blocks queued behind a slow one, each holding a quarter of a
 * megabyte. So there is a ceiling on the queue, and a job past the deadline
 * is dropped by whoever asked for it -- the thread finishes and its result
 * is thrown away, which for a block of at most a quarter of a megabyte is a
 * few milliseconds wasted, not a leak.
 */
export class Pool {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly counts = { completed: 0, refused: 0, timedOut: 0, failed: 0 };

  constructor(options: PoolOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxQueued = Math.max(0, options.maxQueued ?? 64);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 2000);
  }

  get stats(): PoolStats {
    return { running: this.running, queued: this.waiting.length, ...this.counts };
  }

  async run<T>(job: () => Promise<T>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (options.signal?.aborted) throw new PoolError("CANCELLED", "cancelled before it started");
    await this.acquire(options.signal);
    const deadline = options.timeoutMs ?? this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      const result = await Promise.race([
        job(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PoolError("TIMEOUT", `took longer than ${deadline}ms`)), deadline);
          timer.unref?.();
          if (options.signal) {
            onAbort = () => reject(new PoolError("CANCELLED", "cancelled"));
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
      this.counts.completed += 1;
      return result;
    } catch (error) {
      if (error instanceof PoolError && error.code === "TIMEOUT") this.counts.timedOut += 1;
      else if (!(error instanceof PoolError)) this.counts.failed += 1;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);
      this.release();
    }
  }

  /** Take a slot now, or wait for one to be handed over by `release`. */
  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return;
    }
    if (this.waiting.length >= this.maxQueued) {
      this.counts.refused += 1;
      throw new PoolError("BUSY", "the codec pool is full");
    }
    await new Promise<void>((next) => this.waiting.push(next));
    // Woken: the finishing job passed its slot to us without touching the
    // count. If we no longer want it, pass it on the same way.
    if (signal?.aborted) {
      this.release();
      throw new PoolError("CANCELLED", "cancelled while queued");
    }
  }

  /** Give the slot to the next in line, or back to the pool if nobody is waiting. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.running -= 1;
  }
}

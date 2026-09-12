/**
 * A file's compressed representation, made once and kept.
 *
 * A film on disk is asked for the same way every time, so its envelope is
 * built once, whole, and served as a file thereafter. The original is never
 * touched: seeking, ranges and every ordinary route keep using it, and the
 * representation is a second file beside it in the cache directory, named
 * by what it was made from. It is published by rename, so a request never
 * reads half of one; it is checked against the file's size and mtime on
 * every lookup, and against the file's own digest at the end of the build,
 * so a file rewritten while it was being read is not served as itself;
 * and the cache as a whole has a byte budget, the least recently served
 * going first.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encode, Pool } from "./codec.ts";
import { encodeEndFrame, encodeFrameHeader, encodeStreamHeader, FRAME_DATA, FRAME_HEADER_BYTES, type Mode, sha256, STREAM_HEADER_BYTES } from "./envelope.ts";
import { eligible, type LosslessPolicy } from "./policy.ts";
import { TS_PACKET, tsLayout } from "./ts-transform.ts";

export const REPRESENTATION_SUFFIX = ".nxs";

export interface StaticEntry {
  file: string;
  size: number;
  mtimeMs: number;
  /** Of the original file, whole. */
  sha256: string;
  /** The policy variant it was built under. Another variant is another entry. */
  variant: string;
  /** How big the representation is, headers included. */
  bytes: number;
  blocks: number;
  compressedBlocks: number;
  builtAt: number;
  lastUsedAt: number;
}

export interface StaticCacheOptions {
  /** Total bytes the cache may hold. */
  maxBytes?: number;
  pool?: Pool;
}

export type Prepared = { ok: true; entry: StaticEntry; path: string } | { ok: false; reason: string };

export class StaticCache {
  private readonly building = new Map<string, Promise<Prepared>>();
  private readonly pool: Pool;
  private readonly maxBytes: number;

  constructor(readonly dir: string, options: StaticCacheOptions = {}) {
    this.pool = options.pool ?? new Pool({ concurrency: 2, maxQueued: 8, timeoutMs: 10_000 });
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    mkdirSync(dir, { recursive: true });
  }

  /** The cache file name for a file under a variant: from its path, never its content, so it can be found before the content is read. */
  private nameFor(file: string, variant: string): string {
    return createHash("sha256").update(`${resolve(file)}\0${variant}`).digest("hex").slice(0, 32);
  }

  /**
   * The representation of `file`, if one is there and still describes the
   * file on disk. Null otherwise -- and a stale one is removed, not kept
   * for a later lookup to be fooled by.
   */
  lookup(file: string, variant: string): { entry: StaticEntry; path: string } | null {
    const name = this.nameFor(file, variant);
    const meta = join(this.dir, `${name}.json`);
    const path = join(this.dir, `${name}${REPRESENTATION_SUFFIX}`);
    let entry: StaticEntry;
    try {
      entry = JSON.parse(readFileSync(meta, "utf8")) as StaticEntry;
    } catch {
      return null;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      this.drop(name);
      return null;
    }
    if (stat.size !== entry.size || Math.floor(stat.mtimeMs) !== Math.floor(entry.mtimeMs)) {
      this.drop(name);
      return null;
    }
    try {
      if (statSync(path).size !== entry.bytes) {
        this.drop(name);
        return null;
      }
    } catch {
      this.drop(name);
      return null;
    }
    entry.lastUsedAt = Date.now();
    try {
      writeFileSync(meta, JSON.stringify(entry));
    } catch {
      // The timestamp is for eviction order; losing it costs nothing now.
    }
    return { entry, path };
  }

  /**
   * Build the representation, or return the one being built. Two requests
   * for the same file do one read.
   */
  prepare(file: string, policy: LosslessPolicy, variant: string): Promise<Prepared> {
    const found = this.lookup(file, variant);
    if (found) return Promise.resolve({ ok: true, ...found });
    const name = this.nameFor(file, variant);
    const building = this.building.get(name);
    if (building) return building;
    const job = this.build(file, policy, variant, name).finally(() => this.building.delete(name));
    this.building.set(name, job);
    return job;
  }

  private async build(file: string, policy: LosslessPolicy, variant: string, name: string): Promise<Prepared> {
    let before;
    try {
      before = statSync(file);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    if (!before.isFile()) return { ok: false, reason: "not a file" };
    const path = join(this.dir, `${name}${REPRESENTATION_SUFFIX}`);
    const tmp = join(this.dir, `${name}.${process.pid}.building`);
    const out = createWriteStream(tmp);
    let broken: Error | null = null;
    out.on("error", (error) => {
      broken = error;
    });
    const digest = createHash("sha256");
    let total = 0;
    let bytes = 0;
    let blocks = 0;
    let compressedBlocks = 0;
    let seq = 0;
    const put = (chunk: Buffer): Promise<void> =>
      new Promise((done, fail) => {
        if (broken) {
          fail(broken);
          return;
        }
        bytes += chunk.length;
        if (out.write(chunk)) done();
        else out.once("drain", done);
      });
    try {
      await put(encodeStreamHeader({ version: 1, boundary: "source", generation: 1, maxFrameBytes: policy.maxBlockBytes }));
      const reader = createReadStream(file, { highWaterMark: policy.maxBlockBytes });
      for await (const piece of reader) {
        const block = piece as Buffer;
        digest.update(block);
        total += block.length;
        const { mode, payload } = await this.encodeBlock(block, policy);
        blocks += 1;
        if (mode !== "stored") compressedBlocks += 1;
        await put(encodeFrameHeader({ type: FRAME_DATA, mode, seq, originalLength: block.length, encodedLength: payload.length, sha256: sha256(block) }));
        await put(payload);
        seq += 1;
      }
      const whole = digest.digest();
      await put(encodeEndFrame(seq, total, whole));
      await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
      // The file as it is now must be the file that was read. A file that
      // changed underneath is not the file this envelope describes.
      const after = statSync(file);
      if (after.size !== before.size || Math.floor(after.mtimeMs) !== Math.floor(before.mtimeMs) || total !== before.size) {
        unlinkSync(tmp);
        return { ok: false, reason: "the file changed while it was being read" };
      }
      const entry: StaticEntry = {
        file: resolve(file),
        size: before.size,
        mtimeMs: before.mtimeMs,
        sha256: whole.toString("hex"),
        variant,
        bytes,
        blocks,
        compressedBlocks,
        builtAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      this.makeRoom(bytes);
      writeFileSync(join(this.dir, `${name}.json.tmp`), JSON.stringify(entry));
      renameSync(tmp, path);
      renameSync(join(this.dir, `${name}.json.tmp`), join(this.dir, `${name}.json`));
      return { ok: true, entry, path };
    } catch (error) {
      try {
        out.destroy();
        unlinkSync(tmp);
      } catch {
        // Nothing to clean, or already gone.
      }
      return { ok: false, reason: (error as Error).message };
    }
  }

  private async encodeBlock(block: Buffer, policy: LosslessPolicy): Promise<{ mode: Mode; payload: Buffer }> {
    if (policy.mode === "off") return { mode: "stored", payload: block };
    const candidates: Mode[] = ["zstd"];
    if (policy.tsAware && tsLayout(block)?.packetSize === TS_PACKET) candidates.push("ts-zstd");
    const results = await Promise.all(candidates.map((mode) => this.pool.run(() => encode(mode, block, policy.zstdLevel), { timeoutMs: 10_000 })));
    let best = 0;
    for (let i = 1; i < results.length; i += 1) if ((results[i] as Buffer).length < (results[best] as Buffer).length) best = i;
    const payload = results[best] as Buffer;
    return eligible(block.length, payload.length, policy) ? { mode: candidates[best] as Mode, payload } : { mode: "stored", payload: block };
  }

  /** Every entry on disk, oldest use first. */
  entries(): StaticEntry[] {
    const list: StaticEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        list.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as StaticEntry);
      } catch {
        // Half-written or foreign; not ours to count.
      }
    }
    return list.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  get totalBytes(): number {
    return this.entries().reduce((sum, entry) => sum + entry.bytes, 0);
  }

  /** Drop the least recently served until `incoming` more bytes fit. */
  private makeRoom(incoming: number): void {
    let total = this.totalBytes;
    for (const entry of this.entries()) {
      if (total + incoming <= this.maxBytes) return;
      this.drop(this.nameFor(entry.file, entry.variant));
      total -= entry.bytes;
    }
  }

  remove(file: string, variant: string): void {
    this.drop(this.nameFor(file, variant));
  }

  private drop(name: string): void {
    for (const suffix of [REPRESENTATION_SUFFIX, ".json"]) {
      try {
        rmSync(join(this.dir, `${name}${suffix}`), { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  /** What the envelope adds to a file of `size` bytes at worst: every block stored. */
  static worstCaseBytes(size: number, blockBytes: number): number {
    return STREAM_HEADER_BYTES + size + FRAME_HEADER_BYTES * (Math.ceil(size / blockBytes) + 1);
  }
}

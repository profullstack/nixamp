/**
 * Bytes into blocks, without ever waiting for the stream's convenience.
 *
 * A block is flushed when it is full or when its first byte has been held
 * for `maxHoldMs`, whichever is sooner. It never waits for a packet
 * boundary that has not come, and a chunk bigger than a block is sliced
 * rather than refused. Alignment, when asked for, only decides where a full
 * block is cut; a timed flush sends whatever is there, and the transform
 * that wanted the alignment copes with a ragged edge.
 */
export interface BlockerOptions {
  maxBlockBytes: number;
  maxHoldMs: number;
  /** Cut full blocks at a multiple of this many bytes. 0 for wherever. */
  align?: number;
  onBlock: (block: Buffer) => void;
  /** Injected by tests. */
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
}

const realTimer = (fn: () => void, ms: number): { clear(): void } => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
};

export class Blocker {
  private pieces: Buffer[] = [];
  private held = 0;
  private timer: { clear(): void } | null = null;
  private ended = false;

  constructor(private readonly options: BlockerOptions) {}

  get pendingBytes(): number {
    return this.held;
  }

  push(chunk: Buffer): void {
    if (this.ended || chunk.length === 0) return;
    const { maxBlockBytes, align = 0 } = this.options;
    let offset = 0;
    while (offset < chunk.length) {
      const room = maxBlockBytes - this.held;
      const take = Math.min(room, chunk.length - offset);
      this.pieces.push(chunk.subarray(offset, offset + take));
      this.held += take;
      offset += take;
      if (this.held >= maxBlockBytes) {
        // Cut at the alignment, carrying the remainder into the next block.
        // Only a full block is cut this way: a whole block with no boundary
        // in it is sent as it is, or nothing would ever leave.
        const cut = align > 1 && this.held - (this.held % align) > 0 ? this.held - (this.held % align) : this.held;
        this.flushBytes(cut);
      } else if (this.timer === null) {
        // The clock starts when the first byte enters an empty block.
        this.timer = (this.options.setTimer ?? realTimer)(() => {
          this.timer = null;
          this.flush();
        }, this.options.maxHoldMs);
      }
    }
  }

  /** Send whatever is held, now. */
  flush(): void {
    this.flushBytes(this.held);
  }

  end(): void {
    this.flush();
    this.ended = true;
  }

  private flushBytes(count: number): void {
    if (this.timer) this.timer.clear();
    this.timer = null;
    if (count <= 0 || this.held === 0) return;
    const whole = this.pieces.length === 1 ? (this.pieces[0] as Buffer) : Buffer.concat(this.pieces, this.held);
    const block = whole.subarray(0, count);
    const rest = whole.subarray(count);
    this.pieces = rest.length > 0 ? [rest] : [];
    this.held = rest.length;
    this.options.onBlock(block);
    // A remainder is a new block whose first byte arrived just now.
    if (this.held > 0 && this.timer === null && !this.ended) {
      this.timer = (this.options.setTimer ?? realTimer)(() => {
        this.timer = null;
        this.flush();
      }, this.options.maxHoldMs);
    }
  }
}

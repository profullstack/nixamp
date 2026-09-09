/**
 * Splitting a fragmented MP4 into the pieces a late arrival needs.
 *
 * MP3 can be joined halfway through because every frame says what it is: a
 * player finds the next frame boundary and carries on. Fragmented MP4 cannot.
 * It opens with an `ftyp` and a `moov` that describe the tracks -- how many,
 * which codecs, what timescale -- and everything after that is a `moof` and an
 * `mdat` that mean nothing without them. Hand somebody the middle of that
 * stream and their browser has no idea what it is holding, which is a black
 * panel and no error.
 *
 * So the opening boxes are kept, and a listener who arrives an hour late is
 * given them before the live bytes. Fragments written with `frag_keyframe`
 * each begin at a keyframe, so the picture starts at the first one rather than
 * with a screen of blocks catching up.
 *
 * This also means listeners are only ever written whole boxes. A chunk from a
 * pipe ends wherever the pipe felt like ending it, and half a `moof` is not
 * something to send anybody.
 */

/** The header of an MP4 box: four bytes of length, four of name. */
const HEADER = 8;
/** A length of 1 means the real one is the eight bytes that follow. */
const BIG = 16;

export interface Box {
  type: string;
  bytes: Buffer;
}

/**
 * The first whole box in a buffer, or null when it has not all arrived.
 *
 * Null is also the answer for anything malformed, because the difference does
 * not matter to a caller who can only wait or give up, and guessing at a
 * broken length walks off the end of the stream.
 */
export function firstBox(buffer: Buffer): { box: Box; rest: Buffer } | null {
  if (buffer.length < HEADER) return null;
  const stated = buffer.readUInt32BE(0);
  const type = buffer.toString("latin1", 4, HEADER);
  // A name is four printable characters. Anything else means we are not
  // looking at a box header, and no length read from here can be trusted.
  if (!/^[\x20-\x7e]{4}$/.test(type)) return null;

  let size = stated;
  let header = HEADER;
  if (stated === 1) {
    if (buffer.length < BIG) return null;
    const large = buffer.readBigUInt64BE(HEADER);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = BIG;
  }
  // Zero means "to the end of the file", which a live stream does not have.
  if (size < header) return null;
  if (buffer.length < size) return null;
  return { box: { type, bytes: buffer.subarray(0, size) }, rest: buffer.subarray(size) };
}

/** The boxes that describe the stream rather than carry it. */
export function isOpening(type: string): boolean {
  return type === "ftyp" || type === "moov";
}

/**
 * A fragmented MP4 arriving in pieces, handed back a box at a time.
 *
 * Keeps the opening boxes so they can be replayed to whoever turns up later.
 * If the bytes turn out not to be an MP4 at all -- a source that failed, a
 * format nobody expected -- it stops trying to parse and passes them through,
 * on the grounds that a stream somebody might be able to play beats a stream
 * nobody can.
 */
export class Fragments {
  private held: Buffer = Buffer.alloc(0);
  private opening: Buffer[] = [];
  private confused = false;

  /** The `ftyp` and `moov` seen so far, ready to send to a new listener. */
  get header(): Buffer {
    return this.opening.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.opening);
  }

  /** Whether enough has arrived to describe the stream to somebody new. */
  get ready(): boolean {
    return this.opening.length > 0;
  }

  /** Feed bytes in; get whole boxes out, in order. */
  push(chunk: Buffer): Buffer[] {
    if (this.confused) return [chunk];
    this.held = this.held.length === 0 ? chunk : Buffer.concat([this.held, chunk]);

    const out: Buffer[] = [];
    for (;;) {
      const next = firstBox(this.held);
      if (!next) break;
      this.held = next.rest;
      if (isOpening(next.box.type)) this.opening.push(next.box.bytes);
      out.push(next.box.bytes);
    }

    // Nothing parses and the buffer keeps growing: this is not an MP4. Let it
    // through rather than swallowing a stream into memory for ever.
    if (this.opening.length === 0 && this.held.length > 4 * 1024 * 1024) {
      this.confused = true;
      const everything = this.held;
      this.held = Buffer.alloc(0);
      return [everything];
    }
    return out;
  }
}

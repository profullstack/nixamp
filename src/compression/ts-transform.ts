/**
 * The experimental transport-stream transform: headers here, payloads there.
 *
 * An MPEG transport stream is 188-byte packets, each starting 0x47, each
 * with a four-byte header whose fields (PID, continuity counter, flags)
 * change a little from one packet to the next, followed by payload that is
 * already-encoded video and does not compress. Interleaved, the headers are
 * lost in the noise; grouped together they are a very regular sequence and
 * an ordinary compressor does well on them. That is the whole idea. It is
 * a reversible rearrangement in front of Zstandard, not a new compressor,
 * and it is selected only when the complete output is smaller than not
 * doing it.
 *
 * Nothing is interpreted beyond what is needed to know where a header
 * ends: the sync byte, the adaptation flags and the adaptation length. A
 * null packet keeps its bytes. A packet whose adaptation length overruns
 * is kept whole in the header section. Bytes before the first aligned
 * packet and after the last one are kept as they are. `tsJoin(tsSplit(x))`
 * is `x` for every x, or `tsSplit` says no.
 */
export const TS_PACKET = 188;
/** Layouts we recognise and leave alone: timestamped and forward-error-corrected. */
export const TS_PACKET_SIZES = [188, 192, 204] as const;
export const SYNC = 0x47;

const VERSION = 1;
const HEAD_BYTES = 1 + 4 + 4 + 4;
/** How many packets must line up before the layout is believed. */
const CONFIDENCE = 4;

export interface TsLayout {
  packetSize: 188 | 192 | 204;
  /** Where the first full packet starts. */
  offset: number;
}

/**
 * Which packet size, if any, `bytes` is laid out in, by finding a stride at
 * which the sync byte repeats. A 192-byte packet carries a four-byte
 * timestamp before the sync, which is why the offset may be four.
 */
export function tsLayout(bytes: Uint8Array, minPackets = CONFIDENCE): TsLayout | null {
  for (const size of TS_PACKET_SIZES) {
    const skip = size === 192 ? 4 : 0;
    for (let offset = 0; offset < size && offset + size * minPackets <= bytes.length; offset += 1) {
      let ok = true;
      for (let k = 0; k < minPackets; k += 1) {
        if (bytes[offset + skip + k * size] !== SYNC) {
          ok = false;
          break;
        }
      }
      if (ok) return { packetSize: size, offset };
    }
  }
  return null;
}

/** How long the header part of one 188-byte packet is: 4, plus the adaptation field. */
function headerLength(packet: Uint8Array): number {
  const afc = ((packet[3] as number) >> 4) & 0x3;
  if (afc === 0b10 || afc === 0b11) {
    const length = packet[4] as number;
    // Overrun: the whole packet is treated as header and kept intact.
    if (5 + length > TS_PACKET) return TS_PACKET;
    return 5 + length;
  }
  return 4;
}

/**
 * Split into [head][headers...][payloads...][tail]. Null when `bytes` is
 * not a run of aligned 188-byte packets, which is the caller's cue to use
 * the plain codec. 192- and 204-byte layouts are detected and refused here
 * rather than handled: they would need their own tested join.
 */
export function tsSplit(bytes: Buffer): Buffer | null {
  const layout = tsLayout(bytes);
  if (layout === null || layout.packetSize !== TS_PACKET) return null;
  const start = layout.offset;
  // The aligned run: as many whole packets as keep syncing. The first
  // packet that does not ends the run, and the rest is tail.
  let count = 0;
  while (start + (count + 1) * TS_PACKET <= bytes.length && bytes[start + count * TS_PACKET] === SYNC) count += 1;
  const end = start + count * TS_PACKET;
  const headers: Buffer[] = [];
  const payloads: Buffer[] = [];
  let headerBytes = 0;
  for (let i = 0; i < count; i += 1) {
    const packet = bytes.subarray(start + i * TS_PACKET, start + (i + 1) * TS_PACKET);
    const hl = headerLength(packet);
    headers.push(packet.subarray(0, hl));
    headerBytes += hl;
    if (hl < TS_PACKET) payloads.push(packet.subarray(hl));
  }
  const head = Buffer.alloc(HEAD_BYTES);
  head.writeUInt8(VERSION, 0);
  head.writeUInt32BE(start, 1);
  head.writeUInt32BE(count, 5);
  head.writeUInt32BE(bytes.length - end, 9);
  return Buffer.concat([
    head,
    bytes.subarray(0, start),
    Buffer.concat(headers, headerBytes),
    Buffer.concat(payloads, count * TS_PACKET - headerBytes),
    bytes.subarray(end),
  ]);
}

/** The inverse. Null for anything that is not the output of `tsSplit`. */
export function tsJoin(split: Buffer): Buffer | null {
  if (split.length < HEAD_BYTES || split.readUInt8(0) !== VERSION) return null;
  const headLen = split.readUInt32BE(1);
  const count = split.readUInt32BE(5);
  const tailLen = split.readUInt32BE(9);
  const total = headLen + count * TS_PACKET + tailLen;
  if (count > 0x00ff_ffff || split.length < HEAD_BYTES + headLen + tailLen) return null;
  const out = Buffer.alloc(total);
  split.copy(out, 0, HEAD_BYTES, HEAD_BYTES + headLen);
  // Headers are variable length, so they are walked exactly as they were
  // written: read one, learn its length from its own bytes, move on. The
  // payloads follow all the headers, so their start is only known after
  // the walk -- hence two passes.
  let cursor = HEAD_BYTES + headLen;
  const lengths: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (cursor + 4 > split.length) return null;
    const hl = headerLength(split.subarray(cursor, cursor + TS_PACKET));
    if (cursor + hl > split.length) return null;
    lengths.push(hl);
    cursor += hl;
  }
  let payloadCursor = cursor;
  let headerCursor = HEAD_BYTES + headLen;
  for (let i = 0; i < count; i += 1) {
    const hl = lengths[i] as number;
    const at = headLen + i * TS_PACKET;
    split.copy(out, at, headerCursor, headerCursor + hl);
    headerCursor += hl;
    const pl = TS_PACKET - hl;
    if (payloadCursor + pl > split.length) return null;
    split.copy(out, at + hl, payloadCursor, payloadCursor + pl);
    payloadCursor += pl;
  }
  if (payloadCursor + tailLen !== split.length) return null;
  split.copy(out, headLen + count * TS_PACKET, payloadCursor, payloadCursor + tailLen);
  return out;
}

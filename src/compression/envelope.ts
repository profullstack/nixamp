/**
 * The wire shape of a compressed relay: what one nixamp sends another.
 *
 * Not a .ts file and not an HTTP body somebody's proxy might gunzip: a
 * stream of framed blocks, each one independently decodable, each one
 * carrying the length and the SHA-256 of the bytes it stands for, ending in
 * a marker that says the stream finished rather than dropped. The layout is
 * specified byte by byte in docs/stream-compression.md; this file is that
 * document as code, and the test vectors there are checked against it.
 *
 * Everything is big-endian. Every length is checked against the negotiated
 * limit before a byte is allocated for it, so a hostile header cannot ask
 * for a gigabyte.
 */
import { createHash } from "node:crypto";

export const MAGIC = "NXS1";
export const ENVELOPE_VERSION = 1;
export const MEDIA_TYPE = "application/vnd.nixamp.stream";

export const STREAM_HEADER_BYTES = 16;
export const FRAME_HEADER_BYTES = 48;

/** Where the bytes were captured: before ffmpeg, or after the channel pipeline. */
export type Boundary = "source" | "channel";
const BOUNDARY_CODE: Record<Boundary, number> = { source: 0, channel: 1 };

/** How one block's payload was encoded. `stored` is the bytes as they were. */
export type Mode = "stored" | "zstd" | "gzip" | "ts-zstd";
export const MODE_CODE: Record<Mode, number> = { stored: 0, zstd: 1, gzip: 2, "ts-zstd": 3 };
export const MODES: readonly Mode[] = ["stored", "zstd", "gzip", "ts-zstd"];

export const FRAME_DATA = 1;
export const FRAME_END = 2;

/** The decoded size one frame may claim, unless negotiated otherwise. */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
/** The most a stream header may negotiate, whatever it asks for. */
export const CEILING_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * How much bigger than its original an encoded payload may be. A codec that
 * cannot beat stored is stored, so anything past a small fixed allowance is
 * either a bug or an attack.
 */
export const EXPANSION_ALLOWANCE = 1024;

export interface StreamHeader {
  version: number;
  boundary: Boundary;
  /** Which run of the source this is; changes on every restart. */
  generation: number;
  /** The decoded-size limit every frame in this stream honours. */
  maxFrameBytes: number;
}

export interface FrameHeader {
  type: typeof FRAME_DATA | typeof FRAME_END;
  mode: Mode;
  seq: number;
  originalLength: number;
  encodedLength: number;
  /** Of the original bytes for a data frame; of the whole generation for the end. */
  sha256: Buffer;
}

export type RelayErrorCode =
  | "BAD_MAGIC"
  | "BAD_VERSION"
  | "BAD_BOUNDARY"
  | "BAD_LIMIT"
  | "BAD_FRAME_TYPE"
  | "BAD_MODE"
  | "UNSUPPORTED_MODE"
  | "BAD_SEQUENCE"
  | "FRAME_TOO_LARGE"
  | "EXPANSION_BUDGET"
  | "CHECKSUM_MISMATCH"
  | "LENGTH_MISMATCH"
  | "DECODE_FAILED"
  | "AFTER_END"
  | "TRUNCATED";

/** A stream that broke one of the rules, and which rule. Never silently. */
export class RelayError extends Error {
  constructor(readonly code: RelayErrorCode, message: string) {
    super(message);
    this.name = "RelayError";
  }
}

export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function encodeStreamHeader(header: StreamHeader): Buffer {
  if (header.version !== ENVELOPE_VERSION) throw new RelayError("BAD_VERSION", `cannot write version ${header.version}`);
  if (!(header.boundary in BOUNDARY_CODE)) throw new RelayError("BAD_BOUNDARY", `no such boundary: ${header.boundary}`);
  if (!Number.isInteger(header.generation) || header.generation < 0 || header.generation > 0xffff_ffff) {
    throw new RelayError("BAD_LIMIT", "generation must fit in 32 bits");
  }
  if (!Number.isInteger(header.maxFrameBytes) || header.maxFrameBytes < 1 || header.maxFrameBytes > CEILING_FRAME_BYTES) {
    throw new RelayError("BAD_LIMIT", `maxFrameBytes must be 1..${CEILING_FRAME_BYTES}`);
  }
  const out = Buffer.alloc(STREAM_HEADER_BYTES);
  out.write(MAGIC, 0, 4, "latin1");
  out.writeUInt8(header.version, 4);
  out.writeUInt8(0, 5); // flags, none defined
  out.writeUInt8(BOUNDARY_CODE[header.boundary], 6);
  out.writeUInt8(0, 7); // reserved
  out.writeUInt32BE(header.generation, 8);
  out.writeUInt32BE(header.maxFrameBytes, 12);
  return out;
}

/** Read a stream header from the front of `bytes`. Throws on anything off. */
export function decodeStreamHeader(bytes: Buffer): StreamHeader {
  if (bytes.length < STREAM_HEADER_BYTES) throw new RelayError("TRUNCATED", "stream header is short");
  if (bytes.toString("latin1", 0, 4) !== MAGIC) throw new RelayError("BAD_MAGIC", "not a nixamp relay stream");
  const version = bytes.readUInt8(4);
  if (version !== ENVELOPE_VERSION) throw new RelayError("BAD_VERSION", `envelope version ${version} is not understood`);
  const boundaryCode = bytes.readUInt8(6);
  const boundary = (Object.keys(BOUNDARY_CODE) as Boundary[]).find((b) => BOUNDARY_CODE[b] === boundaryCode);
  if (!boundary) throw new RelayError("BAD_BOUNDARY", `boundary code ${boundaryCode} is not understood`);
  const generation = bytes.readUInt32BE(8);
  const maxFrameBytes = bytes.readUInt32BE(12);
  if (maxFrameBytes < 1 || maxFrameBytes > CEILING_FRAME_BYTES) {
    throw new RelayError("BAD_LIMIT", `maxFrameBytes ${maxFrameBytes} is outside 1..${CEILING_FRAME_BYTES}`);
  }
  return { version, boundary, generation, maxFrameBytes };
}

export function encodeFrameHeader(header: FrameHeader): Buffer {
  if (header.type !== FRAME_DATA && header.type !== FRAME_END) throw new RelayError("BAD_FRAME_TYPE", `no such frame type ${header.type}`);
  if (!(header.mode in MODE_CODE)) throw new RelayError("BAD_MODE", `no such mode: ${header.mode}`);
  if (header.sha256.length !== 32) throw new RelayError("CHECKSUM_MISMATCH", "sha256 must be 32 bytes");
  for (const [name, value] of [["seq", header.seq], ["originalLength", header.originalLength], ["encodedLength", header.encodedLength]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RelayError("BAD_LIMIT", `${name} must fit in 32 bits`);
  }
  const out = Buffer.alloc(FRAME_HEADER_BYTES);
  out.writeUInt8(header.type, 0);
  out.writeUInt8(MODE_CODE[header.mode], 1);
  out.writeUInt16BE(0, 2); // reserved
  out.writeUInt32BE(header.seq, 4);
  out.writeUInt32BE(header.originalLength, 8);
  out.writeUInt32BE(header.encodedLength, 12);
  header.sha256.copy(out, 16);
  return out;
}

/** A data frame: header then payload, as one buffer. */
export function encodeDataFrame(seq: number, mode: Mode, original: Buffer, encoded: Buffer): Buffer {
  return Buffer.concat([dataFrameHeader(seq, mode, original, encoded.length), encoded]);
}

/** Just the header of a data frame, for a payload that is shared between listeners. */
export function dataFrameHeader(seq: number, mode: Mode, original: Buffer, encodedLength: number, digest?: Buffer): Buffer {
  return encodeFrameHeader({
    type: FRAME_DATA,
    mode,
    seq,
    originalLength: original.length,
    encodedLength,
    sha256: digest ?? sha256(original),
  });
}

/**
 * The end marker: no payload, the generation's total original byte count in
 * the two length fields (high word, low word) and the SHA-256 of every
 * original byte in order. A stream that stops without one was cut off.
 */
export function encodeEndFrame(seq: number, totalOriginalBytes: number, digest: Buffer): Buffer {
  if (!Number.isSafeInteger(totalOriginalBytes) || totalOriginalBytes < 0) throw new RelayError("BAD_LIMIT", "total must be a non-negative integer");
  return encodeFrameHeader({
    type: FRAME_END,
    mode: "stored",
    seq,
    originalLength: Math.floor(totalOriginalBytes / 0x1_0000_0000),
    encodedLength: totalOriginalBytes % 0x1_0000_0000,
    sha256: digest,
  });
}

/** The total an end frame carries, from its two halves. */
export function endFrameTotal(header: FrameHeader): number {
  return header.originalLength * 0x1_0000_0000 + header.encodedLength;
}

export interface FrameLimits {
  maxFrameBytes: number;
  /** Modes this decoder can undo. A frame in any other mode is refused. */
  modes: ReadonlySet<Mode>;
  /** The sequence number expected next. */
  expectSeq: number;
}

/**
 * Read a frame header, checking every field against the limits before the
 * caller allocates anything for the payload.
 */
export function decodeFrameHeader(bytes: Buffer, limits: FrameLimits): FrameHeader {
  if (bytes.length < FRAME_HEADER_BYTES) throw new RelayError("TRUNCATED", "frame header is short");
  const type = bytes.readUInt8(0);
  if (type !== FRAME_DATA && type !== FRAME_END) throw new RelayError("BAD_FRAME_TYPE", `frame type ${type} is not understood`);
  const modeCode = bytes.readUInt8(1);
  const mode = MODES.find((m) => MODE_CODE[m] === modeCode);
  if (!mode) throw new RelayError("BAD_MODE", `mode code ${modeCode} is not understood`);
  const seq = bytes.readUInt32BE(4);
  if (seq !== limits.expectSeq) throw new RelayError("BAD_SEQUENCE", `expected frame ${limits.expectSeq}, got ${seq}`);
  const originalLength = bytes.readUInt32BE(8);
  const encodedLength = bytes.readUInt32BE(12);
  const sha = Buffer.from(bytes.subarray(16, 48));
  if (type === FRAME_END) {
    return { type: FRAME_END, mode: "stored", seq, originalLength, encodedLength, sha256: sha };
  }
  if (!limits.modes.has(mode)) throw new RelayError("UNSUPPORTED_MODE", `this decoder cannot undo ${mode}`);
  if (originalLength > limits.maxFrameBytes) {
    throw new RelayError("FRAME_TOO_LARGE", `frame claims ${originalLength} original bytes, limit ${limits.maxFrameBytes}`);
  }
  if (encodedLength > originalLength + EXPANSION_ALLOWANCE) {
    throw new RelayError("EXPANSION_BUDGET", `frame carries ${encodedLength} bytes for ${originalLength} original`);
  }
  if (mode === "stored" && encodedLength !== originalLength) {
    throw new RelayError("LENGTH_MISMATCH", "a stored frame must carry exactly its original bytes");
  }
  return { type: FRAME_DATA, mode, seq, originalLength, encodedLength, sha256: sha };
}

/** The codec names a peer lists in a negotiation header, kept to the ones we know. */
export function parseModes(header: string | undefined | null): Set<Mode> {
  const out = new Set<Mode>();
  for (const raw of (header ?? "").split(",")) {
    const name = raw.trim().toLowerCase();
    if ((MODES as readonly string[]).includes(name)) out.add(name as Mode);
  }
  return out;
}

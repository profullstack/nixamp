/**
 * Silence in place of a break, for one listener of a station: the last resort.
 *
 * A listener with a listen pass (listen-pass.ts) skips breaks out of a head
 * start of music (Channel.listenWithoutBreaks). Only when that is spent is a
 * break replaced, by MP3 silence lasting as long as the bytes it stands in
 * for, rather than a gap that stalls the player. Audio only; a
 * fragmented MP4 cannot have fragments swapped, so a TV station's breaks are
 * everybody's.
 *
 * The silent frame is MPEG-1 Layer III at 48 kHz (the rate every station is
 * resampled to) with empty side information: four header bytes and zeros,
 * which every decoder plays as nothing.
 */

const SAMPLE_RATE = 48_000;
const FRAME_SECONDS = 1152 / SAMPLE_RATE;
/** MPEG-1 Layer III bitrate index by kbps. */
const BITRATE_INDEX: Record<number, number> = {
  32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14,
};

/** One silent frame at this bitrate (128 kbps when the bitrate is not a Layer III one). */
export function silentFrame(kbps: number): Buffer {
  const rate = BITRATE_INDEX[kbps] ? kbps : 128;
  const frame = Buffer.alloc((144 * rate * 1000) / SAMPLE_RATE);
  // Sync, MPEG-1, Layer III, no CRC; bitrate, 48 kHz (01), no padding; stereo.
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = (BITRATE_INDEX[rate]! << 4) | (0b01 << 2);
  frame[3] = 0x00;
  return frame;
}

export interface Writer {
  write: (chunk: Buffer) => boolean;
  end: () => void;
  pending?: () => number;
}

/**
 * A writer that sends silence instead of whatever is written while `inBreak()`
 * says yes. `kbps` is the stream's bitrate, which is how a chunk's bytes become
 * seconds.
 */
export function quietDuringBreaks(out: Writer, kbps: number, inBreak: () => boolean): Writer {
  const frame = silentFrame(kbps);
  const bytesPerSecond = (kbps * 1000) / 8;
  let owed = 0;
  return {
    write: (chunk: Buffer): boolean => {
      if (!inBreak()) {
        owed = 0;
        return out.write(chunk);
      }
      owed += chunk.length / bytesPerSecond;
      const frames = Math.floor(owed / FRAME_SECONDS);
      if (frames === 0) return true;
      owed -= frames * FRAME_SECONDS;
      return out.write(Buffer.concat(Array.from({ length: frames }, () => frame)));
    },
    end: () => out.end(),
    ...(out.pending ? { pending: out.pending } : {}),
  };
}

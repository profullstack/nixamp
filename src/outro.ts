/**
 * The outro: what a channel plays once its show is over.
 *
 * A live that ended used to start again from the top, for ever, because a
 * source that finished cleanly was dialled like a source that dropped. Now
 * it plays this: five seconds of "THIS LIVE STREAM HAS ENDED" on the
 * plate with the mark, looped for an hour, so whoever joins late is told
 * so by the picture and not by a blank panel. Then the channel closes.
 *
 * Drawn here, never committed as a file, the way the app's icons are:
 * a bitmap, a 5x7 pixel face, and ffmpeg to make a clip of it. Encoded
 * exactly as a channel is sent on the wire (H.264 and AAC for a picture,
 * MP3 for sound alone) so the channel can copy it through without knowing
 * how its own source was encoded. Made once per server and kept beside the
 * keys; a missing or stale one is drawn again.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** How long the outro plays after a show ends, before the channel closes. */
export const OUTRO_MS = 60 * 60 * 1000;
/** The clip's length; it loops. */
export const OUTRO_SECONDS = 5;
/** Bumped when the drawing changes, so an old clip on disk is drawn again. */
export const OUTRO_VERSION = 1;

export interface Rgba { r: number; g: number; b: number; a: number }

const BACKGROUND: Rgba = { r: 8, g: 12, b: 9, a: 255 };
const GREEN: Rgba = { r: 74, g: 246, b: 137, a: 255 };
const DIM: Rgba = { r: 34, g: 122, b: 74, a: 255 };
const MUTED: Rgba = { r: 120, g: 150, b: 130, a: 255 };
const BARS = [0.30, 0.55, 0.85, 0.62, 1.0, 0.72, 0.45, 0.25];

/** A canvas of straight RGBA bytes. */
export class Bitmap {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 4);
  }
  fill(color: Rgba): void {
    for (let i = 0; i < this.pixels.length; i += 4) this.set(i, color);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgba): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.set((py * this.width + px) * 4, color);
    }
  }
  private set(offset: number, { r, g, b, a }: Rgba): void {
    this.pixels[offset] = r;
    this.pixels[offset + 1] = g;
    this.pixels[offset + 2] = b;
    this.pixels[offset + 3] = a;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

/** Encode as a non-interlaced 8-bit RGBA PNG. */
export function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, pixels } = bitmap;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A 5x7 pixel face: the letters the outro needs and nothing else. */
const GLYPHS: Record<string, string[]> = {
  A: [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  C: [".XXXX", "X....", "X....", "X....", "X....", "X....", ".XXXX"],
  D: ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  H: ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  I: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  M: ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  P: ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  V: ["X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  X: ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  ".": [".....", ".....", ".....", ".....", ".....", "..XX.", "..XX."],
};

export function textWidth(text: string, cell: number): number {
  return text.length * 6 * cell - cell;
}

export function drawText(bitmap: Bitmap, text: string, x: number, y: number, cell: number, color: Rgba): void {
  let at = x;
  for (const letter of text) {
    const rows = GLYPHS[letter];
    if (rows) {
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) if (row[c] === "X") bitmap.rect(at + c * cell, y + r * cell, cell, cell, color);
      });
    }
    at += 6 * cell;
  }
}

function drawBars(bitmap: Bitmap, left: number, bottom: number, width: number, tallest: number, scale: number): void {
  const slot = width / BARS.length;
  const bar = slot * 0.62;
  BARS.forEach((value, i) => {
    const height = Math.max(2, tallest * value);
    const x = left + i * slot + (slot - bar) / 2;
    bitmap.rect(x, bottom - height, bar, height, GREEN);
    const peak = Math.max(2, scale * 0.018);
    bitmap.rect(x, bottom - height - peak * 2.4, bar, peak, DIM);
  });
  bitmap.rect(left, bottom, width, Math.max(2, scale * 0.028), DIM);
}

/** The picture: the mark above the words, on the plate. 1280x720. */
export function drawOutro(width = 1280, height = 720): Bitmap {
  const bitmap = new Bitmap(width, height);
  bitmap.fill(BACKGROUND);
  const mark = height * 0.3;
  drawBars(bitmap, (width - mark) / 2, height * 0.42, mark, mark - height * 0.02, mark * 1.8);
  const line = "THIS LIVE STREAM HAS ENDED";
  const cell = Math.floor(Math.min((width * 0.86) / (line.length * 6), height / 40));
  drawText(bitmap, line, (width - textWidth(line, cell)) / 2, height * 0.56, cell, GREEN);
  const small = Math.max(2, Math.floor(cell * 0.6));
  const site = "NIXAMP.COM";
  drawText(bitmap, site, (width - textWidth(site, small)) / 2, height * 0.56 + cell * 7 + small * 3, small, MUTED);
  return bitmap;
}

/** The encode a channel copies an outro through: what a channel sends on the wire. */
export const OUTRO_ENCODE: Record<"audio" | "video", string[]> = {
  video: ["-c", "copy", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"],
  audio: ["-c", "copy", "-f", "mp3"],
};

export interface OutroOptions {
  ffmpeg: string[];
  /** Where the clips are kept. */
  dir: string;
  onEvent?: (message: string) => void;
}

/**
 * The clips, drawn on first use and kept. `clip(kind)` answers the path,
 * or null when there is no ffmpeg to make one, in which case a channel
 * that ends simply closes as it used to.
 */
export class Outro {
  private made = new Map<string, Promise<string | null>>();

  constructor(private readonly options: OutroOptions) {}

  clip(kind: "audio" | "video"): Promise<string | null> {
    let pending = this.made.get(kind);
    if (!pending) {
      pending = Promise.resolve().then(() => this.make(kind)).catch(() => null);
      this.made.set(kind, pending);
      // A clip that could not be made is tried again next time, not remembered.
      void pending.then((path) => { if (path === null) this.made.delete(kind); });
    }
    return pending;
  }

  private make(kind: "audio" | "video"): string | null {
    mkdirSync(this.options.dir, { recursive: true });
    const path = join(this.options.dir, kind === "video" ? `outro-v${OUTRO_VERSION}.mp4` : `outro-v${OUTRO_VERSION}.mp3`);
    if (existsSync(path) && statSync(path).size > 1000) return path;
    const [command, ...prefix] = this.options.ffmpeg;
    if (!command) return null;
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
    if (kind === "video") {
      const picture = join(this.options.dir, `outro-v${OUTRO_VERSION}.png`);
      writeFileSync(picture, encodePng(drawOutro()));
      args.push(
        "-loop", "1", "-framerate", "30", "-i", picture,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", String(OUTRO_SECONDS),
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30", "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart",
        path,
      );
    } else {
      // Two soft notes, then quiet: something to hear on a channel with no picture.
      args.push(
        "-f", "lavfi", "-i",
        `aevalsrc=0.18*sin(2*PI*523.25*t)*exp(-2.5*t)+0.18*sin(2*PI*392*t)*exp(-2.5*max(t-0.7\\,0))*gte(t\\,0.7):s=44100:d=${OUTRO_SECONDS}`,
        "-c:a", "libmp3lame", "-b:a", "128k", path,
      );
    }
    const run = spawnSync(command, [...prefix, ...args], { timeout: 60_000 });
    if (run.error || run.status !== 0 || !existsSync(path)) {
      this.options.onEvent?.(`  the outro could not be made${run.stderr ? `: ${run.stderr.toString("utf8").trim().split("\n").pop() ?? ""}` : ""}`);
      return null;
    }
    this.options.onEvent?.(`  outro drawn: ${path}`);
    return path;
  }
}

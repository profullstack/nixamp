/**
 * The app icons, drawn rather than committed as opaque binaries.
 *
 *   bun run web/scripts/icons.ts
 *
 * A PNG is a zlib stream in four chunks, and node ships zlib, so an icon
 * pipeline here needs no dependency and no design tool. Every icon is the same
 * picture at a different size, which is the only way the 192 and the 512 stay
 * in step when the mark changes.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Rgba { r: number; g: number; b: number; a: number }

/** A canvas of straight RGBA bytes; no premultiplication, no surprises. */
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
  /** A filled circle, used for the rounded corners of the plate. */
  disc(cx: number, cy: number, radius: number, color: Rgba): void {
    const r2 = radius * radius;
    for (let py = Math.max(0, Math.floor(cy - radius)); py < Math.min(this.height, Math.ceil(cy + radius)); py++) {
      for (let px = Math.max(0, Math.floor(cx - radius)); px < Math.min(this.width, Math.ceil(cx + radius)); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set((py * this.width + px) * 4, color);
      }
    }
  }
  roundedRect(x: number, y: number, w: number, h: number, radius: number, color: Rgba): void {
    this.rect(x + radius, y, w - radius * 2, h, color);
    this.rect(x, y + radius, w, h - radius * 2, color);
    this.disc(x + radius, y + radius, radius, color);
    this.disc(x + w - radius, y + radius, radius, color);
    this.disc(x + radius, y + h - radius, radius, color);
    this.disc(x + w - radius, y + h - radius, radius, color);
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

export function crc32(bytes: Uint8Array): number {
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
  // Filter byte 0 (None) in front of every scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const BACKGROUND: Rgba = { r: 8, g: 12, b: 9, a: 255 };
const GREEN: Rgba = { r: 74, g: 246, b: 137, a: 255 };
const DIM: Rgba = { r: 34, g: 122, b: 74, a: 255 };

/** The heights of the analyser bars in the mark, as fractions of the plate. */
const BARS = [0.30, 0.55, 0.85, 0.62, 1.0, 0.72, 0.45, 0.25];

/**
 * The mark: a spectrum analyser, because that is what the app is.
 *
 * `inset` is the maskable safe zone — a maskable icon can be cropped to a
 * circle by the launcher, so the drawing lives inside the middle 80%.
 */
export function drawIcon(size: number, maskable: boolean): Bitmap {
  const bitmap = new Bitmap(size, size);
  const inset = maskable ? size * 0.1 : 0;
  const plate = size - inset * 2;

  if (maskable) {
    // A maskable icon must paint every corner: the launcher decides the shape.
    bitmap.fill(BACKGROUND);
  } else {
    bitmap.fill({ r: 0, g: 0, b: 0, a: 0 });
    bitmap.roundedRect(0, 0, size, size, size * 0.22, BACKGROUND);
  }

  const pad = plate * 0.16;
  const left = inset + pad;
  const width = plate - pad * 2;
  const bottom = inset + plate - pad;
  const tallest = plate - pad * 2.2;
  const slot = width / BARS.length;
  const bar = slot * 0.62;

  BARS.forEach((value, i) => {
    const height = Math.max(2, tallest * value);
    const x = left + i * slot + (slot - bar) / 2;
    bitmap.rect(x, bottom - height, bar, height, GREEN);
    // The peak marker that sinks — the detail that made the original readable.
    const peak = Math.max(2, size * 0.018);
    bitmap.rect(x, bottom - height - peak * 2.4, bar, peak, DIM);
  });

  // The baseline the bars stand on.
  bitmap.rect(left, bottom, width, Math.max(2, size * 0.028), DIM);
  return bitmap;
}

export interface IconSpec { file: string; size: number; maskable: boolean }

export const ICONS: IconSpec[] = [
  { file: "icons/icon-192.png", size: 192, maskable: false },
  { file: "icons/icon-512.png", size: 512, maskable: false },
  { file: "icons/icon-192-maskable.png", size: 192, maskable: true },
  { file: "icons/icon-512-maskable.png", size: 512, maskable: true },
  // iOS ignores the manifest icons and crops whatever it is given, so the
  // apple-touch-icon is the maskable drawing on an opaque plate.
  { file: "apple-touch-icon.png", size: 180, maskable: true },
];

export function writeIcons(publicDir: string): string[] {
  return ICONS.map(({ file, size, maskable }) => {
    const path = join(publicDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(drawIcon(size, maskable)));
    return path;
  });
}

if (import.meta.main) {
  const target = process.argv[2] ?? join(fileURLToPath(new URL("..", import.meta.url)), "public");
  for (const path of writeIcons(target)) console.log(`wrote ${path}`);
}

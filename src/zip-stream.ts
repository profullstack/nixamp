/**
 * A zip written as it is sent: files are stored (MP3s and JPEGs do not
 * shrink), each CRC-32 is worked out while its bytes go by and written after
 * them in a data descriptor, so nothing is staged on disk and the first byte
 * leaves at once. Plain zip (no ZIP64): fine for an album or an artist's
 * catalogue, refused past 4 GB.
 */
import { createReadStream, statSync } from "node:fs";
import type { Writable } from "node:stream";

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipEntry {
  /** The name inside the zip, with "/" between folders. */
  name: string;
  /** A file on disk, or the bytes themselves. */
  path?: string;
  bytes?: Uint8Array;
}

/** DOS date and time, which is what zip keeps. */
function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(1980, at.getFullYear()) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

function write(out: Writable, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error("the download was closed"));
    if (out.write(chunk)) return resolve();
    const fail = (): void => { out.off("drain", go); reject(new Error("the download was closed")); };
    const go = (): void => { out.off("close", fail); resolve(); };
    out.once("drain", go);
    out.once("close", fail);
  });
}

/** The zip's size, known before a byte is sent, for Content-Length. */
export function zipSize(entries: ZipEntry[]): number {
  let total = 22;
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.name);
    const size = entry.bytes ? entry.bytes.length : statSync(entry.path!).size;
    total += 30 + name + size + 16 + 46 + name;
  }
  return total;
}

/** Writes the zip to `out` (left open). */
export async function writeZip(out: Writable, entries: ZipEntry[], now = new Date()): Promise<void> {
  const { time, date } = dosTime(now);
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // sizes in a descriptor after the data; names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    await write(out, local);
    await write(out, name);
    let crc = 0;
    let size = 0;
    if (entry.bytes) {
      crc = crc32(entry.bytes);
      size = entry.bytes.length;
      await write(out, entry.bytes);
    } else {
      for await (const chunk of createReadStream(entry.path!)) {
        const bytes = chunk as Buffer;
        crc = crc32(bytes, crc);
        size += bytes.length;
        await write(out, bytes);
      }
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(out, descriptor);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + size + 16;
    if (offset > 0xffffffff) throw new Error("too big for a zip (4 GB)");
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, directory);
  await write(out, end);
}

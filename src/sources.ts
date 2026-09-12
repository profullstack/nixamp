/**
 * Where a playlist comes from.
 *
 * A directory, a file, an .m3u, or a URL to any of those. ffmpeg reads a URL as
 * happily as a path, so a remote track needs no special case once it is in the
 * list; what needs care is telling the four apart, and telling an .m3u that
 * lists tracks from an HLS playlist that *is* one track.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** http and https only. ffmpeg speaks more, but these are what a link is. */
export function isRemote(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

export function isPlaylistFile(source: string): boolean {
  const path = isRemote(source) ? new URL(source).pathname : source;
  return /\.(m3u|m3u8|pls)$/i.test(path);
}

/**
 * An HLS playlist describes one stream in segments; an .m3u describes a list of
 * things to play. Both are "m3u8" on disk, and the tags are the only honest way
 * to tell them apart. Expanding an HLS playlist into a track per segment would
 * turn one song into four hundred.
 */
export function isHls(text: string): boolean {
  return /^#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|ENDLIST)/im.test(text);
}

export interface Entry {
  /** A path or a URL, whichever the playlist gave us. */
  source: string;
  title: string;
  /** Seconds, from #EXTINF. Zero when it did not say, and for live. */
  duration: number;
}

/** Resolve a playlist line against the playlist's own location. */
export function resolveEntry(base: string, entry: string): string {
  if (isRemote(entry)) return entry;
  if (isRemote(base)) return new URL(entry, base).toString();
  if (entry.startsWith("/")) return entry;
  const dir = base.slice(0, Math.max(0, base.lastIndexOf("/")));
  return dir ? `${dir}/${entry}` : entry;
}

/**
 * Parse an .m3u or .m3u8. `#EXTINF:<seconds>,<title>` decorates the line after
 * it; everything else beginning with # is a comment or a tag we do not need.
 */
export function parseM3u(text: string, base: string): Entry[] {
  const out: Entry[] = [];
  let duration = 0;
  let title = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      const info = /^#EXTINF:\s*(-?[\d.]+)\s*(?:,(.*))?$/i.exec(line);
      if (info) {
        const seconds = Number(info[1]);
        // -1 is the conventional "unknown", which is also what live means.
        duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        title = (info[2] ?? "").trim();
      }
      continue;
    }

    const source = resolveEntry(base, line);
    out.push({ source, duration, title: title || nameOf(source) });
    duration = 0;
    title = "";
  }
  return out;
}

/** A .pls, which Shoutcast and Icecast hand out as often as an .m3u. */
export function parsePls(text: string, base: string): Entry[] {
  const files = new Map<string, string>();
  const titles = new Map<string, string>();
  const lengths = new Map<string, number>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, kind, index, value] = match as unknown as [string, string, string, string];
    if (/^file$/i.test(kind)) files.set(index, value);
    else if (/^title$/i.test(kind)) titles.set(index, value);
    else lengths.set(index, Number(value));
  }

  return [...files.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([index, file]) => {
      const source = resolveEntry(base, file);
      const seconds = lengths.get(index) ?? 0;
      return {
        source,
        title: titles.get(index)?.trim() || nameOf(source),
        duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
      };
    });
}

/** The last useful part of a path or URL, for when nothing named the track. */
/**
 * What to call a whole source, as a heading over the tracks it brought.
 *
 * `nameOf` answers for a file; this answers for the thing a person added --
 * usually the last segment either way, but a URL that is only a host has no
 * segment to take, and "the album at that address" reads better as the host
 * than as the whole URL repeated over every row.
 */
export function sourceLabel(source: string): string {
  const trimmed = source.replace(/\/+$/, "");
  if (trimmed === "") return source;
  const named = nameOf(trimmed);
  if (named !== trimmed && named !== "") return named;
  if (!isRemote(trimmed)) return trimmed;
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}

export function nameOf(source: string): string {
  const remote = isRemote(source);
  const path = remote ? new URL(source).pathname : source;
  const last = path.split("/").filter(Boolean).pop() ?? source;
  // Percent-decoding is a URL's business. A file on disk called
  // `Some%20Song.mp3` is called exactly that, and renaming it in the display
  // would be a lie about what is in the directory.
  if (!remote) return last || source;
  try {
    return decodeURIComponent(last) || source;
  } catch {
    return last || source;
  }
}

/**
 * Formats a browser will play as-is. Anything else gets transcoded on the way
 * out, which is the difference between a library that plays on a phone and one
 * that plays on the machine it lives on.
 */
const WEB_READY = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".webm", ".mp4", ".wav"]);

export function playsInBrowser(source: string): boolean {
  if (isRemote(source)) return false;
  const path = source.toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot > 0 && WEB_READY.has(path.slice(dot));
}

/**
 * Transport streams, which is what a raw `.ts` file off a capture card, a
 * satellite receiver or an IPTV recorder is.
 *
 * `.m2ts`, `.mts` and the rest name nothing else, so the extension is answer
 * enough. `.ts` is the awkward one: it is also every TypeScript file in every
 * repository on the machine, and this program is written in them. So a `.ts`
 * is never taken on its name -- it is opened and asked, which costs one read
 * of two kilobytes and is the only honest way to tell 4K television from a
 * module.
 */
const TRANSPORT_NAMES = new Set([".m2ts", ".mts", ".m2t", ".trp", ".tp", ".mpegts"]);

/** A `.ts`, which may be a transport stream and may be a TypeScript file. */
export function isAmbiguousTransportName(path: string): boolean {
  return /\.ts$/i.test(isRemote(path) ? new URL(path).pathname : path);
}

/** An extension that means a transport stream and nothing else. */
export function isTransportName(path: string): boolean {
  const file = isRemote(path) ? new URL(path).pathname : path;
  const dot = file.lastIndexOf(".");
  return dot > 0 && TRANSPORT_NAMES.has(file.slice(dot).toLowerCase());
}

/** How many bytes are read to decide. Three packets at the widest spacing, and room to find the first. */
const SNIFF = 2048;
/**
 * Packet sizes in the wild: 188 is MPEG-TS, 192 is what Blu-ray and a lot of
 * recorders write (a four-byte arrival timestamp in front of each packet), 204
 * is 188 with Reed-Solomon parity from a DVB card.
 */
const STRIDES = [188, 192, 204];

/**
 * Whether these bytes are a transport stream: a 0x47 sync byte at the start of
 * every packet.
 *
 * Three in a row at the same spacing, because one 0x47 in a file is the letter
 * G. The first packet may not be at byte zero -- a recording cut mid-stream
 * starts mid-packet -- so every offset within one packet is tried.
 */
export function sniffTransportStream(head: Buffer): boolean {
  for (const stride of STRIDES) {
    for (let start = 0; start < stride; start++) {
      if (start + stride * 2 >= head.length) break;
      if (head[start] !== 0x47) continue;
      if (head[start + stride] === 0x47 && head[start + stride * 2] === 0x47) return true;
    }
  }
  return false;
}

/**
 * Whether the file at this path is a transport stream.
 *
 * Remembered, because the answer is asked once per snapshot per track and a
 * library listing must not turn into a read per file per frame. A file that
 * changes under us is a file being written, and a stale answer about it is a
 * track that plays rather than a listing that stalls.
 */
const sniffed = new Map<string, boolean>();
const SNIFF_REMEMBERED = 5000;

export function looksLikeTransportStream(path: string): boolean {
  if (isRemote(path)) return false;
  const remembered = sniffed.get(path);
  if (remembered !== undefined) return remembered;
  let answer = false;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(SNIFF);
    const read = readSync(fd, head, 0, SNIFF, 0);
    answer = sniffTransportStream(head.subarray(0, read));
  } catch {
    answer = false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Closing a file that could not be opened is not a failure.
      }
    }
  }
  // A cap rather than a cache with eviction: a library of a million files
  // must not be a million remembered answers, and forgetting costs one read.
  if (sniffed.size >= SNIFF_REMEMBERED) sniffed.clear();
  sniffed.set(path, answer);
  return answer;
}

/** Whether this path is a transport stream, by name where the name is certain and by its bytes where it is not. */
export function isTransportStream(path: string): boolean {
  if (isTransportName(path)) return true;
  return isAmbiguousTransportName(path) && looksLikeTransportStream(path);
}

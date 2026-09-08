/**
 * Where a playlist comes from.
 *
 * A directory, a file, an .m3u, or a URL to any of those. ffmpeg reads a URL as
 * happily as a path, so a remote track needs no special case once it is in the
 * list; what needs care is telling the four apart, and telling an .m3u that
 * lists tracks from an HLS playlist that *is* one track.
 */

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

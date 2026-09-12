/** The playlist: audio found on disk or named by a playlist, in a stable order. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { probe, probeAsync, type Tools, type Track } from "./audio.ts";
import {
  type Entry,
  isAmbiguousTransportName,
  isHls,
  isPlaylistFile,
  isRemote,
  looksLikeTransportStream,
  nameOf,
  parseM3u,
  parsePls,
} from "./sources.ts";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac",
  ".wav", ".wma", ".aiff", ".aif", ".alac", ".mp4", ".webm",
  // Video containers, for their audio. Everything on the way out of here is
  // already decoded by ffmpeg and re-encoded to MP3 with -vn, so a film is a
  // long track with a picture nobody asked for -- and a library of them was
  // invisible to nixamp for want of the extension being on this list.
  ".mkv", ".avi", ".mov", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv",
  // Transport streams, which is what a recorder, a capture card or a receiver
  // writes: 1080p and 4K television as it came off the wire. These names mean
  // nothing else, so they are taken on the name. `.ts` is deliberately absent
  // -- see `playable` below, which opens it instead of guessing.
  ".m2ts", ".mts", ".m2t", ".trp", ".tp",
]);

export function isAudio(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Whether a file in a library is something to play.
 *
 * The name answers for everything except `.ts`, which is both a raw transport
 * stream -- a 4K recording, an IPTV dump -- and every TypeScript file ever
 * written, this program's own included. A library of recordings was invisible
 * for want of the extension being listed, and listing it would have turned a
 * checkout into a playlist. So a `.ts` is opened and asked: three sync bytes
 * at one packet's spacing, which no source file has.
 */
export function playable(path: string): boolean {
  if (isAudio(path)) return true;
  return isAmbiguousTransportName(path) && looksLikeTransportStream(path);
}

/** Every audio file under `root`, depth first. A single file is a playlist of one. */
export function findAudio(root: string): string[] {
  const out: string[] = [];
  let stats;
  try {
    stats = statSync(root);
  } catch {
    return out;
  }
  if (stats.isFile()) return playable(root) ? [root] : out;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else if (playable(full)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** An entry that was never probed: playable, just not described. */
function bare(entry: Entry): Track {
  return { path: entry.source, title: entry.title, artist: "", album: "", duration: entry.duration };
}

/**
 * Read a playlist, from disk or over the network. An HLS playlist is not a list
 * of tracks but one stream in segments, so it comes back as a single entry and
 * ffmpeg is left to do what it is good at.
 */
export async function readPlaylist(source: string): Promise<Entry[]> {
  let text: string;
  if (isRemote(source)) {
    const response = await fetch(source, { redirect: "follow" });
    if (!response.ok) throw new Error(`nixamp: ${source} answered ${response.status}`);
    text = await response.text();
  } else {
    text = readFileSync(source, "utf8");
  }

  if (isHls(text)) return [{ source, title: nameOf(source), duration: 0 }];
  const entries = /\.pls$/i.test(source) ? parsePls(text, source) : parseM3u(text, source);
  return entries;
}

/**
 * The audio linked from a directory listing a web server generated.
 *
 * A seedbox or a plain Apache with autoindex on serves a folder as an HTML page
 * of relative links. Handed one of those, nixamp used to make a single track of
 * the page itself and give it to ffmpeg, which is asked to decode HTML and says
 * so in a way nobody reads. It is a folder; it should behave like one.
 *
 * Not recursive, deliberately: one page is one album, the subdirectory links are
 * on it, and walking a stranger's whole tree from a text box is a different and
 * much larger thing to ask for.
 */
export async function readRemoteIndex(source: string, send: typeof fetch = fetch): Promise<Entry[]> {
  let answer: Response;
  try {
    answer = await send(source, {
      redirect: "follow",
      headers: { accept: "text/html,*/*" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return [];
  }
  if (!answer.ok) return [];
  // Anything that is not a page is the thing itself, and the caller plays it.
  if (!/^text\/html/i.test(answer.headers.get("content-type") ?? "")) return [];

  const html = await answer.text().catch(() => "");
  const found: Entry[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1];
    // The sort links an index puts at the top of every column, and anchors.
    if (!href || href.startsWith("?") || href.startsWith("#")) continue;
    let url: URL;
    try {
      // Relative to the page, which is how an index writes them.
      url = new URL(href.replace(/&amp;/g, "&"), source);
    } catch {
      continue;
    }
    if (!isAudio(url.pathname)) continue;
    const link = url.toString();
    if (seen.has(link)) continue;
    seen.add(link);
    found.push({
      source: link,
      // The name as a person wrote it, not as a URL spells it.
      title: decodeURIComponent(url.pathname.split("/").pop() ?? link),
      duration: 0,
    });
  }
  // Server order is by whatever column the index sorted on; by name is what
  // somebody handing over an album meant.
  found.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return found;
}

/**
 * Everything `nixamp <thing>` can be handed: a directory, a file, a playlist,
 * or a URL to any of those.
 *
 * Reading tags means an ffprobe per file, which is slow for a large library and
 * slower still over the network, so it is only done for local files the caller
 * asked about.
 */
export async function loadSource(tools: Tools, source: string, probeTags = true): Promise<Track[]> {
  if (isPlaylistFile(source)) {
    let entries: Entry[];
    try {
      entries = await readPlaylist(source);
    } catch (error) {
      // The playlist is the whole argument, so failing to read it is fatal --
      // but it is fatal with a sentence, not a stack.
      throw new Error(`nixamp: could not read ${source}: ${(error as Error).message.replace(/^nixamp: /, "")}`);
    }
    return entries.map((entry) =>
      probeTags && !isRemote(entry.source) && entry.duration === 0
        ? { ...probe(tools, entry.source), title: entry.title || probe(tools, entry.source).title }
        : bare(entry),
    );
  }

  if (isRemote(source)) {
    // A URL that names no file is probably a folder, and a folder served over
    // http is a page of links. Asked only when it could be one: a stream URL
    // must not pay for a fetch that will tell us nothing.
    // A `.ts` address is a transport stream over http, never a folder listing.
    if (!isAudio(new URL(source).pathname) && !isAmbiguousTransportName(source)) {
      const listed = await readRemoteIndex(source);
      if (listed.length > 0) return listed.map(bare);
    }
    // A bare URL is one remote thing to play. Whether it is a song or a live
    // stream is ffmpeg's problem, and it is good at it.
    return [bare({ source, title: nameOf(source), duration: 0 })];
  }

  // The walk yields, because by the time this runs at startup the port is
  // already open and a synchronous walk of a large library answers nobody for
  // as long as it takes.
  const paths = await findAudioAsync(source);
  return paths.map((path) =>
    probeTags ? probe(tools, path) : { path, title: path.split("/").pop() ?? path, artist: "", album: "", duration: 0 },
  );
}

/**
 * Reading tags means an ffprobe per file, which is slow for a large library, so
 * the caller decides when to pay for it. Untagged entries still play.
 */
export function loadPlaylist(tools: Tools, root: string, probeTags = true): Track[] {
  return findAudio(root).map((path) =>
    probeTags ? probe(tools, path) : {
      path,
      title: path.split("/").pop() ?? path,
      artist: "", album: "", duration: 0,
    });
}

/**
 * The same tags, read without holding the process still.
 *
 * `probe` is a spawnSync per file, so reading a library inside one async
 * function never yields: the listening socket keeps accepting connections,
 * the kernel completes their handshakes, and the process answers none of them
 * until the last file is done. From outside that is indistinguishable from a
 * firewall -- a connection that opens and then says nothing -- and on a library
 * of any size it lasts minutes.
 *
 * One turn of the event loop per file fixes it. A request then waits for one
 * ffprobe rather than for the whole library, and the tagging still finishes in
 * about the time it did.
 */
export async function loadTagged(
  tools: Tools,
  source: string,
  /** Injected by the test, which must not depend on ffprobe being installed. */
  probeOne: (tools: Tools, path: string) => Promise<Track> = probeAsync,
  /**
   * The files, when the caller has already found them.
   *
   * Startup walks the library to list it and then walked it again to tag it --
   * twice through a large tree, and the second walk was the one that happened
   * after the port was open, so it was the one people waited on.
   */
  known?: string[],
): Promise<Track[]> {
  // A URL is one thing and is never probed; a playlist carries its own titles.
  if (isRemote(source) || isPlaylistFile(source)) return loadSource(tools, source, true);

  const paths = known ?? (await findAudioAsync(source));
  const tracks: Track[] = [];
  for (const path of paths) {
    // Awaiting a child process, not blocking on one. Yielding between files
    // was not enough: each spawnSync still stopped everything for as long as
    // one ffprobe took, which on a large file is long enough to strangle a
    // stream being served at the same time.
    tracks.push(await probeOne(tools, path));
  }
  return tracks;
}

/**
 * The same walk, without stopping everything for the length of it.
 *
 * `findAudio` is readdirSync and statSync all the way down, so on a large
 * library it holds the event loop for its entire duration: the socket keeps
 * accepting connections, the kernel completes their handshakes, and the
 * process answers none of them. From outside that is indistinguishable from a
 * server that has hung -- 417 gigabytes of downloads took long enough that
 * requests timed out while the log said the server was up.
 *
 * Yielding every few hundred entries costs a few milliseconds over the whole
 * walk and means a request waits for one directory rather than for the disk.
 */
export async function findAudioAsync(root: string, every = 200): Promise<string[]> {
  const out: string[] = [];
  let stats;
  try {
    stats = statSync(root);
  } catch {
    return out;
  }
  if (stats.isFile()) return playable(root) ? [root] : out;

  let since = 0;
  const breathe = async (): Promise<void> => {
    if (++since < every) return;
    since = 0;
    await new Promise((done) => setImmediate(done));
  };

  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      await breathe();
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) await walk(full);
      else if (playable(full)) out.push(full);
    }
  };
  await walk(root);
  return out;
}

export function displayName(track: Track): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

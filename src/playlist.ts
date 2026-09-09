/** The playlist: audio found on disk or named by a playlist, in a stable order. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { probe, probeAsync, type Tools, type Track } from "./audio.ts";
import {
  type Entry,
  isHls,
  isPlaylistFile,
  isRemote,
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
]);

export function isAudio(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.has(path.slice(dot).toLowerCase());
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
  if (stats.isFile()) return isAudio(root) ? [root] : out;

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
      else if (isAudio(full)) out.push(full);
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

  // A bare URL is one remote thing to play. Whether it is a song or a live
  // stream is ffmpeg's problem, and it is good at it.
  if (isRemote(source)) return [bare({ source, title: nameOf(source), duration: 0 })];

  return loadPlaylist(tools, source, probeTags);
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
export async function loadTagged(tools: Tools, source: string): Promise<Track[]> {
  // A URL is one thing and is never probed; a playlist carries its own titles.
  if (isRemote(source) || isPlaylistFile(source)) return loadSource(tools, source, true);

  const paths = findAudio(source);
  const tracks: Track[] = [];
  for (const path of paths) {
    // Awaiting a child process, not blocking on one. Yielding between files
    // was not enough: each spawnSync still stopped everything for as long as
    // one ffprobe took, which on a large file is long enough to strangle a
    // stream being served at the same time.
    tracks.push(await probeAsync(tools, path));
  }
  return tracks;
}

export function displayName(track: Track): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

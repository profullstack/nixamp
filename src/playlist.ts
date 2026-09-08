/** The playlist: audio found on disk or named by a playlist, in a stable order. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { probe, type Tools, type Track } from "./audio.ts";
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

export function displayName(track: Track): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

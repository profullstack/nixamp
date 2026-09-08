/** The playlist: audio files found on disk, in a stable order. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { probe, type Tools, type Track } from "./audio.ts";

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

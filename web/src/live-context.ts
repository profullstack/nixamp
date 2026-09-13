import type { RemoteTrack } from "../../src/protocol.ts";

/** Clean an untagged media filename, without rewriting tagged titles or years. */
export function liveTitle(title: string): string {
  if (!/\.(?:mp4|m4v|mkv|webm|mov|avi|mp3|m4a|flac|ogg|opus|wav|aac)$/i.test(title)) return title;
  const stem = (title.split(/[\\/]/).pop() ?? title).replace(/\.[^.]+$/, "");
  // Downloaded lectures commonly have both a padded file number and a
  // lesson number. A year such as 2001 is part of a title, not a sequence.
  return stem.replace(/^0\d+[_ .-]+(?:\d+[_ .-]+)?/, "").replace(/_+/g, " ").trim() || stem;
}

function folderParts(folder: string): string[] {
  // The protocol supplies relative folders. Never surface an absolute server
  // path if an older or third-party server sends one by mistake.
  if (/^(?:[\\/]|[A-Za-z]:)/.test(folder)) return [];
  const parts = folder.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part === "..")) return [];
  return parts.filter((part) => part !== ".").map((part) => part.replace(/_+/g, " "));
}

export interface LiveContext {
  title: string;
  /** Only real source, folder, or album metadata; never guessed from a title. */
  context: string;
  /** Position within this folder/source/album, not the whole mixed library. */
  position: string;
  fullTitle: string;
}

export function liveContext(tracks: readonly RemoteTrack[], index: number, fallback = "Live"): LiveContext {
  const track = tracks[index];
  if (!track) {
    const title = liveTitle(fallback || "Live");
    return { title, context: "", position: "", fullTitle: title };
  }
  const title = track.artist ? `${track.artist} — ${liveTitle(track.title)}` : liveTitle(track.title);
  const folders = folderParts(track.folder ?? "");
  const group = folderParts(track.group ?? "").join(" › ");
  const parts = [...(group ? [group] : []), ...folders];
  const context = parts.filter((part, i) => i === 0 || part !== parts[i - 1]).join(" › ") || track.album;
  const siblings = tracks.map((one, at) => ({ one, at })).filter(({ one }) =>
    (one.group ?? "") === (track.group ?? "") &&
    (one.folder ?? "") === (track.folder ?? "") &&
    (parts.length > 0 || one.album === track.album),
  );
  const position = `Playlist · ${siblings.findIndex(({ at }) => at === index) + 1} of ${siblings.length}`;
  return { title, context, position, fullTitle: context ? `${context} › ${title}` : title };
}

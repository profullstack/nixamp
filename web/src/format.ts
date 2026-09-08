/** The formatting the terminal app does, done the same way in a browser. */
import type { RemoteTrack } from "../../src/protocol.ts";

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function displayName(track: Pick<RemoteTrack, "title" | "artist">): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** A file name with its extension taken off, for a track with no tags. */
export function titleFromFilename(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

const VIDEO = new Set(["mp4", "webm", "mkv", "mov", "m4v", "ogv", "avi"]);

/** Video needs a <video> element and a picture; audio does not. */
export function isVideoFile(name: string, type = ""): boolean {
  if (type.startsWith("video/")) return true;
  if (type.startsWith("audio/")) return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && VIDEO.has(name.slice(dot + 1).toLowerCase());
}

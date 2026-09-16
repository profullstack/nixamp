import { classroomBroadcast } from "../../src/classroom.ts";
import { apiUrl, splitShareLink } from "../../web/src/remote.ts";

export interface ClassroomSource { src: string; live: boolean; kind?: "hls" | "audio"; }

/** Resolve viewer links without loading another document or sending viewer keys elsewhere. */
export async function classroomSource(value: unknown, signal: AbortSignal, request: typeof fetch = fetch): Promise<ClassroomSource | null> {
  const broadcast = classroomBroadcast(value);
  if (!broadcast || broadcast.provider === "pairux") return null;
  if (broadcast.provider === "media") return { src: broadcast.url, live: false };
  const url = new URL(broadcast.url);
  const play = url.searchParams.get("play")!;
  if (play.startsWith("https://")) return { src: play, live: false };
  const { base, key } = splitShareLink(url.searchParams.get("url") || "https://nixamp.com");
  const endpoint = (path: string) => apiUrl(base, path, key);
  if (play.startsWith("track:")) return { src: endpoint(`/api/media/${play.slice(6)}`), live: false };
  if (play === "live") return { src: endpoint("/api/live"), live: true };
  const response = await request(endpoint("/api/streams"), { signal });
  if (!response.ok) throw new Error("The broadcast could not be loaded. Try again.");
  const data = await response.json() as { channels?: { id: string; name: string; kind?: string }[] };
  const wanted = play.slice("channel:".length);
  const channel = data.channels?.find(item => item.id === wanted) ?? data.channels?.find(item => item.name === wanted);
  if (!channel) throw new Error("The host has not started this broadcast yet. Try again shortly.");
  const path = `/api/channels/${encodeURIComponent(channel.id)}`;
  return channel.kind === "audio"
    ? { src: endpoint(path), live: true, kind: "audio" }
    : { src: endpoint(`${path}/hls/index.m3u8`), live: true, kind: "hls" };
}

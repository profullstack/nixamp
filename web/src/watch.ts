/**
 * A live room's page: /watch?play=<a nixamp server's channel or live stream>,
 * what a "?play=" join link opens on live.streaming. It asks the room's own
 * server what the room is (a name, video or sound, what is on) and plays it
 * live in @profullstack/player: a film as a picture, radio as sound. Nothing
 * about the room passes through the server that served this page.
 */
import { createPlayer, type PlayerHandle } from "@profullstack/player";
import "@profullstack/player/player.css";
import "./styles.css";
import "./station.css";

interface Room { origin: string; channel: string | null; key: string; play: string }
interface ChannelRow {
  id: string; name?: string; kind?: string; live?: boolean; playlist?: string[];
  codecs?: { tags?: { title?: string; artist?: string; album?: string } };
}
interface Seen { name: string; kind: "audio" | "video"; live: boolean; folder: boolean; title: string; by: string }

/** The same rule the server keeps (src/guide-rooms.ts roomAddress). */
function roomOf(input: string): Room | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(url.hostname))) return null;
  const channel = /^\/api\/channels\/([A-Za-z0-9._~-]{1,120})\/?$/.exec(url.pathname);
  const live = /^\/api\/live\/?$/.test(url.pathname);
  const key = url.searchParams.get("k") ?? "";
  if ((!channel && !live) || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return null;
  const path = channel ? `/api/channels/${channel[1]}` : "/api/live";
  return { origin: url.origin, channel: channel ? channel[1]! : null, key, play: `${url.origin}${path}?k=${key}` };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const room = roomOf(new URLSearchParams(location.search).get("play") ?? "");

let player: PlayerHandle | null = null;
let mounted = "";
let last: Seen | null = null;
let wanted = false;
let retry = 0;
let timer = 0;
let pausedAt = 0;

const chip = (state: string, text: string): void => {
  const c = $("#state");
  c.className = "station-chip " + state;
  c.textContent = text;
};
const say = (text: string): void => { $("#announce").textContent = text; };

/** iPhone Safari has no MediaSource and will not play an endless MP4; it plays HLS. */
const wantsHls = (): boolean => typeof MediaSource === "undefined" && typeof (window as { ManagedMediaSource?: unknown }).ManagedMediaSource === "undefined";

/** What to hand the player for this room now: always a fresh request, the live edge. */
function source(seen: Seen): { src: string; kind: "mp4" | "hls" | "audio" } {
  const fresh = `&n=${Date.now()}`;
  if (seen.kind === "video" && room!.channel !== null && (wantsHls() || seen.folder)) {
    return { src: `${room!.origin}/api/channels/${room!.channel}/hls/index.m3u8?k=${room!.key}`, kind: "hls" };
  }
  return { src: room!.play + fresh, kind: seen.kind === "video" ? "mp4" : "audio" };
}

function unmount(): void {
  const old = player;
  player = null;
  mounted = "";
  old?.destroy();
}

function mount(seen: Seen, autoplay: boolean): void {
  unmount();
  const { src, kind } = source(seen);
  const current = createPlayer($("#stage"), { src, kind, audio: seen.kind === "audio", live: true, autoplay });
  player = current;
  mounted = seen.kind;
  const media = current.media;
  const mine = (): boolean => player === current;
  media.addEventListener("playing", () => {
    if (!mine()) return;
    if (retry) say("Back on");
    retry = 0;
    draw();
  });
  media.addEventListener("error", () => { if (mine()) again(); });
  media.addEventListener("ended", () => { if (mine()) again(); });
  media.addEventListener("stalled", () => { if (mine() && media.readyState < 3) again(); });
  // A live room does not wait: playing again after a pause joins it where it is now.
  media.addEventListener("pause", () => {
    if (!mine() || media.ended || media.error) return;
    wanted = false;
    pausedAt = Date.now();
  });
  media.addEventListener("play", () => {
    if (!mine()) return;
    wanted = true;
    if (pausedAt && Date.now() - pausedAt > 3000 && last) { pausedAt = 0; mount(last, true); }
  });
}

function again(): void {
  if (!wanted || !last) return;
  retry += 1;
  draw();
  clearTimeout(timer);
  timer = window.setTimeout(() => { if (last) mount(last, true); }, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
}

function draw(): void {
  if (!last) return;
  document.title = `${last.name} · live`;
  $("#name").textContent = last.name;
  $("#title").textContent = last.title;
  $("#by").textContent = last.by;
  if (retry > 0) chip("reconnecting", "Reconnecting");
  else if (last.live) chip("live", last.kind === "video" ? "Live · TV" : "Live · radio");
  else chip("stopped", "Off the air");
}

/** Asks the room's server what it is. A channel is in its channel list; the live stream answers with media. */
async function look(): Promise<Seen | null> {
  if (room!.channel !== null) {
    const answer = await fetch(`${room!.origin}/api/channels?k=${room!.key}`, { cache: "no-store" });
    if (!answer.ok) return null;
    const row = ((await answer.json()) as { channels?: ChannelRow[] }).channels?.find((one) => one.id === room!.channel);
    if (!row) return null;
    const tags = row.codecs?.tags ?? {};
    return {
      name: String(row.name ?? room!.channel).replace(/\/+$/, ""),
      kind: row.kind === "video" ? "video" : "audio",
      live: row.live !== false,
      folder: room!.channel.startsWith("folder-") || (row.playlist?.length ?? 0) > 1,
      title: String(tags.title ?? ""),
      by: [tags.artist, tags.album].filter(Boolean).join(" · "),
    };
  }
  const controller = new AbortController();
  try {
    const answer = await fetch(room!.play + `&n=${Date.now()}`, { signal: controller.signal, cache: "no-store" });
    const type = answer.headers.get("content-type") ?? "";
    controller.abort();
    return answer.ok ? { name: "Live", kind: type.startsWith("video/") ? "video" : "audio", live: true, folder: false, title: "", by: "" } : null;
  } catch {
    return null;
  }
}

async function poll(): Promise<void> {
  try {
    const seen = await look();
    if (!seen) {
      $("#name").textContent = "This room is not on the air";
      chip("unavailable", "Unavailable");
      return;
    }
    last = seen;
    // Made once the room says what it carries, and again if that changes.
    if (seen.live && mounted !== seen.kind) mount(seen, wanted);
    draw();
  } catch {
    // The next look tries again.
  }
}

if (!room) {
  $("#name").textContent = "That is not a room link";
  $("#about").textContent = "A room link is the address a nixamp Share gives you: https://…/api/channels/<id>?k=…";
  $("#about").hidden = false;
  chip("unavailable", "Unavailable");
} else {
  $<HTMLAnchorElement>("#raw").href = room.play;
  $<HTMLAnchorElement>("#nixamp").href = `https://nixamp.com/?play=${encodeURIComponent(room.play)}`;
  void poll();
  // What is on, and on the air or not; the listener's own press starts the sound.
  setInterval(() => void poll(), 10_000);
}

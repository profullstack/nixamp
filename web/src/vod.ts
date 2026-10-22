/**
 * On demand: /vod/<id> plays one published file from its start, seekable,
 * and hands out its link; /vod lists them all. The guide that served this
 * page keeps the list (src/guide-vods.ts); the file's own server plays the
 * bytes, so nothing of the film passes through here.
 */
import { createPlayer, formatTime, formatTimeParam, parseTimeParam } from "@profullstack/player";
import "@profullstack/player/player.css";
import "./styles.css";
import "./station.css";

interface Vod {
  id: string; name: string; kind: "audio" | "video"; duration: number; artist: string;
  note: string; available: boolean; play: string; page: string; priceCents?: number;
}

/** "$1", "$2.50", "50¢": as nixamp.com's store writes a price. */
const price = (cents: number): string => (cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`);
interface Card { id?: string; name: string; kind: string; state: string; page: string; nowPlaying: { title: string; artist: string } | null }

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const say = (text: string): void => { $("#announce").textContent = text; };
const id = /^\/vod\/([A-Za-z0-9_-]{1,32})\/?$/.exec(location.pathname)?.[1] ?? "";

function chip(state: string, text: string): void {
  const c = $("#state");
  c.className = "station-chip " + state;
  c.textContent = text;
}

async function one(): Promise<void> {
  $("#one").hidden = false;
  const answer = await fetch(`/api/v1/guide/vods/${id}`, { cache: "no-store" }).catch(() => null);
  const vod = answer?.ok ? ((await answer.json()) as { vod: Vod }).vod : null;
  if (!vod) {
    $("#name").textContent = "That video is not here";
    $("#note").textContent = "It may have been taken off. See everything that is.";
    $("#note").hidden = false;
    chip("unavailable", "Unavailable");
    $(".vod-share").hidden = true;
    return;
  }
  document.title = `${vod.name} · on demand`;
  $("#name").textContent = vod.name;
  $("#by").textContent = vod.artist;
  $("#length").textContent = vod.duration > 0 ? formatTime(vod.duration) : "";
  if (vod.note) { $("#note").textContent = vod.note; $("#note").hidden = false; }
  // Sold as a download on nixamp.com, as the label's music is; watching stays free.
  if (vod.priceCents && vod.priceCents > 0) {
    const buy = $<HTMLAnchorElement>("#buy-link");
    buy.href = `https://nixamp.com/buy?${new URLSearchParams({ server: new URL(vod.page).origin, kind: "vod", vod: vod.id })}`;
    buy.textContent = `Download · ${price(vod.priceCents)}`;
    $("#buy").hidden = false;
  }
  // The short link, not the file's address: it outlives a change of server key.
  const link = $<HTMLInputElement>("#link");
  link.value = vod.page;
  $("#copy").addEventListener("click", () => {
    void navigator.clipboard?.writeText(link.value).then(() => say("Link copied"), () => { link.select(); say("Select and copy the link"); });
    $("#copy").textContent = "Copied";
    setTimeout(() => { $("#copy").textContent = "Copy link"; }, 1500);
  });
  if (typeof navigator.share === "function") {
    $("#share").hidden = false;
    $("#share").addEventListener("click", () => { void navigator.share({ title: vod.name, url: link.value }).catch(() => undefined); });
  }
  $<HTMLAnchorElement>("#raw").href = vod.play;
  $<HTMLAnchorElement>("#nixamp").href = `https://nixamp.com/?play=${encodeURIComponent(vod.play)}`;
  // The guide's look may be a minute old or blocked where this browser is not: try it either way.
  chip("vod", vod.kind === "video" ? "On demand · video" : "On demand · audio");
  const player = createPlayer($("#stage"), {
    src: vod.play,
    kind: vod.kind === "video" ? "mp4" : "audio",
    audio: vod.kind === "audio",
    live: false,
    // Picks up where this browser left off, unless the link says where to start.
    mediaId: `nixamp-vod:${vod.id}`,
    startAt: parseTimeParam(new URLSearchParams(location.search).get("t")),
    shareUrl: (seconds) => `${vod.page}?t=${formatTimeParam(seconds)}`,
    unplayableAdvice: "Open in another player (VLC can) with the link below.",
  });
  player.media.addEventListener("error", () => chip("unavailable", vod.available ? "Could not play it here" : "Its server is not answering"));
}

async function all(): Promise<void> {
  $("#all").hidden = false;
  const answer = await fetch("/api/v1/guide/vods", { cache: "no-store" }).catch(() => null);
  const vods = answer?.ok ? ((await answer.json()) as { vods: Card[] }).vods : [];
  const list = $("#list");
  for (const vod of vods) {
    const a = document.createElement("a");
    a.href = new URL(vod.page).pathname;
    const name = document.createElement("div");
    name.className = "vod-name";
    name.textContent = vod.name;
    const meta = document.createElement("div");
    meta.className = "vod-meta";
    meta.textContent = [vod.kind === "video" ? "Video" : "Audio", vod.nowPlaying?.title, vod.nowPlaying?.artist, vod.state === "offline" ? "not answering" : ""].filter(Boolean).join(" · ");
    a.append(name, meta);
    const li = document.createElement("li");
    li.append(a);
    list.append(li);
  }
  $("#none").hidden = vods.length > 0;
}

void (id ? one() : all());

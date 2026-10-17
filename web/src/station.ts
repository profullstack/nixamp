/**
 * A station's page: what a listener's link opens. It reads its id and token
 * from its own address, and plays the station in @profullstack/player, the
 * same control bar (full screen, volume, picture-in-picture) as every other
 * Profullstack site, with a TV station's picture or a radio station's sound.
 */
import { createPlayer, type PlayerHandle } from "@profullstack/player";
import "@profullstack/player/player.css";
import "./styles.css";
import "./station.css";

interface NowPlaying { title: string; artist: string; album: string }
interface StationState {
  name: string;
  description: string;
  state: "live" | "starting" | "recovering" | "stopped" | "offline" | string;
  nowPlaying: NowPlaying | null;
  kind: "audio" | "video";
}

const id = location.pathname.split("/").filter(Boolean)[1] ?? "";
const token = new URLSearchParams(location.search).get("t") ?? "";
const q = "?t=" + encodeURIComponent(token);
const api = "/api/v1/stations/" + encodeURIComponent(id);
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

let player: PlayerHandle | null = null;
let kind: "audio" | "video" | null = null;
let last: StationState | null = null;
let events = false;
let retry = 0;
let timer = 0;
let pausedAt = 0;
/** The listener pressed play and has not paused: a dropped stream is joined again. */
let wanted = false;

const chip = (state: string, text: string): void => {
  const c = $("#state");
  c.className = "station-chip " + state;
  c.textContent = text;
};
const say = (text: string): void => { $("#announce").textContent = text; };

const title = (s: StationState): void => {
  const playing = s.nowPlaying;
  $("#title").textContent = playing ? (playing.title || "Untitled") : (s.state === "live" ? "On the air" : "");
  $("#by").textContent = playing ? [playing.artist, playing.album].filter(Boolean).join(" · ") : "";
};

/** A fresh request is always the live edge: never a cached or paused one. */
const mount = (autoplay: boolean): void => {
  player?.destroy();
  const video = kind === "video";
  player = createPlayer($("#stage"), {
    src: api + "/stream" + q + "&n=" + Date.now(),
    kind: video ? "mp4" : "audio",
    audio: !video,
    live: true,
    autoplay,
  });
  const media = player.media;
  media.addEventListener("playing", () => { if (retry) say("Back on"); retry = 0; if (last) draw(last); });
  media.addEventListener("error", again);
  media.addEventListener("ended", again);
  media.addEventListener("stalled", () => { if (media.readyState < 3) again(); });
  // A station does not wait for anyone: playing again after a pause joins
  // where it is now, not where this page left it.
  media.addEventListener("pause", () => {
    if (media.ended || media.error) return;
    wanted = false;
    pausedAt = Date.now();
  });
  media.addEventListener("play", () => {
    wanted = true;
    if (pausedAt && Date.now() - pausedAt > 3000) { pausedAt = 0; mount(true); }
  });
};

function again(): void {
  if (!player || !wanted) return;
  retry += 1;
  if (last) draw(last);
  clearTimeout(timer);
  timer = window.setTimeout(() => mount(true), Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
}

function draw(s: StationState): void {
  last = s;
  document.title = s.name + " · nixamp";
  $("#name").textContent = s.name;
  $("#about").textContent = s.description || "";
  $("#about").hidden = !s.description;
  if (!events) title(s);
  const onAir = s.state === "live" || s.state === "recovering" || s.state === "starting";
  if (retry > 0) chip("reconnecting", "Reconnecting");
  else if (s.state === "live") chip("live", "Live");
  else if (s.state === "starting" || s.state === "recovering") chip("reconnecting", "Coming back");
  else if (s.state === "stopped") chip("stopped", "Off the air");
  else chip("unavailable", "Unavailable");
  $<HTMLAnchorElement>("#m3u").href = api + "/listen.m3u" + q;
  // The player is made once the station says what it carries, and again if
  // that changes (a station turned into TV).
  if (onAir && kind !== s.kind) {
    kind = s.kind;
    mount(wanted);
  }
}

/** What the player holds and has not played yet: a new title waits that long. */
const ahead = (): number => {
  const media = player?.media;
  if (!media || media.paused || media.buffered.length === 0) return 0;
  return Math.max(0, Math.min(30, media.buffered.end(media.buffered.length - 1) - media.currentTime));
};

const poll = async (): Promise<void> => {
  try {
    const r = await fetch(api + "/state" + q, { cache: "no-store" });
    if (r.status === 404) {
      $("#name").textContent = "This station is not available";
      chip("unavailable", "Unavailable");
      player?.destroy();
      player = null;
      kind = null;
      return;
    }
    if (r.ok) draw(await r.json() as StationState);
  } catch {
    // The next poll tries again.
  }
};

const listen = (): void => {
  if (!window.EventSource) return;
  const source = new EventSource(api + "/events" + q);
  source.addEventListener("hello", (e) => { events = true; title(JSON.parse((e as MessageEvent).data) as StationState); });
  source.addEventListener("now", (e) => {
    const s = JSON.parse((e as MessageEvent).data) as StationState;
    setTimeout(() => { title(s); say(s.nowPlaying ? "Now playing " + (s.nowPlaying.title || "") : ""); }, ahead() * 1000);
  });
  source.addEventListener("state", () => void poll());
  source.onerror = () => { events = false; };
};

void poll();
listen();
setInterval(() => void poll(), 5000);

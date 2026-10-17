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
interface TrackFacts {
  title: string; artist: string; album: string; year: string; genre: string;
  ai: { generated: boolean | null; by: string; evidence: string };
  rights: { holder: string; basis: string; note: string; license: string; source: string };
  support: { holder: string; url: string; label: string } | null;
  art?: string;
  lyrics?: string;
}
interface Lyrics { title: string; artist: string; text: string; source: string; language: string }
const BASIS: Record<string, string> = {
  owned: "owned by the station", permission: "broadcast with permission", licensed: "licensed for broadcast",
  "creative-commons": "Creative Commons", "public-domain": "public domain",
};
interface StationState {
  name: string;
  description: string;
  state: "live" | "starting" | "recovering" | "stopped" | "offline" | string;
  nowPlaying: NowPlaying | null;
  kind: "audio" | "video";
  facts?: TrackFacts | null;
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
/** The listener's own mute: the player mutes anything it autoplays, a rejoin must not stay silent. */
let listenerMuted = false;
let blockedTimer = 0;

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

/** Who made it, AI or not, whose copyright, and how to support them. Text only, never HTML. */
const showFacts = (f: TrackFacts | null | undefined): void => {
  const box = $("#facts");
  if (!f) { box.hidden = true; void loadLyrics(""); return; }
  const rows: Array<[string, string]> = [];
  if (f.artist) rows.push(["Artist", f.artist]);
  if (f.album) rows.push(["Album", f.album]);
  if (f.year) rows.push(["Year", f.year]);
  if (f.genre && !/^ai$/i.test(f.genre)) rows.push(["Genre", f.genre]);
  rows.push(["Made with AI", f.ai.generated === true ? `Yes, ${f.ai.by}` : f.ai.generated === false ? "No" : "Not stated"]);
  const holder = f.rights.holder;
  const basis = f.rights.basis ? BASIS[f.rights.basis] ?? f.rights.basis : "";
  rows.push(["Copyright", holder ? `© ${holder}` : basis ? `Not stated (${basis})` : "Not stated"]);
  if (f.rights.license) rows.push(["Licence", f.rights.license]);
  else if (f.rights.note && f.rights.source !== "holder") rows.push(["Rights", f.rights.note]);
  const list = $("#facts-list");
  list.replaceChildren(...rows.flatMap(([name, value]) => {
    const dt = document.createElement("dt"); dt.textContent = name;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  // The track's own cover, here and on the lock screen / media keys.
  const cover = $<HTMLImageElement>("#cover");
  const art = typeof f.art === "string" && f.art.startsWith("/api/v1/stations/") ? f.art : "";
  cover.hidden = !art;
  if (art && cover.getAttribute("src") !== art) {
    cover.src = art;
    cover.alt = `Cover of ${f.title || "this track"}`;
  }
  if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: f.title || last?.name || "nixamp",
      artist: f.artist,
      album: f.album || last?.name || "",
      ...(art ? { artwork: [{ src: new URL(art, location.href).href, sizes: "512x512", type: "image/jpeg" }] } : {}),
    });
  }
  const badge = $("#ai-badge");
  badge.hidden = f.ai.generated !== true;
  badge.textContent = f.ai.generated === true ? "AI-generated" : "";
  badge.title = f.ai.evidence;
  const support = $<HTMLAnchorElement>("#support");
  const url = f.support?.url ?? "";
  support.hidden = !/^https:\/\//.test(url);
  if (!support.hidden) {
    support.href = url;
    support.textContent = `${f.support!.label || "Support"} ${f.support!.holder}`;
  }
  box.hidden = false;
  void loadLyrics(typeof f.lyrics === "string" && f.lyrics.startsWith("/api/v1/stations/") ? f.lyrics : "");
};

/** The words, line by line as written; "[Verse 1]" and the like as small headers. Text only, never HTML. */
const drawLyrics = (words: Lyrics): void => {
  const lines = words.text.split("\n");
  const out: HTMLElement[] = [];
  let stanza: string[] = [];
  const flush = (): void => {
    if (stanza.length === 0) return;
    const p = document.createElement("p");
    p.textContent = stanza.join("\n");
    out.push(p);
    stanza = [];
  };
  for (const line of lines) {
    if (/^\s*\[[^\]]{1,160}\]\s*$/.test(line)) {
      flush();
      const head = document.createElement("p");
      head.className = "station-lyrics-section";
      head.textContent = line.trim().slice(1, -1);
      out.push(head);
    } else if (line.trim() === "") {
      flush();
    } else {
      stanza.push(line);
    }
  }
  flush();
  const box = $("#lyrics-text");
  box.replaceChildren(...out);
  box.lang = /^[a-z]{2,3}$/.test(words.language) ? words.language : "";
  $("#lyrics-for").textContent = words.title ? `· ${words.title}` : "";
  $("#lyrics-source").textContent = words.source === "embedded" ? "From the track itself." : "From nichedb.dev.";
  $("#lyrics").hidden = false;
};

let lyricsAt = "";
const loadLyrics = async (url: string): Promise<void> => {
  if (url === lyricsAt) return;
  lyricsAt = url;
  if (!url) { $("#lyrics").hidden = true; return; }
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (lyricsAt !== url) return;
    if (!r.ok) { $("#lyrics").hidden = true; return; }
    drawLyrics(((await r.json()) as { lyrics: Lyrics }).lyrics);
  } catch {
    if (lyricsAt === url) lyricsAt = "";
  }
};

// Open beside the player on a wide screen; folded on a phone, where it would push everything else away.
if (window.matchMedia?.("(max-width: 640px)").matches) $<HTMLDetailsElement>("#lyrics-box").open = false;

const loadFacts = async (): Promise<void> => {
  try {
    const r = await fetch(api + "/now" + q, { cache: "no-store" });
    if (r.ok) showFacts(((await r.json()) as { facts: TrackFacts | null }).facts);
  } catch {
    // The next track says it again.
  }
};

/** Let go of the player. It is forgotten first, so the pause its teardown fires is not taken for the listener's. */
const unmount = (): void => {
  const old = player;
  player = null;
  old?.destroy();
};

/** A fresh request is always the live edge: never a cached or paused one. */
const mount = (autoplay: boolean): void => {
  unmount();
  const video = kind === "video";
  const current = createPlayer($("#stage"), {
    src: api + "/stream" + q + "&n=" + Date.now(),
    kind: video ? "mp4" : "audio",
    audio: !video,
    live: true,
    autoplay,
  });
  player = current;
  const media = current.media;
  // Events from a player already replaced (a rejoin, a teardown) say nothing about this one.
  const mine = (): boolean => player === current;
  // The player mutes what it autoplays; a listener rejoining hears it as they left it.
  let restoring = autoplay;
  media.addEventListener("volumechange", () => { if (mine() && !restoring) listenerMuted = media.muted; });
  media.addEventListener("playing", () => {
    if (!mine()) return;
    clearTimeout(blockedTimer);
    if (restoring) { restoring = false; media.muted = listenerMuted; }
    if (retry) say("Back on");
    retry = 0;
    if (last) draw(last);
  });
  media.addEventListener("error", () => { if (mine()) again(); });
  media.addEventListener("ended", () => { if (mine()) again(); });
  media.addEventListener("stalled", () => { if (mine() && media.readyState < 3) again(); });
  // A station does not wait for anyone: playing again after a pause joins
  // where it is now, not where this page left it.
  media.addEventListener("pause", () => {
    if (!mine() || media.ended || media.error) return;
    if (restoring) return; // a refused autoplay, not the listener
    wanted = false;
    pausedAt = Date.now();
  });
  media.addEventListener("play", () => {
    if (!mine()) return;
    wanted = true;
    if (pausedAt && Date.now() - pausedAt > 3000) { pausedAt = 0; mount(true); }
  });
  // A browser that refuses to start sound on its own (iPhone) needs one tap; say so instead of spinning.
  clearTimeout(blockedTimer);
  if (autoplay) {
    blockedTimer = window.setTimeout(() => {
      if (!mine() || !media.paused) return;
      chip("reconnecting", "Tap play to rejoin");
      say("The station is back. Press play to rejoin.");
    }, 8000);
  }
};

function again(): void {
  if (!wanted) return;
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
      // Also what a restarting server says for a moment: keep wanting it, so it is joined when it is back.
      unmount();
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
  source.addEventListener("hello", (e) => {
    events = true;
    const s = JSON.parse((e as MessageEvent).data) as StationState;
    title(s);
    if (s.facts !== undefined) showFacts(s.facts); else void loadFacts();
  });
  source.addEventListener("now", (e) => {
    const s = JSON.parse((e as MessageEvent).data) as StationState;
    setTimeout(() => { title(s); showFacts(s.facts); say(s.nowPlaying ? "Now playing " + (s.nowPlaying.title || "") : ""); }, ahead() * 1000);
  });
  source.addEventListener("state", () => void poll());
  source.onerror = () => { events = false; };
};

void poll();
void loadFacts();
listen();
setInterval(() => void poll(), 5000);

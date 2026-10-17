/**
 * The page a station's link opens: its name, what is on, and Play.
 *
 * Served by the station's own server, without the server's key, because the
 * link is the key: the page reads `t` from its own address and asks the
 * station's state and stream with it. Nothing about the station is written
 * into the HTML, so the page is the same bytes for every station and can be
 * locked down with a content security policy naming its script and style by
 * hash. A private station, or a wrong link, shows "not available" -- the
 * same answer, so the page cannot be used to find out which stations exist.
 */
import { createHash } from "node:crypto";

const STYLE = `
:root{--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--card:#fff;--line:#dedcd6;--accent:#1f6feb;--live:#0b7a3b;--warn:#9a6700;--off:#8c2f39}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececf1;--muted:#a4a4b0;--card:#1c1c20;--line:#2c2c33;--accent:#6aa7ff;--live:#3fbf7f;--warn:#e3b341;--off:#f0838f}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 4px}
.about{color:var(--muted);margin:0 0 20px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:.85rem;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line)}
.chip::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.live{color:var(--live)}.reconnecting{color:var(--warn)}.unavailable,.stopped{color:var(--off)}
.now{margin:20px 0;min-height:3em}.now .title{font-weight:600}.now .by{color:var(--muted)}
.controls{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:12px 28px;background:var(--accent);color:#fff;cursor:pointer;min-width:120px}
button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.9rem}
input[type=range]{width:120px;accent-color:var(--accent)}
.small{margin-top:20px;font-size:.85rem;color:var(--muted)}.small a{color:inherit}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.live::before{animation:pulse 2s ease-in-out infinite}}
@keyframes pulse{50%{opacity:.35}}
`;

const SCRIPT = `
(() => {
  const id = location.pathname.split("/").filter(Boolean)[1] || "";
  const token = new URLSearchParams(location.search).get("t") || "";
  const q = "?t=" + encodeURIComponent(token);
  const api = "/api/v1/stations/" + encodeURIComponent(id);
  const $ = (s) => document.querySelector(s);
  const audio = new Audio();
  audio.preload = "none";
  let wanted = false, retry = 0, timer = 0, last = null, live = false;
  const chip = (state, text) => { const c = $("#state"); c.className = "chip " + state; c.textContent = text; };
  const say = (text) => { $("#announce").textContent = text; };
  const draw = (s) => {
    last = s;
    document.title = s.name + " · nixamp";
    $("#name").textContent = s.name;
    $("#about").textContent = s.description || "";
    $("#about").hidden = !s.description;
    if (!live) title(s);
    if (wanted && retry > 0) chip("reconnecting", "Reconnecting");
    else if (s.state === "live") chip("live", "Live");
    else if (s.state === "starting" || s.state === "recovering") chip("reconnecting", "Coming back");
    else if (s.state === "stopped") chip("stopped", "Off the air");
    else chip("unavailable", "Unavailable");
    $("#play").disabled = !(s.state === "live" || s.state === "recovering" || s.state === "starting");
    $("#m3u").href = api + "/listen.m3u" + q;
  };
  const title = (s) => {
    const playing = s.nowPlaying;
    $("#title").textContent = playing ? (playing.title || "Untitled") : (s.state === "live" ? "On the air" : "");
    $("#by").textContent = playing ? [playing.artist, playing.album].filter(Boolean).join(" · ") : "";
  };
  // What is ahead of the speaker: the sound the player holds and has not
  // played yet. A new title waits that long, so it changes with the song.
  const ahead = () => {
    if (!wanted || audio.paused || audio.buffered.length === 0) return 0;
    return Math.max(0, Math.min(30, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime));
  };
  const listen = () => {
    if (!window.EventSource) return;
    const events = new EventSource(api + "/events" + q);
    events.addEventListener("hello", (e) => { live = true; title(JSON.parse(e.data)); });
    events.addEventListener("now", (e) => {
      const s = JSON.parse(e.data);
      setTimeout(() => { title(s); say(s.nowPlaying ? "Now playing " + (s.nowPlaying.title || "") : ""); }, ahead() * 1000);
    });
    events.addEventListener("state", () => poll());
    events.onerror = () => { live = false; };
  };
  const poll = async () => {
    try {
      const r = await fetch(api + "/state" + q, { cache: "no-store" });
      if (r.status === 404) { $("#name").textContent = "This station is not available"; chip("unavailable", "Unavailable"); $("#play").disabled = true; stop(); return; }
      if (r.ok) draw(await r.json());
    } catch {}
  };
  // Always the live edge: a fresh request, never a cached or paused one.
  const join = () => { audio.src = api + "/stream" + q + "&n=" + Date.now(); audio.play().catch(() => { wanted = false; button(); }); };
  const stop = () => { wanted = false; clearTimeout(timer); audio.pause(); audio.removeAttribute("src"); audio.load(); button(); };
  const button = () => { const b = $("#play"); b.textContent = wanted ? "Stop" : "Play"; b.setAttribute("aria-pressed", String(wanted)); };
  const again = () => {
    if (!wanted) return;
    retry += 1;
    if (last) draw(last);
    clearTimeout(timer);
    timer = setTimeout(join, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));
  };
  audio.addEventListener("playing", () => { if (retry) say("Back on"); retry = 0; if (last) draw(last); });
  audio.addEventListener("error", again);
  audio.addEventListener("ended", again);
  audio.addEventListener("stalled", () => { if (wanted && audio.readyState < 3) again(); });
  $("#play").addEventListener("click", () => { if (wanted) { stop(); say("Stopped"); } else { wanted = true; retry = 0; button(); join(); say("Playing"); } });
  $("#volume").addEventListener("input", (e) => { audio.volume = Number(e.target.value); });
  poll();
  listen();
  setInterval(poll, 5000);
})();
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>Station · nixamp</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="card">
    <span id="state" class="chip unavailable" role="status">Loading</span>
    <h1 id="name">&nbsp;</h1>
    <p id="about" class="about" hidden></p>
    <div class="now" aria-live="polite"><div id="title" class="title"></div><div id="by" class="by"></div></div>
    <div class="controls">
      <button id="play" type="button" aria-pressed="false" disabled>Play</button>
      <label>Volume <input id="volume" type="range" min="0" max="1" step="0.05" value="1"></label>
    </div>
    <p class="small"><a id="m3u" href="#">Open in another player (.m3u)</a> · Pausing here does not pause the station.</p>
  </div>
  <p class="small">Played by <a href="https://nixamp.com">nixamp</a>.</p>
  <div id="announce" class="sr" aria-live="assertive"></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** A station page's path: /station/<id>. */
export const STATION_PAGE = /^\/station\/([a-z0-9]{10})\/?$/;

export const STATION_PAGE_HTML = PAGE;

/** Only its own script and style, only its own server, never framed. */
export const STATION_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "connect-src 'self'",
  "media-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

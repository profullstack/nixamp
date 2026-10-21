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
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 4px}
.about{color:var(--muted);margin:0 0 20px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:.85rem;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line)}
.chip::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.live{color:var(--live)}.reconnecting{color:var(--warn)}.unavailable,.stopped{color:var(--off)}
.now{margin:20px 0;min-height:3em}.now .title{font-weight:600}.now .by{color:var(--muted)}
.controls{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.play{display:inline-block;font-weight:600;border-radius:999px;padding:12px 28px;background:var(--accent);color:#fff;text-decoration:none;cursor:pointer}
.play[aria-disabled=true]{opacity:.5;pointer-events:none}
a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.small{margin-top:20px;font-size:.85rem;color:var(--muted)}.small a{color:inherit}
.lyrics{margin:20px 0 0;border-top:1px solid var(--line);padding-top:12px}
.lyrics summary{cursor:pointer;font-weight:600;min-height:24px}
.lyrics .for{font-weight:400;color:var(--muted);font-size:.9rem}
.words{margin-top:10px;line-height:1.6}
.words p{margin:0 0 1em;white-space:pre-wrap;overflow-wrap:anywhere}
.words p.sec{margin:1.2em 0 .3em;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.words p.sec:first-child{margin-top:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.live::before{animation:pulse 2s ease-in-out infinite}}
@keyframes pulse{50%{opacity:.35}}
`;

const SCRIPT = `
(() => {
  // /radio/<name> is the same station through a public name: its own paths, no token in sight.
  const radio = /^\/radio\/[a-z0-9-]+\/?$/.test(location.pathname);
  const id = location.pathname.split("/").filter(Boolean)[1] || "";
  const token = new URLSearchParams(location.search).get("t") || "";
  const q = radio ? "" : "?t=" + encodeURIComponent(token);
  const api = radio ? location.pathname.replace(/\/+$/, "") : "/api/v1/stations/" + encodeURIComponent(id);
  const $ = (s) => document.querySelector(s);
  // No media element here: every player in the fleet is @profullstack/player,
  // and this page has no bundle to carry it. Play hands the station to the
  // listener's own player through its .m3u; the built page plays in place.
  let live = false;
  const chip = (state, text) => { const c = $("#state"); c.className = "chip " + state; c.textContent = text; };
  const say = (text) => { $("#announce").textContent = text; };
  const draw = (s) => {
    document.title = s.name + " · nixamp";
    $("#name").textContent = s.name;
    $("#about").textContent = s.description || "";
    $("#about").hidden = !s.description;
    if (!live) title(s);
    if (s.state === "live") chip("live", "Live");
    else if (s.state === "starting" || s.state === "recovering") chip("reconnecting", "Coming back");
    else if (s.state === "stopped") chip("stopped", "Off the air");
    else chip("unavailable", "Unavailable");
    const on = s.state === "live" || s.state === "recovering" || s.state === "starting";
    $("#play").href = api + "/listen.m3u" + q;
    $("#play").setAttribute("aria-disabled", String(!on));
  };
  const title = (s) => {
    const playing = s.nowPlaying;
    $("#title").textContent = playing ? (playing.title || "Untitled") : (s.state === "live" ? "On the air" : "");
    $("#by").textContent = playing ? [playing.artist, playing.album].filter(Boolean).join(" · ") : "";
  };
  // The words of what is on, line by line; "[Verse 1]" as a small header. Text only, never HTML.
  let words = null;
  const lyrics = async () => {
    try {
      const r = await fetch(api + "/lyrics" + q, { cache: "no-store" });
      const got = r.ok ? (await r.json()).lyrics : null;
      const key = got ? got.title + "\\n" + got.text : "";
      if (key === words) return;
      words = key;
      $("#lyrics").hidden = !got;
      if (!got) return;
      const out = [];
      let stanza = [];
      const flush = () => { if (stanza.length) { const p = document.createElement("p"); p.textContent = stanza.join("\\n"); out.push(p); stanza = []; } };
      for (const line of got.text.split("\\n")) {
        if (/^\\s*\\[[^\\]]{1,160}\\]\\s*$/.test(line)) { flush(); const h = document.createElement("p"); h.className = "sec"; h.textContent = line.trim().slice(1, -1); out.push(h); }
        else if (line.trim() === "") flush();
        else stanza.push(line);
      }
      flush();
      $("#words").replaceChildren(...out);
      $("#lyrics-for").textContent = got.title ? " · " + got.title : "";
    } catch {}
  };
  const listen = () => {
    if (!window.EventSource) return;
    const events = new EventSource(api + "/events" + q);
    events.addEventListener("hello", (e) => { live = true; title(JSON.parse(e.data)); lyrics(); });
    events.addEventListener("now", (e) => {
      const s = JSON.parse(e.data);
      title(s); lyrics(); say(s.nowPlaying ? "Now playing " + (s.nowPlaying.title || "") : "");
    });
    events.addEventListener("state", () => poll());
    events.onerror = () => { live = false; };
  };
  const poll = async () => {
    try {
      const r = await fetch(api + "/state" + q, { cache: "no-store" });
      if (r.status === 404) { $("#name").textContent = "This station is not available"; chip("unavailable", "Unavailable"); $("#play").removeAttribute("href"); $("#play").setAttribute("aria-disabled", "true"); return; }
      if (r.ok) draw(await r.json());
    } catch {}
  };
  if (window.matchMedia && matchMedia("(max-width: 640px)").matches) $("#lyrics-box").open = false;
  poll();
  lyrics();
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
      <a id="play" class="play" aria-disabled="true">Play in your player (.m3u)</a>
    </div>
    <section id="lyrics" class="lyrics" aria-label="Lyrics" hidden>
      <details id="lyrics-box" open><summary>Lyrics<span id="lyrics-for" class="for"></span></summary><div id="words" class="words"></div></details>
    </section>
    <p class="small">This server was started without the web build, so the station plays in VLC, mpv or any player that opens an .m3u. Run <code>bun run web:build</code> to play it on this page.</p>
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
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The built page: its own bundle, styles and player engines, only this server, never framed. */
/**
 * A live room's page (/watch): the same built page shape, but what it plays and
 * asks about is on the room's own server, any https nixamp server.
 */
export const WATCH_APP_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const STATION_APP_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  // nixamp.com for a listen pass, so a signed-in listener's breaks go quiet.
  "connect-src 'self' https://nixamp.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

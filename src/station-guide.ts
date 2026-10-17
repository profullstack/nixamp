/**
 * The station guide: every station on this server its owner made public
 * and listed, what is on each, and a way in. What a Moshpit name like
 * live.streaming opens.
 *
 * Like the station page, the same bytes for every server: it asks
 * /api/v1/stations/guide for the list and writes it in as text.
 */
import { createHash } from "node:crypto";
import { readConfig } from "./library.ts";

const STYLE = `
:root{--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--card:#fff;--line:#dedcd6;--accent:#1f6feb;--live:#0b7a3b;--warn:#a1460b}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececf1;--muted:#a4a4b0;--card:#1c1c20;--line:#2c2c33;--accent:#6aa7ff;--live:#3fbf7f;--warn:#f0a35e}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 16px}
h1{margin:0 0 4px;font-size:1.8rem}p.lead{color:var(--muted);margin:0 0 24px}
h2{font-size:1rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;position:relative}
.card:hover,.card:focus-within{border-color:var(--accent)}
a.station{color:inherit;text-decoration:none;display:block}a.station:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:6px}
.name{font-weight:700;font-size:1.05rem}.now{color:var(--muted);font-size:.9rem;margin-top:6px;min-height:1.4em}
.live{color:var(--live);font-size:.8rem;font-weight:700}.empty{color:var(--muted)}
button.report{margin-top:10px;background:none;border:0;padding:0;color:var(--muted);font:inherit;font-size:.8rem;text-decoration:underline;cursor:pointer}
button.report:hover{color:var(--warn)}
#share{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:12px}
#share label{display:block;font-size:.9rem;margin:10px 0 4px;color:var(--muted)}
#share input[type=url],#share input[type=text],#share select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
#share .agree{display:flex;gap:8px;align-items:flex-start;color:var(--fg);margin-top:12px}
#share button[type=submit]{margin-top:14px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}
#share .or{color:var(--muted);font-size:.85rem;margin:8px 0 0}
#status{margin-top:10px;font-size:.9rem;min-height:1.4em}
footer{margin-top:40px;color:var(--muted);font-size:.85rem}footer a{color:inherit}
`;

const SCRIPT = `
(async () => {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const say = (text) => { document.querySelector("#status").textContent = text; };
  const report = async (id, button) => {
    if (!confirm("Report the track playing now? It comes off the air until the owner looks at it.")) return;
    button.disabled = true;
    try {
      const r = await fetch("/api/v1/share/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ station: id }) });
      const body = await r.json();
      button.textContent = body.reported ? "Reported: off the air" : "Nothing shared is playing";
    } catch { button.textContent = "Could not report; try again"; button.disabled = false; }
  };
  const draw = (stations) => {
    for (const group of ["ai", "shared", "radio", "tv"]) {
      const grid = document.querySelector("#" + group);
      grid.replaceChildren();
      const list = stations.filter((s) => (s.group || (s.kind === "video" ? "tv" : "radio")) === group);
      document.querySelector("#" + group + "-title").hidden = list.length === 0;
      for (const s of list) {
        const card = el("div", "card");
        const a = el("a", "station");
        a.href = s.page;
        a.append(el("div", "live", s.state === "live" ? "● LIVE" : "off the air"), el("div", "name", s.name),
          el("div", "now", s.nowPlaying ? [s.nowPlaying.title, s.nowPlaying.artist].filter(Boolean).join(" — ") : ""));
        card.append(a);
        if (group === "shared") {
          const b = el("button", "report", "Report this track");
          b.type = "button";
          b.addEventListener("click", () => report(s.id, b));
          card.append(b);
        }
        grid.append(card);
      }
    }
    document.querySelector("#empty").hidden = stations.length > 0;
  };
  const load = async () => {
    try {
      const r = await fetch("/api/v1/stations/guide", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) draw((await r.json()).stations);
    } catch {}
  };
  const watch = async (status) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((done) => setTimeout(done, 3000));
      try {
        const share = (await (await fetch(status, { cache: "no-store" })).json()).share;
        if (!share) return;
        const words = { fetching: "Fetching it…", checking: "Listening to it and checking it…", held: "Waiting for the owner to look at it", approved: "On the air", rejected: "Not accepted", failed: "Could not use it", withdrawn: "Withdrawn", reported: "Reported" };
        say((words[share.state] || share.state) + (share.genre ? " · " + share.genre : "") + (share.reason ? " — " + share.reason : ""));
        if (!["fetching", "checking"].includes(share.state)) { load(); return; }
      } catch {}
    }
  };
  const form = document.querySelector("#share");
  try {
    const info = await (await fetch("/api/v1/share", { cache: "no-store" })).json();
    if (info.open) {
      document.querySelector("#share-title").hidden = false;
      form.hidden = false;
      document.querySelector("#max").textContent = info.maxMb + " MB";
    }
  } catch {}
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const file = data.get("file");
    const link = String(data.get("url") || "").trim();
    const fields = { basis: String(data.get("basis") || ""), note: String(data.get("note") || ""), by: String(data.get("by") || ""), agree: data.get("agree") ? "1" : "" };
    if (!fields.agree) { say("Tick the box to confirm you have the right to share it."); return; }
    if (!link && !(file && file.size)) { say("Paste a link to an MP3, or choose a file."); return; }
    say(file && file.size && !link ? "Uploading…" : "Sending…");
    try {
      const r = file && file.size && !link
        ? await fetch("/api/v1/share/upload?" + new URLSearchParams({ ...fields, name: file.name }), { method: "PUT", headers: { "content-type": file.type || "audio/mpeg" }, body: file })
        : await fetch("/api/v1/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, agree: true, url: link }) });
      const body = await r.json();
      if (!r.ok) { say(body.error || "That did not work."); return; }
      form.reset();
      say("Got it. Checking it now…");
      watch(body.status);
    } catch { say("Could not reach the station; try again."); }
  });
  await load();
  setInterval(load, 15000);
})();
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

export interface GuideEntry {
  id?: string;
  name: string;
  kind: "audio" | "video";
  /** ai, shared, radio or tv; from kind when absent. */
  group?: "ai" | "shared" | "radio" | "tv";
  state: string;
  page: string;
  nowPlaying: { title: string; artist: string } | null;
}

const GROUPS = ["ai", "shared", "radio", "tv"] as const;

/**
 * The guide with its stations already in it, so it reads the same through a
 * gateway that cannot run its script against this server (the Moshpit's
 * /n/<name>), and for a crawler. Everything from a station is escaped.
 */
export function renderGuide(entries: GuideEntry[]): string {
  const groupOf = (one: GuideEntry): string => one.group ?? (one.kind === "video" ? "tv" : "radio");
  const cards = (group: string): string => entries
    .filter((one) => groupOf(one) === group && /^https?:\/\//.test(one.page))
    .map((one) => `<div class="card"><a class="station" href="${escape(one.page)}"><div class="live">${one.state === "live" ? "● LIVE" : "off the air"}</div><div class="name">${escape(one.name)}</div><div class="now">${one.nowPlaying ? escape([one.nowPlaying.title, one.nowPlaying.artist].filter(Boolean).join(" — ")) : ""}</div></a></div>`)
    .join("");
  let page = GUIDE_HTML;
  for (const group of GROUPS) {
    const made = cards(group);
    page = page
      .replace(`<h2 id="${group}-title" hidden>`, made ? `<h2 id="${group}-title">` : `<h2 id="${group}-title" hidden>`)
      .replace(`<div id="${group}" class="grid" aria-live="polite"></div>`, `<div id="${group}" class="grid" aria-live="polite">${made}</div>`);
  }
  return page.replace('<p id="empty" class="empty">', entries.length ? '<p id="empty" class="empty" hidden>' : '<p id="empty" class="empty">');
}

export const GUIDE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live · stations</title>
<meta name="description" content="Radio and TV stations, live now: AI-composed music, tracks shared by listeners, and more.">
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Live</h1>
  <p class="lead">Radio and TV, on the air now. Pick one and press play.</p>
  <h2 id="ai-title" hidden>AI Radio</h2>
  <div id="ai" class="grid" aria-live="polite"></div>
  <h2 id="shared-title" hidden>Shared by listeners</h2>
  <div id="shared" class="grid" aria-live="polite"></div>
  <h2 id="radio-title" hidden>Radio</h2>
  <div id="radio" class="grid" aria-live="polite"></div>
  <h2 id="tv-title" hidden>TV</h2>
  <div id="tv" class="grid" aria-live="polite"></div>
  <p id="empty" class="empty">Nothing is on the air here yet.</p>
  <h2 id="share-title" hidden>Share a track</h2>
  <form id="share" hidden>
    <label for="url">A link to an MP3</label>
    <input id="url" name="url" type="url" placeholder="https://example.com/my-song.mp3" inputmode="url">
    <p class="or">or upload one (up to <span id="max">60 MB</span>)</p>
    <input id="file" name="file" type="file" accept="audio/*,.mp3,.ogg,.flac,.m4a,.wav">
    <label for="basis">Why it may be broadcast</label>
    <select id="basis" name="basis" required>
      <option value="owned">I made it</option>
      <option value="permission">I have the artist's permission</option>
      <option value="licensed">It is licensed for broadcast</option>
      <option value="creative-commons">It is Creative Commons (allows sharing)</option>
      <option value="public-domain">It is in the public domain</option>
    </select>
    <label for="note">Anything we should know (licence, link to the artist)</label>
    <input id="note" name="note" type="text" maxlength="300">
    <label for="by">Credit me as (optional)</label>
    <input id="by" name="by" type="text" maxlength="60">
    <label class="agree"><input type="checkbox" name="agree" value="1"> I have the right to share this for broadcast here. AI files it under a genre and checks it before it airs; anything can be reported off the air.</label>
    <button type="submit">Share it</button>
    <div id="status" role="status" aria-live="polite"></div>
  </form>
  <footer>Played by <a href="https://nixamp.com">nixamp</a>, on the Moshpit.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

export const GUIDE_CSP = [
  "default-src 'none'", `script-src ${hash(SCRIPT)}`, `style-src ${hash(STYLE)}`, "connect-src 'self'",
  "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

/**
 * The hosts whose front page is the guide: `guideHosts` in config.json
 * (`nixamp station guide-host NAME`, which survives restarts and updates),
 * plus NIXAMP_GUIDE_HOSTS, comma-separated.
 */
export function guideHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const saved = (() => { try { return readConfig().guideHosts ?? []; } catch { return []; } })();
  return new Set([...(env["NIXAMP_GUIDE_HOSTS"] ?? "").split(","), ...saved].map((one) => one.trim().toLowerCase()).filter(Boolean));
}

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
:root{--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--card:#fff;--line:#dedcd6;--accent:#1f6feb;--live:#0b7a3b}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececf1;--muted:#a4a4b0;--card:#1c1c20;--line:#2c2c33;--accent:#6aa7ff;--live:#3fbf7f}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:880px;margin:0 auto;padding:40px 16px}
h1{margin:0 0 4px;font-size:1.8rem}p.lead{color:var(--muted);margin:0 0 24px}
h2{font-size:1rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
a.station{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;color:inherit;text-decoration:none}
a.station:hover,a.station:focus-visible{border-color:var(--accent);outline:none}
.name{font-weight:700;font-size:1.05rem}.now{color:var(--muted);font-size:.9rem;margin-top:6px;min-height:1.4em}
.live{color:var(--live);font-size:.8rem;font-weight:700}.empty{color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:.85rem}footer a{color:inherit}
`;

const SCRIPT = `
(async () => {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const draw = (stations) => {
    for (const [kind, box] of [["audio", "#radio"], ["video", "#tv"]]) {
      const grid = document.querySelector(box);
      grid.replaceChildren();
      const list = stations.filter((s) => s.kind === kind);
      document.querySelector(box + "-title").hidden = list.length === 0;
      for (const s of list) {
        const a = el("a", "station");
        a.href = s.page;
        a.append(el("div", "live", s.state === "live" ? "● LIVE" : "off the air"), el("div", "name", s.name),
          el("div", "now", s.nowPlaying ? [s.nowPlaying.title, s.nowPlaying.artist].filter(Boolean).join(" — ") : ""));
        grid.append(a);
      }
    }
    document.querySelector("#empty").hidden = stations.length > 0;
  };
  const load = async () => {
    try {
      const r = await fetch("/api/v1/stations/guide", { cache: "no-store" });
      if (r.ok) draw((await r.json()).stations);
    } catch {}
  };
  await load();
  setInterval(load, 15000);
})();
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const GUIDE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live · stations</title>
<meta name="description" content="Radio and TV stations, live now.">
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Live</h1>
  <p class="lead">Radio and TV, on the air now. Pick one and press play.</p>
  <h2 id="radio-title" hidden>Radio</h2>
  <div id="radio" class="grid" aria-live="polite"></div>
  <h2 id="tv-title" hidden>TV</h2>
  <div id="tv" class="grid" aria-live="polite"></div>
  <p id="empty" class="empty">Nothing is on the air here yet.</p>
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

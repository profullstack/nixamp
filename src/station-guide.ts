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
.name{font-weight:700;font-size:1.05rem;overflow-wrap:anywhere}.now{color:var(--muted);font-size:.9rem;margin-top:6px;min-height:1.4em;overflow-wrap:anywhere}
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
nav.top{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}nav.top a{border:1px solid var(--line);border-radius:999px;padding:4px 12px;text-decoration:none;color:var(--fg);background:var(--card);font-weight:600;font-size:.9rem}nav.top a:hover{border-color:var(--accent)}
footer{margin-top:40px;color:var(--muted);font-size:.85rem}footer a{color:inherit}
.ad-unit{margin:0 auto 16px;display:flex;justify-content:center}.ad-unit iframe{border:0;display:block;background:transparent}
.ad-banner_300x250 iframe{width:300px;height:250px;max-width:100%}.ad-text_link iframe{width:100%;height:40px}
`;

/**
 * A card's now-playing line from tags as they come: links pasted into a title
 * (archive.org films carry their item URL) go, and "A;B" artists read "A, B".
 * The page's script carries this same function, so both renders agree.
 */
export function nowLine(now: { title: string; artist: string } | null | undefined): string {
  if (!now) return "";
  const title = String(now.title || "").replace(/\s*[-–—|]?\s*https?:\/\/\S+/g, "").trim();
  const artist = String(now.artist || "").split(/\s*;\s*/).filter(Boolean).join(", ");
  return [title, artist].filter(Boolean).join(" — ");
}

const SCRIPT = `
(async () => {
  const nowLine = ${nowLine.toString()};
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const say = (text) => { document.querySelector("#status").textContent = text; };
  // This server's own address: through a gateway (pit.moshcode.sh/n/...) the
  // page's origin is not the server's, and a relative fetch would ask the gateway.
  const API = document.body.dataset.api || "";
  const report = async (s, button) => {
    // Click twice: a sandboxed page (the gateway's) cannot open confirm().
    if (button.dataset.armed !== "1") { button.dataset.armed = "1"; button.textContent = "Click again to take it off the air"; return; }
    button.disabled = true;
    try {
      const r = await fetch(new URL(s.page).origin + "/api/v1/share/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ station: s.id }) });
      const body = await r.json();
      button.textContent = body.reported ? "Reported: off the air" : "Nothing shared is playing";
    } catch { button.textContent = "Could not report; try again"; button.disabled = false; }
  };
  const draw = (stations) => {
    for (const group of ["rooms", "vod", "ai", "shared", "radio", "tv"]) {
      const grid = document.querySelector("#" + group);
      grid.replaceChildren();
      const list = stations.filter((s) => (s.group || (s.kind === "video" ? "tv" : "radio")) === group);
      document.querySelector("#" + group + "-title").hidden = list.length === 0;
      for (const s of list) {
        const card = el("div", "card");
        const a = el("a", "station");
        a.href = s.radio || s.page;
        a.append(el("div", "live", s.state === "live" ? "● LIVE" : s.state === "vod" ? "▶ ON DEMAND" : "off the air"), el("div", "name", s.name),
          el("div", "now", nowLine(s.nowPlaying)));
        card.append(a);
        if (group === "shared") {
          const b = el("button", "report", "Report this track");
          b.type = "button";
          b.addEventListener("click", () => report(s, b));
          card.append(b);
        }
        grid.append(card);
      }
    }
    document.querySelector("#empty").hidden = stations.length > 0;
  };
  const load = async () => {
    try {
      const r = await fetch(API + "/api/v1/stations/guide?radio=1", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) draw((await r.json()).stations);
    } catch {}
  };
  const watch = async (status) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((done) => setTimeout(done, 3000));
      try {
        const share = (await (await fetch(API + status, { cache: "no-store" })).json()).share;
        if (!share) return;
        const words = { fetching: "Fetching it…", checking: "Listening to it and checking it…", held: "Waiting for the owner to look at it", approved: "On the air", rejected: "Not accepted", failed: "Could not use it", withdrawn: "Withdrawn", reported: "Reported" };
        say((words[share.state] || share.state) + (share.genre ? " · " + share.genre : "") + (share.reason ? " — " + share.reason : ""));
        if (!["fetching", "checking"].includes(share.state)) { load(); return; }
      } catch {}
    }
  };
  const form = document.querySelector("#share");
  try {
    const info = await (await fetch(API + "/api/v1/share", { cache: "no-store" })).json();
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
        ? await fetch(API + "/api/v1/share/upload?" + new URLSearchParams({ ...fields, name: file.name }), { method: "PUT", headers: { "content-type": file.type || "audio/mpeg" }, body: file })
        : await fetch(API + "/api/v1/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, agree: true, url: link }) });
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

const CRAWLPROOF = "https://crawlproof.com";

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

export interface GuideEntry {
  id?: string;
  name: string;
  kind: "audio" | "video";
  /** rooms (live rooms, src/guide-rooms.ts), vod (on demand, src/guide-vods.ts), ai, shared, radio or tv; from kind when absent. */
  group?: "rooms" | "vod" | "ai" | "shared" | "radio" | "tv";
  state: string;
  page: string;
  nowPlaying: { title: string; artist: string } | null;
  /** Its shareable page, /radio/<name> on the guide's address (radio-pages.ts); own stations only. */
  radio?: string;
  /** Listed by another server (a guide peer); its own page, its own reports. */
  peer?: boolean;
}

const GROUPS = ["rooms", "vod", "ai", "shared", "radio", "tv"] as const;

/**
 * The guide with its stations already in it, so it reads the same through a
 * gateway that cannot run its script against this server (the Moshpit's
 * /n/<name>), and for a crawler. Everything from a station is escaped.
 */
export function renderGuide(entries: GuideEntry[], apiBase = "", ads: GuideAds = {}, labelHref = ""): string {
  const groupOf = (one: GuideEntry): string => one.group ?? (one.kind === "video" ? "tv" : "radio");
  const cards = (group: string): string => entries
    .filter((one) => groupOf(one) === group && /^https?:\/\//.test(one.page))
    .map((one) => `<div class="card"><a class="station" href="${escape(one.radio && /^https?:\/\//.test(one.radio) ? one.radio : one.page)}"><div class="live">${one.state === "live" ? "● LIVE" : one.state === "vod" ? "▶ ON DEMAND" : "off the air"}</div><div class="name">${escape(one.name)}</div><div class="now">${escape(nowLine(one.nowPlaying))}</div></a></div>`)
    .join("");
  let page = GUIDE_HTML;
  for (const group of GROUPS) {
    const made = cards(group);
    page = page
      .replace(`<h2 id="${group}-title" hidden>`, made ? `<h2 id="${group}-title">` : `<h2 id="${group}-title" hidden>`)
      .replace(`<div id="${group}" class="grid" aria-live="polite"></div>`, `<div id="${group}" class="grid" aria-live="polite">${made}</div>`);
  }
  if (ads.site) page = page.replace("</head>", `<script data-site="${escape(ads.site)}" src="${CRAWLPROOF}/stats.js" async></script>\n</head>`);
  if (ads.slot) {
    // One line by default: a 300x250 box above the stations pushed the guide itself off the first screen.
    const format = ads.format ?? "text_link";
    const slot = ads.slot;
    // The one ad goes at the top of the content, never against the footer.
    page = page.replace('<p class="lead">Radio and TV, on the air now. Pick one and press play.</p>\n', (lead) => `${lead}  <div class="ad-unit ad-${format}"><iframe src="${CRAWLPROOF}/api/ads/frame?slot=${encodeURIComponent(slot)}&amp;format=${format}" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>\n`);
  }
  // The AI label's artists and albums, under the AI stations they play on.
  if (/^\/[a-z]+$/.test(labelHref)) {
    page = page.replace('<div id="ai" class="grid" aria-live="polite">', `<p class="lead"><a href="${labelHref}">The AI label: every artist, album and song, with the words →</a></p>\n  <div id="ai" class="grid" aria-live="polite">`);
  }
  const api = /^https:\/\/[^\s"<>]+$/.test(apiBase) ? apiBase.replace(/\/+$/, "") : "";
  return (page.replace('<p id="empty" class="empty">', entries.length ? '<p id="empty" class="empty" hidden>' : '<p id="empty" class="empty">')).replace("<body>", api ? `<body data-api="${escape(api)}">` : "<body>");
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
  <nav class="top" aria-label="live.streaming"><a href="/radio">Radio: every station by name</a><a href="/label">AI label</a><a href="/vod">On demand</a></nav>
  <h1>Live</h1>
  <p class="lead">Radio and TV, on the air now. Pick one and press play.</p>
  <h2 id="rooms-title" hidden>Live rooms</h2>
  <div id="rooms" class="grid" aria-live="polite"></div>
  <h2 id="vod-title" hidden>On demand</h2>
  <div id="vod" class="grid" aria-live="polite"></div>
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
  <footer>Played by <a href="https://nixamp.com">nixamp</a>.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

/**
 * The guide's policy. With crawlproof configured (guideAds below) its tracker
 * script and its ad frame are allowed from crawlproof.com and nothing else
 * changes; the tracker reports by fetch, which connect-src https: already allows.
 */
export function guideCsp(ads: GuideAds = {}): string {
  return [
    "default-src 'none'", `script-src ${hash(SCRIPT)}${ads.site ? ` ${CRAWLPROOF}` : ""}`, `style-src 'self' ${hash(STYLE)}`, "connect-src 'self' https:",
    `img-src 'self' data:${ads.site || ads.slot ? ` ${CRAWLPROOF}` : ""}`, ...(ads.slot ? [`frame-src ${CRAWLPROOF}`] : []),
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join("; ");
}

export const GUIDE_CSP = guideCsp();


/** crawlproof analytics and an ad on the guide: a project id (tracker data-site) and an ad slot. */
export interface GuideAds {
  site?: string;
  slot?: string;
  format?: "banner_300x250" | "text_link";
}

const AD_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A setting as the guide may use it: ids that are ids, a format it knows, or nothing. */
export function cleanGuideAds(value: unknown): GuideAds {
  if (typeof value !== "object" || value === null) return {};
  const one = value as Record<string, unknown>;
  const site = typeof one["site"] === "string" && AD_ID.test(one["site"].trim()) ? one["site"].trim() : "";
  const slot = typeof one["slot"] === "string" && AD_ID.test(one["slot"].trim()) ? one["slot"].trim() : "";
  const format = one["format"] === "text_link" || one["format"] === "banner_300x250" ? one["format"] : undefined;
  return { ...(site ? { site } : {}), ...(slot ? { slot } : {}), ...(format && slot ? { format } : {}) };
}

/**
 * crawlproof on the guide: `guideAds` in config.json (`nixamp station guide-ads
 * --site ID --slot ID`), each overridden by NIXAMP_GUIDE_CRAWLPROOF_SITE /
 * NIXAMP_GUIDE_AD_SLOT / NIXAMP_GUIDE_AD_FORMAT. Unset is off: a guide on
 * somebody's own machine carries nobody's tracker.
 */
export function guideAds(env: Record<string, string | undefined> = process.env): GuideAds {
  const saved = (() => { try { return readConfig().guideAds ?? {}; } catch { return {}; } })();
  return cleanGuideAds({
    site: env["NIXAMP_GUIDE_CRAWLPROOF_SITE"] ?? saved.site,
    slot: env["NIXAMP_GUIDE_AD_SLOT"] ?? saved.slot,
    format: env["NIXAMP_GUIDE_AD_FORMAT"] ?? saved.format,
  });
}

/**
 * The hosts whose front page is the guide: `guideHosts` in config.json
 * (`nixamp station guide-host NAME`, which survives restarts and updates),
 * plus NIXAMP_GUIDE_HOSTS, comma-separated.
 */
export function guideHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const saved = (() => { try { return readConfig().guideHosts ?? []; } catch { return []; } })();
  return new Set([...(env["NIXAMP_GUIDE_HOSTS"] ?? "").split(","), ...saved].map((one) => one.trim().toLowerCase()).filter(Boolean));
}

/**
 * The other servers whose public, listed stations this guide shows beside
 * its own: `guidePeers` in config.json (`nixamp station guide-peer URL`), plus
 * NIXAMP_GUIDE_PEERS, comma-separated. One Moshpit name (live.streaming) points
 * at one server; this is how a station on any of the owner's servers gets on it.
 */
export function guidePeers(env: Record<string, string | undefined> = process.env): string[] {
  const saved = (() => { try { return readConfig().guidePeers ?? []; } catch { return []; } })();
  const peers = new Set<string>();
  for (const one of [...(env["NIXAMP_GUIDE_PEERS"] ?? "").split(","), ...saved]) {
    const base = peerBase(one);
    if (base) peers.add(base);
  }
  return [...peers];
}

/** An https server address as a bare origin, or "" when it is not one. */
export function peerBase(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
  } catch {
    return "";
  }
}

const PEER_FRESH_MS = 15_000;
const PEER_TIMEOUT_MS = 4_000;

function peerEntry(value: unknown, origin: string): GuideEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const one = value as Record<string, unknown>;
  const page = typeof one["page"] === "string" ? one["page"] : "";
  // A peer lists its own stations, on its own address, and nothing else.
  try { if (new URL(page).origin !== origin) return null; } catch { return null; }
  if (typeof one["name"] !== "string") return null;
  const now = one["nowPlaying"] as Record<string, unknown> | null | undefined;
  const group = one["group"];
  return {
    ...(typeof one["id"] === "string" ? { id: one["id"] } : {}),
    name: one["name"].slice(0, 120),
    kind: one["kind"] === "video" ? "video" : "audio",
    ...(group === "ai" || group === "shared" || group === "radio" || group === "tv" ? { group } : {}),
    state: typeof one["state"] === "string" ? one["state"] : "offline",
    page,
    nowPlaying: now && typeof now === "object"
      ? { title: String(now["title"] ?? "").slice(0, 200), artist: String(now["artist"] ?? "").slice(0, 200) }
      : null,
    peer: true,
  };
}

/**
 * What the peers' guides list, asked at most every 15 seconds each and never
 * waited on for more than 4: a peer that is down drops out of the guide, it
 * does not hold the guide up. Each peer is asked for its own stations only
 * (?local=1), so two servers that list each other do not ask round in a ring.
 */
export class PeerGuides {
  private readonly held = new Map<string, { at: number; entries: GuideEntry[] }>();
  private readonly asking = new Map<string, Promise<void>>();

  constructor(
    private readonly peers: () => string[] = () => guidePeers(),
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async entries(): Promise<GuideEntry[]> {
    const peers = this.peers();
    await Promise.all(peers.map((peer) => {
      const kept = this.held.get(peer);
      return kept && this.now() - kept.at < PEER_FRESH_MS ? undefined : this.ask(peer);
    }));
    return peers.flatMap((peer) => this.held.get(peer)?.entries ?? []);
  }

  private ask(peer: string): Promise<void> {
    const pending = this.asking.get(peer);
    if (pending) return pending;
    const work = (async () => {
      let entries: GuideEntry[] = [];
      try {
        const answer = await this.fetcher(`${peer}/api/v1/stations/guide?local=1`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
        if (answer.ok) {
          const body = (await answer.json()) as { stations?: unknown };
          entries = Array.isArray(body.stations)
            ? body.stations.map((one) => peerEntry(one, peer)).filter((one): one is GuideEntry => one !== null).slice(0, 500)
            : [];
        }
      } catch {
        entries = [];
      }
      this.held.set(peer, { at: this.now(), entries });
    })().finally(() => this.asking.delete(peer));
    this.asking.set(peer, work);
    return work;
  }
}

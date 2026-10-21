/**
 * The AI label over HTTP (ai-label.ts).
 *
 * Public, no key: `/label` (the catalogue as a page: every artist, album and
 * song, playable, with its words), `/api/v1/label` (the same as JSON) and
 * `/api/v1/label/<artist>/<album>/<n>.mp3|<n>.txt|cover.jpg` (the released
 * files themselves). The owner's are under /api/v1/stations/label.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROSTER, type AiLabel, type PublicArtist } from "./ai-label.ts";
import { covers, PRICES, type GrantVerifier } from "./music-store.ts";
import { writeZip, zipSize } from "./zip-stream.ts";
import { StationError } from "./stations.ts";

// Listening is free on the live stations (with their breaks); the songs as
// files are sold, so only the words and the cover are public here, and an
// MP3 or a zip needs a grant from nixamp.com's store (music-store.ts).
const FILE = /^\/api\/v1\/label\/([a-f0-9]{10})\/([a-f0-9]{8})\/(\d{1,3}\.(?:txt|mp3)|cover\.jpg)$/;

/** Whether this path is the label's public face (an MP3 or the zip still asks for its grant). */
export function isPublicLabelPath(path: string): boolean {
  return path === "/label" || path === "/api/v1/label" || path === "/api/v1/label/zip" || FILE.test(path);
}

/** nixamp.com's page that sells this: a song, an album or everything by the artist. */
export function buyLink(site: string, server: string, kind: "song" | "album" | "artist", artist: string, album = "", n = 0): string {
  const query = new URLSearchParams({ server, kind, artist, ...(kind !== "artist" ? { album } : {}), ...(kind === "song" ? { n: String(n) } : {}) });
  return `${site}/buy?${query.toString()}`;
}

export interface LabelRoutesContext {
  label: AiLabel;
  canControl: boolean;
  /** Checks a store grant with nixamp.com; without it nothing is sold or handed out. */
  grants?: GrantVerifier;
  /** nixamp.com, where the store is, and this server's public address (for Buy links). */
  site?: string;
  publicBase?: string;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
}

async function jsonBody(ctx: LabelRoutesContext, request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await ctx.readBody(request);
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StationError("bad_json", "the body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StationError("bad_json", "the body is not a JSON object");
  return parsed as Record<string, unknown>;
}

/** A file, whole or the byte range asked for, so a player can seek. */
function sendFile(request: IncomingMessage, response: ServerResponse, path: string, type: string, download: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("gone");
    return;
  }
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
    ...(download ? { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(download)}` } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
    if (request.method === "HEAD") return void response.end();
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": String(size) });
  if (request.method === "HEAD") return void response.end();
  createReadStream(path).pipe(response);
}

/** Answers the paths above and the owner's; false when the path is neither. */
export async function handleLabelRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  ctx: LabelRoutesContext,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const label = ctx.label;
  try {
    if (isPublicLabelPath(path)) {
      if (method !== "GET" && method !== "HEAD") {
        ctx.json(response, 405, { error: "not like that", code: "method_not_allowed" });
        return true;
      }
      if (path === "/label") {
        const shop = ctx.grants && ctx.site && /^https:\/\//.test(ctx.publicBase ?? "") ? { site: ctx.site, server: ctx.publicBase! } : undefined;
        const page = renderLabel(label.publicView(), shop);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": LABEL_CSP, "cache-control": "public, max-age=300" });
        response.end(method === "HEAD" ? undefined : page);
        return true;
      }
      if (path === "/api/v1/label") {
        ctx.json(response, 200, label.publicView());
        return true;
      }
      const url = new URL(request.url ?? "/", "http://x");
      const grant = url.searchParams.get("grant") ?? "";
      if (path === "/api/v1/label/zip") {
        const scope = ctx.grants ? await ctx.grants.check(grant) : null;
        if (!scope) {
          ctx.json(response, 403, { error: "that download link has expired or is not one of ours: open your purchase again for a fresh one", code: "bad_grant" });
          return true;
        }
        const zip = label.zipFor(scope);
        if (!zip) {
          ctx.json(response, 404, { error: "nothing to download yet", code: "not_found" });
          return true;
        }
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(zipSize(zip.entries)),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zip.name)}`,
          "cache-control": "private, no-store",
        });
        if (method === "HEAD") {
          response.end();
          return true;
        }
        await writeZip(response, zip.entries).catch(() => response.destroy());
        response.end();
        return true;
      }
      const [, artist, album, what] = FILE.exec(path)!;
      if (what!.endsWith(".mp3")) {
        const scope = ctx.grants && grant ? await ctx.grants.check(grant) : null;
        const n = Number(what!.split(".")[0]);
        const file = scope && covers(scope, artist!, album!, n) ? label.songFile(artist!, album!, n) : "";
        if (!file) {
          ctx.json(response, 403, { error: "songs as files are for the people who bought them; listening on the live stations is free", code: "not_bought" });
          return true;
        }
        sendFile(request, response, file, "audio/mpeg", file.split("/").pop() ?? "");
        return true;
      }
      const found = label.publicFile(artist!, album!, what!);
      if (!found) {
        ctx.json(response, 404, { error: "no such file on the label", code: "not_found" });
        return true;
      }
      sendFile(request, response, found.path, found.type, what === "cover.jpg" ? "" : found.path.split("/").pop() ?? "");
      return true;
    }

    if (path !== "/api/v1/stations/label" && !path.startsWith("/api/v1/stations/label/")) return false;
    if (!ctx.canControl) {
      ctx.json(response, 403, { error: "only this server's owner runs the label", code: "forbidden" });
      return true;
    }
    if (path === "/api/v1/stations/label") {
      if (method === "GET") {
        ctx.json(response, 200, label.status());
        return true;
      }
      if (method === "POST") {
        ctx.json(response, 200, { settings: label.configure(await jsonBody(ctx, request)) });
        return true;
      }
    }
    if (path === "/api/v1/stations/label/run" && method === "POST") {
      void label.tick();
      ctx.json(response, 202, label.status());
      return true;
    }
    if (path === "/api/v1/stations/label/artists" && method === "POST") {
      const input = await jsonBody(ctx, request);
      if (input["roster"] === true) {
        // The whole first roster at once, skipping whoever is already signed.
        const signed = Object.keys(ROSTER).flatMap((preset) => {
          try {
            return [label.sign({ preset })];
          } catch (error) {
            if (error instanceof StationError && error.code === "already_signed") return [];
            throw error;
          }
        });
        ctx.json(response, 201, { artists: signed });
        return true;
      }
      ctx.json(response, 201, { artist: label.sign(input) });
      return true;
    }
    const match = /^\/api\/v1\/stations\/label\/artists\/([a-f0-9]{10})(?:\/(album))?$/.exec(path);
    if (match) {
      const [, key, action] = match;
      if (!action && method === "GET") {
        const artist = label.get(key!);
        if (!artist) throw new StationError("not_found", "no such artist on the label", 404);
        ctx.json(response, 200, { artist });
        return true;
      }
      if (!action && method === "PATCH") {
        ctx.json(response, 200, { artist: label.update(key!, await jsonBody(ctx, request)) });
        return true;
      }
      if (!action && method === "DELETE") {
        await label.drop(key!, new URL(request.url ?? "/", "http://x").searchParams.get("files") === "1");
        ctx.json(response, 200, { deleted: key });
        return true;
      }
      if (action === "album" && method === "POST") {
        const album = await label.plan(key!);
        void label.tick();
        ctx.json(response, 201, { album });
        return true;
      }
    }
    ctx.json(response, 404, { error: "no such label route", code: "not_found" });
    return true;
  } catch (error) {
    if (error instanceof StationError) ctx.json(response, error.status, { error: error.message, code: error.code });
    else ctx.json(response, 500, { error: error instanceof Error ? error.message : String(error), code: "internal" });
    return true;
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

function minutes(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15171a;--muted:#5d6570;--card:#fff;--line:#dfe3e8;--accent:#0f7b4f}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--fg:#e8eaee;--muted:#9aa3ad;--card:#161a1f;--line:#262c33;--accent:#3ddc84}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}h1{margin:0 0 4px;font-size:1.8rem}
.lead{color:var(--muted);margin:0 0 24px}a{color:var(--accent)}
nav.genres{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}nav.genres a{border:1px solid var(--line);border-radius:999px;padding:4px 12px;text-decoration:none;color:var(--fg);background:var(--card)}
section.genre{margin-top:36px}section.genre>h2{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;margin:0 0 12px;font-size:1.4rem}
section.genre>h2 a{font-size:.9rem;font-weight:600}
.artist{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.artist h3{margin:0;font-size:1.2rem}.bio{color:var(--muted);margin:4px 0 0}
.album{display:grid;grid-template-columns:160px 1fr;gap:16px;margin-top:18px}
@media (max-width:560px){.album{grid-template-columns:1fr}}
.cover{width:160px;height:160px;border-radius:10px;object-fit:cover;background:var(--line);display:block}
.blank{width:160px;height:160px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--line))}
.album h4{margin:0;font-size:1.05rem}.concept{color:var(--muted);font-size:.9rem;margin:2px 0 8px}
ol.songs{list-style:none;margin:0;padding:0}ol.songs li{border-top:1px solid var(--line);padding:8px 0}
.song{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.song .t{flex:1 1 200px;font-weight:600;overflow-wrap:anywhere}
.song .n,.song .d{color:var(--muted);font-variant-numeric:tabular-nums}
audio{width:100%;max-width:360px;height:36px}
details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:.9rem}
pre.lyrics{white-space:pre-wrap;font:inherit;font-size:.95rem;margin:8px 0 0;padding:12px;border-radius:8px;background:var(--bg)}
.dl{font-size:.85rem}.soon{color:var(--muted);font-size:.85rem}
a.buy{display:inline-block;font-weight:700;text-decoration:none;border:1px solid var(--accent);border-radius:999px;padding:2px 10px}
footer{margin-top:48px;color:var(--muted);font-size:.85rem}footer a{color:inherit}
`;

function hash(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

export const LABEL_CSP = [
  "default-src 'none'", `style-src ${hash(STYLE)}`, "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

type Shop = { site: string; server: string } | undefined;

function price(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

function buy(shop: Shop, kind: "song" | "album" | "artist", artist: string, album = "", n = 0, what = ""): string {
  if (!shop) return "";
  return `<a class="buy" href="${escape(buyLink(shop.site, shop.server, kind, artist, album, n))}">Download ${what || kind} · ${price(PRICES[kind])}</a>`;
}

function renderAlbum(artist: PublicArtist, album: PublicArtist["albums"][number], shop: Shop): string {
  const base = `/api/v1/label/${artist.key}/${album.key}`;
  const cover = album.cover ? `<img class="cover" src="${base}/cover.jpg" alt="Cover of ${escape(album.title)}" width="160" height="160" loading="lazy">` : `<div class="blank" aria-hidden="true"></div>`;
  const songs = album.songs.map((song) => `<li><div class="song"><span class="n">${song.n}.</span><span class="t">${escape(song.title)}</span><span class="d">${minutes(song.seconds)}</span></div>`
    + `<details><summary>Lyrics</summary><pre class="lyrics">${escape(song.lyrics)}</pre></details>`
    + `<div class="dl"><a href="${base}/${song.n}.txt">lyrics.txt</a>${shop ? ` · ${buy(shop, "song", artist.key, album.key, song.n, "MP3")}` : ""}</div></li>`).join("");
  return `<div class="album">${cover}<div><h4>${escape(album.title)} <span class="d">(${album.year})</span></h4>`
    + `${album.concept ? `<p class="concept">${escape(album.concept)}</p>` : ""}`
    + `${album.complete ? "" : `<p class="soon">Still being recorded: new songs land here as they are finished.</p>`}`
    + `${shop ? `<p>${buy(shop, "album", artist.key, album.key, 0, "the album, MP3s with art and lyrics")}</p>` : ""}`
    + `<ol class="songs">${songs}</ol></div></div>`;
}

/** The label's catalogue as a page: no script, plays in any browser. */
export function renderLabel(view: ReturnType<AiLabel["publicView"]>, shop?: Shop): string {
  const label = view.holder.replace(/,?\s+(inc|llc|ltd|gmbh|co)\.?$/i, "");
  const nav = view.genres.length > 1 ? `<nav class="genres" aria-label="Genres">${view.genres.map((one) => `<a href="#${escape(one.genre.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${escape(one.genre)}</a>`).join("")}</nav>` : "";
  const sections = view.genres.map((genre) => `<section class="genre" id="${escape(genre.genre.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}" aria-labelledby="g-${escape(genre.genre.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">`
    + `<h2 id="g-${escape(genre.genre.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${escape(genre.genre)}${genre.station ? ` <a href="/watch/${escape(genre.station)}">Listen live, free →</a>` : ""}</h2>`
    + genre.artists.map((artist) => `<article class="artist"><h3>${escape(artist.name)}</h3>${artist.bio ? `<p class="bio">${escape(artist.bio)}</p>` : ""}`
      + `${shop ? `<p>${buy(shop, "artist", artist.key, "", 0, "everything by them")}</p>` : ""}`
      + `${artist.albums.map((album) => renderAlbum(artist, album, shop)).join("")}</article>`).join("")
    + `</section>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(label)} AI Label</title>
<meta name="description" content="Original music by ${escape(label)}'s AI artists: every album, every song, with the words. New albums every month.">
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escape(label)} AI Label</h1>
<p class="lead">Original artists, written and sung by AI, released by ${escape(view.holder)}. Every album, every song, with the words. New albums land every month. Listening on the live stations is always free.</p>
${nav}
${sections || `<p class="soon">The first albums are being recorded. Check back soon.</p>`}
<footer>℗ ${new Date().getUTCFullYear()} ${escape(view.holder)}. Music and words made with AI. Played by <a href="https://nixamp.com">nixamp</a>.</footer>
</main>
</body>
</html>`;
}

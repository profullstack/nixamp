/**
 * /radio: this server's public, listed stations under readable names, and the
 * artists and albums they play.
 *
 *   /radio                      every public, listed station, what is on each
 *   /radio/<name>               one station's page (the station app), e.g. /radio/ai-metal
 *   /radio/<name>/<what>        its stream, state, events, now, art, lyrics and .m3u,
 *                               answered here with the station's token held server-side
 *   /radio/artist/<name>        an artist: albums, songs, the stations that play them,
 *                               Follow, and Buy where our AI label sells them
 *   /radio/album/<name>         an album: cover, songs (with the words, for the label's)
 *   /radio/album/<name>/cover.jpg  a non-label album's cover, read from its files
 *
 * The point is a link worth sharing: a station's raw link names the machine it
 * runs on and carries its listen token; these name neither. Only stations
 * their owner made public and listed are here, the same rule as the guide.
 * Artists and albums come from those stations' files and the AI label's
 * catalogue, never from the rest of the library: a page here says nothing a
 * public station is not already playing.
 */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Station } from "./stations.ts";
import { albumSlug, artistSlug, stationSlug } from "./radio-slug.ts";

/** A station's own paths, as the station link opens them. */
export const RADIO_SUB = /^\/radio\/([a-z0-9-]{1,60})\/(stream|state|listen\.m3u|events|now|art|lyrics|clock)$/;
export const RADIO_STATION = /^\/radio\/([a-z0-9-]{1,60})\/?$/;
export const RADIO_ARTIST = /^\/radio\/artist\/([a-z0-9-]{1,90})\/?$/;
export const RADIO_ALBUM = /^\/radio\/album\/([a-z0-9-]{1,100})(\/cover\.jpg)?\/?$/;

export function isRadioPath(path: string): boolean {
  return path === "/radio" || path === "/radio/" || path === RADIO_BUY || RADIO_SUB.test(path) || RADIO_STATION.test(path) || RADIO_ARTIST.test(path) || RADIO_ALBUM.test(path);
}

const RESERVED = new Set(["artist", "album", "artists", "albums", "buy"]);

/**
 * Buy, through this server: a 302 to nixamp.com's store page for it, so the
 * link on a /radio page does not carry the machine the music is on.
 */
export const RADIO_BUY = "/radio/buy";

/** /radio/buy?kind=&artist=&album=&n=, checked: the label's keys and nothing else. */
export function radioBuyQuery(query: URLSearchParams): { kind: "song" | "album" | "artist"; artist: string; album: string; n: number } | null {
  const kind = query.get("kind");
  const artist = query.get("artist") ?? "";
  const album = query.get("album") ?? "";
  const n = Number(query.get("n") ?? 0);
  if (kind !== "song" && kind !== "album" && kind !== "artist") return null;
  if (!/^[a-f0-9]{10}$/.test(artist)) return null;
  if (kind !== "artist" && !/^[a-f0-9]{8}$/.test(album)) return null;
  if (kind === "song" && !(Number.isInteger(n) && n >= 1 && n <= 999)) return null;
  return { kind, artist, album: kind === "artist" ? "" : album, n: kind === "song" ? n : 0 };
}

export function radioBuyLink(kind: "song" | "album" | "artist", artist: string, album = "", n = 0): string {
  return `${RADIO_BUY}?${new URLSearchParams({ kind, artist, ...(kind !== "artist" ? { album } : {}), ...(kind === "song" ? { n: String(n) } : {}) }).toString()}`;
}

/**
 * Public, listed stations by name. Oldest first, so a name stays with the
 * station that had it; a second "Jazz" is jazz-2.
 */
export function radioStations(list: Station[]): Map<string, Station> {
  const out = new Map<string, Station>();
  const sorted = list
    .filter((one) => one.visibility === "public" && one.listed)
    .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  for (const station of sorted) {
    let base = stationSlug(station.name);
    if (RESERVED.has(base) || /^[a-z0-9]{10}$/.test(base)) base = `${base}-radio`;
    let slug = base;
    for (let n = 2; out.has(slug); n += 1) slug = `${base}-${n}`;
    out.set(slug, station);
  }
  return out;
}

/** A station's /radio name, or "" when it is not public and listed. */
export function radioSlugOf(stations: Map<string, Station>, id: string): string {
  for (const [slug, one] of stations) if (one.id === id) return slug;
  return "";
}

// --- the catalogue -----------------------------------------------------------

export interface RadioTrack { title: string; seconds: number; n: number; lyrics?: string }

export interface RadioAlbum {
  slug: string;
  title: string;
  year: number;
  artist: string;
  artistName: string;
  concept: string;
  complete: boolean;
  /** The AI label's keys: its cover and its store. */
  label?: { artist: string; album: string; cover: boolean };
  /** A file of this album's with a picture in it (never shown; read for /cover.jpg). */
  coverFile?: string;
  tracks: RadioTrack[];
  stations: string[];
}

export interface RadioArtist {
  slug: string;
  name: string;
  label?: { key: string; genre: string; bio: string };
  albums: string[];
  /** Songs with no album in their tags. */
  singles: RadioTrack[];
  stations: string[];
}

export interface RadioCatalogue {
  artists: Map<string, RadioArtist>;
  albums: Map<string, RadioAlbum>;
}

export interface LabelView {
  holder: string;
  genres: Array<{ genre: string; station: string; artists: Array<{ key: string; name: string; genre: string; bio: string; albums: Array<{ key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: Array<{ n: number; title: string; seconds: number; lyrics: string }> }> }> }>;
}

export interface FileTags { title: string; artist: string; album: string; year: number; track: number; duration: number; hasArt: boolean }

export interface CatalogueInput {
  stations: Map<string, Station>;
  label?: LabelView;
  /** The label song at a file (after audioFor), or null. */
  songAt?: (file: string) => { artistName: string; albumTitle: string } | null;
  /** A label music video's song file; the file itself otherwise. */
  audioFor?: (file: string) => string;
  /** What the library knows about a file, or null. */
  tags: (file: string) => FileTags | null;
}

const MAX_TRACKS = 300;

const add = (list: string[], one: string): void => { if (one && !list.includes(one)) list.push(one); };

export function buildCatalogue(input: CatalogueInput): RadioCatalogue {
  const artists = new Map<string, RadioArtist>();
  const albums = new Map<string, RadioAlbum>();
  const artistFor = (name: string): RadioArtist | null => {
    const slug = artistSlug(name);
    if (!slug) return null;
    let one = artists.get(slug);
    if (!one) {
      one = { slug, name: name.split(/\s*;\s*/)[0]!.trim(), albums: [], singles: [], stations: [] };
      artists.set(slug, one);
    }
    return one;
  };
  // The label first: every released album, whether or not a station has reached it yet.
  for (const genre of input.label?.genres ?? []) {
    for (const artist of genre.artists) {
      const one = artistFor(artist.name);
      if (!one) continue;
      one.label = { key: artist.key, genre: artist.genre, bio: artist.bio };
      for (const album of artist.albums) {
        const slug = albumSlug(artist.name, album.title);
        if (!slug || albums.has(slug)) continue;
        albums.set(slug, {
          slug, title: album.title, year: album.year, artist: one.slug, artistName: one.name, concept: album.concept, complete: album.complete,
          label: { artist: artist.key, album: album.key, cover: album.cover },
          tracks: album.songs.map((song) => ({ title: song.title, seconds: song.seconds, n: song.n, lyrics: song.lyrics })),
          stations: [],
        });
        add(one.albums, slug);
      }
    }
  }
  for (const [stationSlugName, station] of input.stations) {
    for (const file of station.items) {
      const audio = input.audioFor ? input.audioFor(file) : file;
      const song = input.songAt?.(audio) ?? null;
      if (song) {
        const artist = artists.get(artistSlug(song.artistName));
        if (artist) add(artist.stations, stationSlugName);
        const album = albums.get(albumSlug(song.artistName, song.albumTitle));
        if (album) add(album.stations, stationSlugName);
        continue;
      }
      const tags = input.tags(file);
      if (!tags || !tags.artist.trim()) continue;
      const artist = artistFor(tags.artist);
      if (!artist) continue;
      add(artist.stations, stationSlugName);
      const track: RadioTrack = { title: tags.title || file.split("/").pop()!.replace(/\.[a-z0-9]{2,4}$/i, ""), seconds: Math.round(tags.duration || 0), n: tags.track || 0 };
      if (!tags.album.trim()) {
        if (artist.singles.length < MAX_TRACKS && !artist.singles.some((one) => one.title === track.title)) artist.singles.push(track);
        continue;
      }
      const slug = albumSlug(artist.name, tags.album);
      let album = albums.get(slug);
      if (!album) {
        album = { slug, title: tags.album.trim(), year: tags.year || 0, artist: artist.slug, artistName: artist.name, concept: "", complete: true, tracks: [], stations: [] };
        albums.set(slug, album);
        add(artist.albums, slug);
      }
      add(album.stations, stationSlugName);
      if (!album.label) {
        if (!album.coverFile && tags.hasArt) album.coverFile = file;
        if (!album.year && tags.year) album.year = tags.year;
        if (album.tracks.length < MAX_TRACKS && !album.tracks.some((one) => one.title === track.title)) album.tracks.push(track);
      }
    }
  }
  for (const album of albums.values()) {
    if (!album.label) album.tracks.sort((a, b) => (a.n || 999) - (b.n || 999) || a.title.localeCompare(b.title));
  }
  return { artists, albums };
}

// --- answering through the station's own routes ---------------------------------

/**
 * Rewrites what a station's routes answer, for /radio/<name>/...: the
 * station's own addresses become the /radio ones and its token goes. Only
 * text (JSON, events, a playlist); sound and pictures pass as they are.
 */
export function rewriteResponse(response: ServerResponse, rewrite: (text: string) => string): void {
  let text = false;
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
  (response as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args: unknown[]) => {
    const headers = args.find((one) => typeof one === "object" && one !== null && !Array.isArray(one)) as Record<string, unknown> | undefined;
    const type = String(headers?.["content-type"] ?? response.getHeader("content-type") ?? "");
    text = /json|event-stream|mpegurl|^text\//i.test(type);
    if (text && headers) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-length") delete headers[key];
      response.removeHeader("content-length");
    }
    return writeHead(...args);
  };
  const write = response.write.bind(response) as (...args: unknown[]) => boolean;
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
  const swap = (chunk: unknown): unknown => {
    if (!text || chunk === undefined || chunk === null || typeof chunk === "function") return chunk;
    if (typeof chunk === "string") return rewrite(chunk);
    if (chunk instanceof Uint8Array) return rewrite(Buffer.from(chunk).toString("utf8"));
    return chunk;
  };
  (response as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => write(swap(chunk), ...rest);
  (response as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (chunk?: unknown, ...rest: unknown[]) => end(swap(chunk), ...rest);
}

/** The station's addresses and token, as /radio/<name> says them instead. */
export function radioRewriter(station: { id: string; listenToken: string }, slug: string, buyFrom = ""): (text: string) => string {
  const token = station.listenToken;
  const encoded = encodeURIComponent(token);
  return (text) => {
    let out = text.split(`/api/v1/stations/${station.id}/`).join(`/radio/${slug}/`);
    // The store's links name this server; /radio/buy sends there without saying so.
    if (buyFrom) out = out.split(buyFrom).join(`${RADIO_BUY}?`);
    for (const one of new Set([encoded, token])) {
      out = out.split(`?t=${one}&`).join("?").split(`&t=${one}`).join("").split(`?t=${one}`).join("").split(one).join("");
    }
    return out;
  };
}

// --- pages ------------------------------------------------------------------------

function escape(text: string): string {
  return String(text).replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

function minutes(seconds: number): string {
  if (!seconds) return "";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function price(cents: number): string {
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

/** The live.streaming header every /radio page carries, so a listener can get anywhere from one. */
export const NAV_STYLE = `.radio-nav{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;max-width:960px;margin:0 auto;padding:14px 16px;font:600 15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.radio-nav a{color:inherit;text-decoration:none;opacity:.8}.radio-nav a:hover,.radio-nav a[aria-current=page]{opacity:1;text-decoration:underline}
.radio-nav .brand{font-weight:800;opacity:1;margin-right:auto}`;

export function radioNav(home: string, current: "live" | "radio" | "label" | "vod" | "" = "radio"): string {
  const link = (href: string, text: string, key: string): string => `<a href="${escape(href)}"${current === key ? ' aria-current="page"' : ""}>${text}</a>`;
  return `<nav class="radio-nav" aria-label="live.streaming"><a class="brand" href="${escape(home)}">live.streaming</a>${link(home, "Live now", "live")}${link("/radio", "Radio", "radio")}${link("/label", "AI label", "label")}${link("/vod", "On demand", "vod")}</nav>`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#17171a;--muted:#5d5d66;--card:#fff;--line:#dedcd6;--accent:#1f6feb;--live:#0b7a3b}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececf1;--muted:#a4a4b0;--card:#1c1c20;--line:#2c2c33;--accent:#6aa7ff;--live:#3fbf7f}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:16px 16px 48px}
h1{margin:8px 0 4px;font-size:1.8rem;line-height:1.2;overflow-wrap:anywhere}h2{font-size:1rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px}
.lead{color:var(--muted);margin:0 0 16px}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.card a.whole{color:inherit;text-decoration:none;display:block}.card:hover,.card:focus-within{border-color:var(--accent)}
.name{font-weight:700;overflow-wrap:anywhere}.now{color:var(--muted);font-size:.9rem;margin-top:4px;overflow-wrap:anywhere}
.live{color:var(--live);font-size:.8rem;font-weight:700}.off{color:var(--muted);font-size:.8rem;font-weight:700}
.head{display:grid;grid-template-columns:200px 1fr;gap:20px;align-items:start}
@media (max-width:600px){.head{grid-template-columns:1fr}}
.cover{width:200px;height:200px;max-width:100%;border-radius:12px;object-fit:cover;background:var(--line);display:block}
.blank{width:200px;height:200px;max-width:100%;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--line))}
.thumb{width:100%;aspect-ratio:1;border-radius:10px;object-fit:cover;background:var(--line);display:block;margin-bottom:8px}
.tblank{width:100%;aspect-ratio:1;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--line));margin-bottom:8px}
.badge{display:inline-block;font-size:.75rem;font-weight:700;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
a.btn{display:inline-block;font-weight:700;text-decoration:none;border:1px solid var(--accent);border-radius:999px;padding:6px 14px}
a.btn.primary{background:var(--accent);color:#fff}
ol.songs{list-style:none;margin:0;padding:0}ol.songs li{border-top:1px solid var(--line);padding:8px 0}
.song{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}.song .t{flex:1 1 200px;font-weight:600;overflow-wrap:anywhere}
.song .n,.song .d{color:var(--muted);font-variant-numeric:tabular-nums}.song a.btn{padding:2px 10px;font-size:.85rem}
details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:.9rem}
pre.lyrics{white-space:pre-wrap;font:inherit;font-size:.95rem;margin:8px 0 0;padding:12px;border-radius:8px;background:var(--bg)}
ul.chips{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}ul.chips a{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:4px 12px;text-decoration:none;color:var(--fg);background:var(--card)}
footer{margin-top:48px;color:var(--muted);font-size:.85rem}footer a{color:inherit}
${NAV_STYLE}
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** No script at all: the pages are links and text. */
export const RADIO_CSP = [
  "default-src 'none'", `style-src ${hash(STYLE)}`, "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

export interface PageMeta { title: string; description: string; url: string; image?: string; type?: string }

function document(meta: PageMeta, nav: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(meta.title)}</title>
<meta name="description" content="${escape(meta.description)}">
<link rel="canonical" href="${escape(meta.url)}">
<meta property="og:title" content="${escape(meta.title)}">
<meta property="og:description" content="${escape(meta.description)}">
<meta property="og:url" content="${escape(meta.url)}">
<meta property="og:type" content="${escape(meta.type ?? "website")}">
<meta property="og:site_name" content="live.streaming">
${meta.image ? `<meta property="og:image" content="${escape(meta.image)}">\n<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
<link rel="icon" href="/favicon.png" type="image/png">
<style>${STYLE}</style>
</head>
<body>
${nav}
<main>
${body}
<footer>Played by <a href="https://nixamp.com">nixamp</a>. Listening on the live stations is always free.</footer>
</main>
</body>
</html>`;
}

export interface DirectoryEntry {
  slug: string;
  name: string;
  description: string;
  state: string;
  kind: "audio" | "video";
  group: string;
  nowPlaying: { title: string; artist: string } | null;
}

const GROUP_TITLES: Record<string, string> = { ai: "AI radio", shared: "Shared by listeners", radio: "Radio", tv: "TV" };

export function renderDirectory(entries: DirectoryEntry[], base: string, nav: string): string {
  const groups = ["ai", "radio", "shared", "tv"];
  const card = (one: DirectoryEntry): string => `<div class="card"><a class="whole" href="/radio/${escape(one.slug)}">`
    + `<div class="${one.state === "live" ? "live" : "off"}">${one.state === "live" ? "● LIVE" : "off the air"}</div>`
    + `<div class="name">${escape(one.name)}</div>`
    + `<div class="now">${escape(one.nowPlaying ? [one.nowPlaying.title, one.nowPlaying.artist].filter(Boolean).join(" — ") : one.description)}</div></a></div>`;
  const sections = groups.map((group) => {
    const list = entries.filter((one) => (groups.includes(one.group) ? one.group : one.kind === "video" ? "tv" : "radio") === group);
    return list.length ? `<h2>${GROUP_TITLES[group]}</h2><div class="grid">${list.map(card).join("")}</div>` : "";
  }).join("");
  return document(
    { title: "Radio · live.streaming", description: `${entries.length} stations on the air: AI-made music, public-domain classics and more. Free to listen, links to share.`, url: `${base}/radio` },
    nav,
    `<h1>Radio</h1><p class="lead">Every public station, under a name you can share. Pick one and press play; tap an artist or an album to see more.</p>${sections || `<p class="lead">Nothing is on the air here yet.</p>`}`,
  );
}

export interface Shop {
  /** nixamp.com, where the store and accounts are. */
  site: string;
  /** buyLink(...) bound to this server. */
  buy: (kind: "song" | "album" | "artist", artist: string, album?: string, n?: number) => string;
  prices: { song: number; album: number; artist: number };
}

function coverOf(album: RadioAlbum): string {
  if (album.label?.cover) return `/api/v1/label/${album.label.artist}/${album.label.album}/cover.jpg`;
  if (album.coverFile) return `/radio/album/${album.slug}/cover.jpg`;
  return "";
}

function stationChips(slugs: string[], names: Map<string, string>): string {
  const known = slugs.filter((one) => names.has(one));
  return known.length ? `<h2>On the air on</h2><ul class="chips">${known.map((one) => `<li><a href="/radio/${escape(one)}">${escape(names.get(one)!)}</a></li>`).join("")}</ul>` : "";
}

function songList(album: RadioAlbum, shop: Shop | null): string {
  return `<ol class="songs">${album.tracks.map((song) => `<li><div class="song"><span class="n">${song.n ? `${song.n}.` : "·"}</span><span class="t">${escape(song.title)}</span><span class="d">${minutes(song.seconds)}</span>`
    + `${shop && album.label && song.n ? `<a class="btn" href="${escape(shop.buy("song", album.label.artist, album.label.album, song.n))}">MP3 · ${price(shop.prices.song)}</a>` : ""}</div>`
    + `${song.lyrics ? `<details><summary>Lyrics</summary><pre class="lyrics">${escape(song.lyrics)}</pre></details>` : ""}</li>`).join("")}</ol>`;
}

export function followLink(site: string, slug: string, name: string, back: string): string {
  return `${site}/follow?${new URLSearchParams({ id: `artist:${slug}`, name, back }).toString()}`;
}

export function renderArtist(catalogue: RadioCatalogue, artist: RadioArtist, ctx: { base: string; nav: string; shop: Shop | null; site: string; stationNames: Map<string, string> }): string {
  const url = `${ctx.base}/radio/artist/${artist.slug}`;
  const albums = artist.albums.map((one) => catalogue.albums.get(one)).filter((one): one is RadioAlbum => Boolean(one))
    .sort((a, b) => (b.year || 0) - (a.year || 0));
  const first = albums.find((one) => coverOf(one));
  const cover = first ? coverOf(first) : "";
  const shop = artist.label ? ctx.shop : null;
  const albumCards = albums.map((album) => {
    const art = coverOf(album);
    return `<div class="card"><a class="whole" href="/radio/album/${escape(album.slug)}">${art ? `<img class="thumb" src="${escape(art)}" alt="" loading="lazy">` : `<div class="tblank" aria-hidden="true"></div>`}`
      + `<div class="name">${escape(album.title)}</div><div class="now">${album.year ? album.year : ""}${album.tracks.length ? ` · ${album.tracks.length} songs` : ""}</div></a></div>`;
  }).join("");
  const singles = artist.singles.length
    ? `<h2>Songs</h2>${songList({ slug: "", title: "", year: 0, artist: artist.slug, artistName: artist.name, concept: "", complete: true, tracks: artist.singles, stations: [] }, null)}`
    : "";
  const about = artist.label
    ? `<span class="badge">AI artist · ${escape(artist.label.genre)}</span>${artist.label.bio ? `<p class="lead">${escape(artist.label.bio)}</p>` : ""}`
    : `<p class="lead">${albums.length} album${albums.length === 1 ? "" : "s"} on the air here.</p>`;
  const body = `<div class="head">${cover ? `<img class="cover" src="${escape(cover)}" alt="" width="200" height="200">` : `<div class="blank" aria-hidden="true"></div>`}<div>`
    + `<h1>${escape(artist.name)}</h1>${about}`
    + `<div class="actions"><a class="btn primary" href="${escape(followLink(ctx.site, artist.slug, artist.name, url))}">Follow</a>`
    + `${shop && artist.label ? `<a class="btn" href="${escape(shop.buy("artist", artist.label.key))}">Everything by them · ${price(shop.prices.artist)}</a>` : ""}`
    + `${artist.stations[0] && ctx.stationNames.has(artist.stations[0]) ? `<a class="btn" href="/radio/${escape(artist.stations[0])}">Listen live</a>` : ""}</div></div></div>`
    + `${albumCards ? `<h2>Albums</h2><div class="grid">${albumCards}</div>` : ""}${singles}${stationChips(artist.stations, ctx.stationNames)}`;
  return document({
    title: `${artist.name} · live.streaming`,
    description: artist.label?.bio || `${artist.name}: albums, songs and the stations playing them, live and free.`,
    url, type: "music.musician",
    ...(cover ? { image: `${ctx.base}${cover}` } : {}),
  }, ctx.nav, body);
}

export function renderAlbum(catalogue: RadioCatalogue, album: RadioAlbum, ctx: { base: string; nav: string; shop: Shop | null; site: string; stationNames: Map<string, string> }): string {
  const url = `${ctx.base}/radio/album/${album.slug}`;
  const cover = coverOf(album);
  const artist = catalogue.artists.get(album.artist);
  const shop = album.label ? ctx.shop : null;
  const body = `<div class="head">${cover ? `<img class="cover" src="${escape(cover)}" alt="Cover of ${escape(album.title)}" width="200" height="200">` : `<div class="blank" aria-hidden="true"></div>`}<div>`
    + `<h1>${escape(album.title)}</h1><p class="lead">by <a href="/radio/artist/${escape(album.artist)}">${escape(album.artistName)}</a>${album.year ? ` · ${album.year}` : ""}${album.tracks.length ? ` · ${album.tracks.length} songs` : ""}</p>`
    + `${album.concept ? `<p>${escape(album.concept)}</p>` : ""}${album.label && !album.complete ? `<p class="lead">Still being recorded: new songs land here as they are finished.</p>` : ""}`
    + `<div class="actions">${artist ? `<a class="btn primary" href="${escape(followLink(ctx.site, artist.slug, artist.name, `${ctx.base}/radio/artist/${artist.slug}`))}">Follow ${escape(artist.name)}</a>` : ""}`
    + `${shop && album.label ? `<a class="btn" href="${escape(shop.buy("album", album.label.artist, album.label.album))}">Download the album · ${price(shop.prices.album)}</a>` : ""}`
    + `${album.stations[0] && ctx.stationNames.has(album.stations[0]) ? `<a class="btn" href="/radio/${escape(album.stations[0])}">Listen live</a>` : ""}</div></div></div>`
    + `<h2>Songs</h2>${songList(album, shop)}${stationChips(album.stations, ctx.stationNames)}`;
  return document({
    title: `${album.title} by ${album.artistName} · live.streaming`,
    description: album.concept || `${album.title}, ${album.artistName}${album.year ? ` (${album.year})` : ""}: the songs and where they are on the air.`,
    url, type: "music.album",
    ...(cover ? { image: `${ctx.base}${cover}` } : {}),
  }, ctx.nav, body);
}

export function renderMissing(what: string, base: string, nav: string): string {
  return document({ title: `Not here · live.streaming`, description: "Nothing by that name is on the air here.", url: `${base}/radio` }, nav,
    `<h1>No ${escape(what)} by that name</h1><p class="lead">Nothing by that name is on the air here now. <a href="/radio">See every station</a>.</p>`);
}

/** A station page's head and header, for the built station app served at /radio/<name>. */
/** What a station page's head says: a station of ours or a peer's. */
export interface StationFace { name: string; description?: string; video?: boolean }

export function stationHead(station: StationFace, slug: string, base: string, path = `/radio/${slug}`, image = ""): string {
  const url = `${base}${path}`;
  const description = station.description || `${station.name}, live now. Free to listen; tap the artist or album on the air to see more.`;
  return `<title>${escape(station.name)} · live.streaming</title>
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="${escape(url)}" />
    <meta property="og:title" content="${escape(station.name)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:url" content="${escape(url)}" />
    <meta property="og:type" content="${station.video ? "video.tv_show" : "music.radio_station"}" />
    <meta property="og:site_name" content="live.streaming" />
    ${image ? `<meta property="og:image" content="${escape(image)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${escape(image)}" />` : `<meta name="twitter:card" content="summary" />`}
    <style>${NAV_STYLE}</style>`;
}

/** A station's picture for link previews: the cover of an album it plays, from the catalogue. */
export function stationImage(catalogue: RadioCatalogue, slug: string, base: string): string {
  const album = [...catalogue.albums.values()].find((one) => one.stations.includes(slug) && (one.coverFile || one.label?.cover));
  return album ? `${base}/radio/album/${album.slug}/cover.jpg` : "";
}

/** The built station page (or the inline one) as /radio/<name> serves it: its head, the header, indexable. */
export function asRadioPage(html: string, station: StationFace, slug: string, base: string, nav: string, path?: string, image = ""): string {
  return html
    .replace(/<title>[^<]*<\/title>/, stationHead(station, slug, base, path, image))
    .replace(/\s*<meta name="robots" content="noindex"\s*\/?>/, "")
    .replace(/<body>/, `<body>\n${nav}`);
}

// --- the guide's peers -----------------------------------------------------------

/** A station another server lists on this guide (a guide peer), as /radio reaches it. */
export interface PeerRadio {
  origin: string;
  id: string;
  token: string;
  name: string;
  kind: "audio" | "video";
  group: string;
  state: string;
  nowPlaying: { title: string; artist: string } | null;
}

/**
 * Peer stations by name, after this server's own (which keep theirs). Only a
 * peer's own station link (its origin, /station/<id>?t=) is taken; the token
 * stays on this server, which asks the peer for the listener.
 */
export function radioPeers(own: Iterable<string>, entries: Array<{ id?: string; name: string; kind: "audio" | "video"; group?: string; state: string; page: string; nowPlaying: { title: string; artist: string } | null }>): Map<string, PeerRadio> {
  const taken = new Set(own);
  const out = new Map<string, PeerRadio>();
  for (const entry of entries) {
    let url: URL;
    try { url = new URL(entry.page); } catch { continue; }
    const id = /^\/station\/([a-z0-9]{10})\/?$/.exec(url.pathname)?.[1] ?? "";
    const token = url.searchParams.get("t") ?? "";
    if (url.protocol !== "https:" || !id || !token || (entry.id && entry.id !== id)) continue;
    let base = stationSlug(entry.name);
    if (RESERVED.has(base) || /^[a-z0-9]{10}$/.test(base)) base = `${base}-radio`;
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    taken.add(slug);
    out.set(slug, { origin: url.origin, id, token, name: entry.name, kind: entry.kind, group: entry.group ?? (entry.kind === "video" ? "tv" : "radio"), state: entry.state, nowPlaying: entry.nowPlaying });
  }
  return out;
}

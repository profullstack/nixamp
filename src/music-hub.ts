/**
 * nixamp.com/music: every AI label's catalogue in one place.
 *
 * The music lives on the servers that make it (server1 and any other nixamp
 * with a label); nixamp.com is where people listen, browse, follow and buy.
 * This gathers each server's /api/v1/label and its public stations, gives
 * every server a short opaque id (so no page or link names the machine), and
 * hands covers, portraits and words through itself.
 *
 *   GET /api/v1/music                         the merged catalogue
 *   GET /api/v1/music/file/<server>/<path>    a cover, portrait, profile or words, through nixamp.com
 *   POST /api/v1/music/released               a server says an album or song landed: its followers hear
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A server's opaque id: the first 10 hex of the SHA-256 of its https origin. Both sides can work it out. */
export function serverId(base: string): string {
  return createHash("sha256").update(base.replace(/\/+$/, "")).digest("hex").slice(0, 10);
}

/** The followable id of an artist, as /follow and live.streaming's /radio use it. */
export function artistFollowId(name: string): string {
  const slug = name.split(/\s*;\s*/)[0]!.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "artist";
  return `artist:${slug}`;
}

interface LabelArtist { key: string; name: string; genre: string; bio: string; members?: Array<{ slug: string; name: string; role: string; bio: string }>; albums: Array<{ key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: Array<{ n: number; title: string; seconds: number; lyrics?: string }> }> }
interface LabelView { holder: string; genres: Array<{ genre: string; station: string; artists: LabelArtist[] }> }
interface GuideStation { id: string; name: string; page: string; state: string; group?: string; nowPlaying: { title: string; artist: string } | null }

export interface HubStation { server: string; id: string; name: string; state: string; listen: string; token: string; nowPlaying: { title: string; artist: string } | null }
export interface HubArtist extends LabelArtist { server: string; follow: string }
export interface HubCatalogue {
  holders: string[];
  genres: Array<{ genre: string; stations: HubStation[]; artists: HubArtist[] }>;
  /** Every AI station on the servers, by genre or not (lo-fi, the bands...). */
  stations: HubStation[];
}

export interface MusicHubOptions {
  /** The servers whose labels are gathered: the directory and the guide's peers. */
  peers: () => string[];
  fetcher?: typeof fetch;
  now?: () => number;
}

export class MusicHub {
  private cache: { at: number; value: Promise<HubCatalogue> } | null = null;
  private bases = new Map<string, string>();

  constructor(private readonly options: MusicHubOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The https origin behind an opaque id, among the servers known now. */
  resolve(id: string): string {
    if (!/^[a-f0-9]{10}$/.test(id)) return "";
    if (!this.bases.has(id)) for (const base of this.options.peers()) this.bases.set(serverId(base), base);
    return this.bases.get(id) ?? "";
  }

  /** The catalogue, gathered at most once a minute (a slow or gone server is left out, not waited on). */
  catalogue(): Promise<HubCatalogue> {
    if (this.cache && this.now() - this.cache.at < 60_000) return this.cache.value;
    const value = this.gather().catch((error: unknown) => { this.cache = null; throw error; });
    this.cache = { at: this.now(), value };
    return value;
  }

  private async read<T>(url: string): Promise<T | null> {
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(6_000), headers: { accept: "application/json" } });
      return response.ok ? await response.json() as T : null;
    } catch {
      return null;
    }
  }

  private async gather(): Promise<HubCatalogue> {
    const peers = [...new Set(this.options.peers())];
    const holders = new Set<string>();
    const genres = new Map<string, { genre: string; stations: HubStation[]; artists: HubArtist[] }>();
    const stations: HubStation[] = [];
    await Promise.all(peers.map(async (base) => {
      const id = serverId(base);
      this.bases.set(id, base);
      const [label, guide] = await Promise.all([
        this.read<LabelView>(`${base}/api/v1/label`),
        this.read<{ stations?: GuideStation[] }>(`${base}/api/v1/stations/guide?local=1`),
      ]);
      // A station is heard through its own server; the page's token is its listen key.
      const byId = new Map<string, HubStation>();
      for (const one of guide?.stations ?? []) {
        if (one.group && one.group !== "ai") continue;
        let page: URL;
        try { page = new URL(one.page); } catch { continue; }
        if (page.origin !== base) continue;
        const station: HubStation = { server: id, id: one.id, name: one.name, state: one.state, listen: `${base}/api/v1/stations/${one.id}`, token: page.searchParams.get("t") ?? "", nowPlaying: one.nowPlaying };
        byId.set(one.id, station);
        stations.push(station);
      }
      if (!label) return;
      holders.add(label.holder);
      for (const genre of label.genres) {
        const slot = genres.get(genre.genre) ?? { genre: genre.genre, stations: [], artists: [] };
        const station = byId.get(genre.station);
        if (station) slot.stations.push(station);
        for (const artist of genre.artists) slot.artists.push({ ...artist, server: id, follow: artistFollowId(artist.name) });
        genres.set(genre.genre, slot);
      }
    }));
    return {
      holders: [...holders],
      genres: [...genres.values()].sort((a, b) => a.genre.localeCompare(b.genre)),
      stations: stations.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}

const FILE = /^\/api\/v1\/music\/file\/([a-f0-9]{10})\/([a-f0-9]{10}\/(?:[a-f0-9]{8}\/(?:\d{1,3}\.txt|cover\.jpg)|artist\.md|members\/[a-z0-9-]{1,40}\.(?:md|jpg)))$/;

const slugOf = (text: string, max: number): string => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max);

/**
 * live.streaming's /radio/artist/<slug> and /radio/album/<slug> addresses, on
 * nixamp.com: the /music page they name (radio-slug.ts's slugs), or "" when
 * the catalogue has no such artist or album.
 */
export async function musicPageFor(hub: MusicHub, path: string): Promise<string> {
  const match = /^\/radio\/(artist|album)\/([a-z0-9-]{1,100})\/?$/.exec(path);
  if (!match) return "";
  const catalogue = await hub.catalogue();
  const artists = catalogue.genres.flatMap((one) => one.artists);
  if (match[1] === "artist") {
    const artist = artists.find((one) => one.follow === `artist:${match[2]}`);
    return artist ? `/music/artist/${artist.server}/${artist.key}` : "";
  }
  for (const artist of artists) {
    const album = artist.albums.find((one) => slugOf(`${artist.follow.slice(7)} ${one.title}`, 90) === match[2]);
    if (album) return `/music/album/${artist.server}/${artist.key}/${album.key}`;
  }
  return "";
}

export function isMusicPath(path: string): boolean {
  return path === "/music" || path.startsWith("/music/") || path === "/api/v1/music" || FILE.test(path) || path === "/api/v1/music/released";
}

export interface MusicRoutesContext {
  hub: MusicHub;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
  /** The page shell (web/music.html), or null when the web build is absent. */
  page: () => string | null;
  /** A server says something of its label landed; null when nobody may say so. */
  released?: (request: IncomingMessage, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
}

export async function handleMusicRoutes(request: IncomingMessage, response: ServerResponse, path: string, ctx: MusicRoutesContext): Promise<boolean> {
  if (!isMusicPath(path)) return false;
  const method = request.method ?? "GET";
  if (path === "/api/v1/music/released") {
    if (method !== "POST" || !ctx.released) { ctx.json(response, 405, { error: "not like that" }); return true; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await ctx.readBody(request)) as Record<string, unknown>; } catch { ctx.json(response, 400, { error: "the body is not JSON" }); return true; }
    const answer = await ctx.released(request, body);
    ctx.json(response, answer.status, answer.body);
    return true;
  }
  if (method !== "GET" && method !== "HEAD") { ctx.json(response, 405, { error: "not like that" }); return true; }
  if (path === "/api/v1/music") {
    ctx.json(response, 200, await ctx.hub.catalogue());
    return true;
  }
  const file = FILE.exec(path);
  if (file) {
    const base = ctx.hub.resolve(file[1]!);
    if (!base) { ctx.json(response, 404, { error: "no such server" }); return true; }
    try {
      const upstream = await fetch(`${base}/api/v1/label/${file[2]}`, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok || !upstream.body) { ctx.json(response, upstream.status === 404 ? 404 : 502, { error: "not there" }); return true; }
      response.writeHead(200, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "public, max-age=3600",
        ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length")! } : {}),
      });
      if (method === "HEAD") { response.end(); return true; }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(value)) await new Promise((resolve) => response.once("drain", resolve));
      }
      response.end();
    } catch {
      if (!response.headersSent) ctx.json(response, 502, { error: "the server holding it did not answer" });
      else response.destroy();
    }
    return true;
  }
  // /music and everything under it is the app; it reads /api/v1/music.
  const page = ctx.page();
  if (!page) { ctx.json(response, 404, { error: "the music app is not built here" }); return true; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  response.end(method === "HEAD" ? undefined : page);
  return true;
}

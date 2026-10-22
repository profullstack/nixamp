/**
 * The AI label's catalogue and the music store, for the terminal and MCP.
 *
 * The catalogue is read from the server that holds the music (live.streaming
 * by default); buying and what was bought are nixamp.com's (music-store.ts),
 * with this machine's sign-in when there is one.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readSession } from "./session.ts";

export const DEFAULT_CATALOGUE = "https://live.streaming.pit.world";

export interface CatalogueSong { n: number; title: string; seconds: number; lyrics?: string }
export interface CatalogueAlbum { key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: CatalogueSong[] }
export interface CatalogueArtist { key: string; name: string; genre: string; bio: string; albums: CatalogueAlbum[] }
export interface Catalogue { holder: string; server?: string; genres: Array<{ genre: string; station: string; artists: CatalogueArtist[] }> }

export interface Bought {
  id: string; kind: "song" | "album" | "artist" | "vod"; title: string; artistName: string; server: string;
  status: string; paidAt: number; amountUsd: number; zip?: string; link?: string;
}

type Fetcher = typeof fetch;

function site(): string {
  return (readSession()?.site ?? process.env["NIXAMP_SITE"] ?? "https://nixamp.com").replace(/\/+$/, "");
}

function auth(): Record<string, string> {
  const token = readSession()?.token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function catalogue(server = DEFAULT_CATALOGUE, fetcher: Fetcher = fetch): Promise<Catalogue> {
  const response = await fetcher(`${server.replace(/\/+$/, "")}/api/v1/label`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${server} has no AI label catalogue (HTTP ${response.status})`);
  return await response.json() as Catalogue;
}

/** A /buy link read back into what it sells. */
export function fromBuyLink(link: string): Record<string, string> | null {
  try {
    const url = new URL(link);
    if (url.pathname !== "/buy") return null;
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return null;
  }
}

export async function buy(input: Record<string, unknown>, fetcher: Fetcher = fetch): Promise<{ url: string; id: string; token: string; receipt: string }> {
  const response = await fetcher(`${site()}/api/v1/store/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth() },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { url?: string; id?: string; token?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error ?? `nixamp.com answered ${response.status}`);
  return { url: body.url, id: body.id ?? "", token: body.token ?? "", receipt: `${site()}/purchases/${body.id}?t=${body.token}` };
}

export async function purchases(fetcher: Fetcher = fetch): Promise<{ email: string; purchases: Bought[] }> {
  if (!readSession()) throw new Error("not signed in: run `nixamp login` (with the email you bought with)");
  const response = await fetcher(`${site()}/api/v1/store/purchases`, { headers: auth() });
  const body = await response.json().catch(() => ({})) as { email?: string; purchases?: Bought[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `nixamp.com answered ${response.status}`);
  return { email: body.email ?? "", purchases: body.purchases ?? [] };
}

/** A purchase's zip, saved under `dir` with the name its server gives it. */
export async function download(one: Bought, dir: string, fetcher: Fetcher = fetch): Promise<string> {
  if (!one.zip) throw new Error(`"${one.title}" is not paid yet`);
  const response = await fetcher(one.zip);
  if (!response.ok || !response.body) throw new Error(`the download of "${one.title}" answered HTTP ${response.status}`);
  const named = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const name = (named ? decodeURIComponent(named) : `${one.artistName} - ${one.title}.zip`).replace(/[/\\]/g, "");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path));
  return path;
}

export const PRICE_WORDS = "a song 10¢, an album $1, everything by an artist $2";

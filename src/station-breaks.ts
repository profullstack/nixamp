/**
 * The break: a short spot between songs or films, instead of commercials.
 *
 * Asked for once per break, never per listener, and never in the middle of
 * anything (playlist-input.ts places it between entries). Where it comes
 * from, in order:
 *
 *   1. the ad network, through this server's own AD_SLOT (ads.ts), or
 *      through nixamp.com's /api/ads/next when this server has none, so a
 *      self-hosted station carries the same spot the site does and the
 *      network meters the impression;
 *   2. a house spot the operator dropped in $XDG_STATE_HOME/nixamp/ads/
 *      (spot.mp4 for TV, spot.mp3 for radio);
 *   3. nothing: no break this time, and the music goes on.
 *
 * A creative is fetched once per URL into ads/cache and played from disk:
 * https only, public addresses only, at most 50 MB.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nextAdvert, type Advert } from "./ads.ts";

const MAX_BYTES = 50 * 1024 * 1024;

export interface BreakOptions {
  dir: string;
  /** nixamp.com, when this server has no slot of its own. */
  site: string;
  hasSlot: boolean;
  guard: (url: string) => Promise<string>;
  fetcher?: typeof fetch;
  /** Injected by tests in place of the network. */
  ask?: (kind: "audio" | "video") => Promise<Advert>;
}

export class StationBreaks {
  constructor(private readonly options: BreakOptions) {}

  private async ask(kind: "audio" | "video"): Promise<Advert> {
    if (this.options.ask) return this.options.ask(kind);
    if (this.options.hasSlot) return nextAdvert(kind);
    const send = this.options.fetcher ?? fetch;
    try {
      const answer = await send(`${this.options.site.replace(/\/+$/, "")}/api/ads/next?kind=${kind}`, { signal: AbortSignal.timeout(2_000) });
      if (!answer.ok) return { url: null };
      const body = (await answer.json()) as { url?: unknown; kind?: unknown };
      return typeof body.url === "string" ? { url: body.url, kind: body.kind === "video" ? "video" : "audio" } : { url: null };
    } catch {
      return { url: null };
    }
  }

  /** A file to play for this break, or null for none. */
  async next(kind: "audio" | "video"): Promise<string | null> {
    const advert = await this.ask(kind);
    if (advert.url) {
      const cached = await this.cache(advert.url).catch(() => null);
      if (cached) return cached;
    }
    const house = join(this.options.dir, kind === "video" ? "spot.mp4" : "spot.mp3");
    return existsSync(house) ? house : null;
  }

  private async cache(url: string): Promise<string | null> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const folder = join(this.options.dir, "cache");
    const file = join(folder, `${createHash("sha1").update(url).digest("hex")}${extname(parsed.pathname).slice(0, 6) || ".mp4"}`);
    if (existsSync(file)) return file;
    if (await this.options.guard(url)) return null;
    const answer = await (this.options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(20_000) });
    if (!answer.ok || !answer.body) return null;
    if (Number(answer.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    mkdirSync(folder, { recursive: true });
    const part = `${file}.part`;
    let bytes = 0;
    const counted = Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream).on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) counted.destroy(new Error("too big"));
    });
    try {
      await pipeline(counted, createWriteStream(part));
      renameSync(part, file);
      return file;
    } catch {
      rmSync(part, { force: true });
      return null;
    }
  }
}

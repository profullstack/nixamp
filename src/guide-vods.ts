/**
 * On demand: published files on the station guide.
 *
 * A live room plays wherever the room is now; a video on demand plays from
 * its start, and a listener may seek. It is one library item of any nixamp
 * server, at the address `https://host/api/v1/library/items/<id>/play?k=KEY`
 * (library-routes.ts: the file itself when a browser takes it, else an MP4
 * made on the way). A nixamp.com member publishes one with a rights basis, as
 * a live room is published; the guide lists it under "On demand", and its
 * short link, <watchBase>/vod/<id>, is the thing to share.
 *
 * Nothing here plays anything: the file's own server does, and this only asks
 * it, now and then, whether the file is still there and what it is.
 *
 * The guide's owner may put a price on one of its own (owned or public
 * domain): watching stays free, and the page offers the file as a download,
 * bought on nixamp.com (music-store.ts, kind "vod"). The grant nixamp.com
 * signs opens /api/v1/guide/vods/<id>/download, which sends the buyer on to
 * the file's server with `download=1`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOM_BASES, type RoomBasis } from "./guide-rooms.ts";
import type { GuideEntry } from "./station-guide.ts";

export interface GuideVod {
  id: string;
  /** The file's play address, with its listen key. */
  play: string;
  name: string;
  kind: "audio" | "video";
  /** Seconds; 0 when its server did not know. */
  duration: number;
  basis: RoomBasis;
  note: string;
  /** The nixamp.com account that published it ("" for this server's owner). */
  by: string;
  publishedAt: number;
  /** What its download costs on nixamp.com, in cents; absent or 0 when it is not sold. */
  priceCents?: number;
}

/** The bases a price may be put on: what the owner may sell, not just share. */
export const SELLABLE_BASES: readonly RoomBasis[] = ["owned", "public-domain"];
/** $100: a price above that is a typo. */
export const VOD_PRICE_MAX_CENTS = 10_000;

/** Files one member may have on the guide at once, and files on it in all. */
export const VODS_PER_MEMBER = 25;
export const VODS_MAX = 1000;
const STATE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 4_000;

/**
 * A file's play address taken apart, or null when it is not one: https (http
 * only for a loopback address, for tests), a library item, a key, nothing else.
 */
export function vodAddress(input: string): { origin: string; item: string; key: string; play: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.hash) return null;
  const item = /^\/api\/v1\/library\/items\/([0-9a-f]{16})\/(?:play|stream)\/?$/.exec(url.pathname);
  if (!item) return null;
  const key = url.searchParams.get("k") ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || [...url.searchParams.keys()].some((name) => name !== "k")) return null;
  return { origin: url.origin, item: item[1]!, key, play: `${url.origin}/api/v1/library/items/${item[1]}/play?k=${key}` };
}

export const vodPage = (base: string, id: string): string => `${base}/vod/${id}`;

export class VodStore {
  private vods: GuideVod[] = [];
  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { vods?: GuideVod[] };
        this.vods = (saved.vods ?? []).filter((one) => vodAddress(one.play) !== null);
      }
    } catch {
      // Unreadable is empty; the next write replaces it.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `guide-vods-${port}.json`);
  }

  /** Newest first, the order the guide shows them. */
  list(): GuideVod[] {
    return [...this.vods].sort((a, b) => b.publishedAt - a.publishedAt);
  }

  get(id: string): GuideVod | undefined {
    return this.vods.find((one) => one.id === id);
  }

  /** Publishes a file, or refreshes the one already published at that address (its link stays). */
  put(vod: Omit<GuideVod, "id" | "publishedAt">): GuideVod {
    const existing = this.vods.find((one) => one.play === vod.play);
    const saved: GuideVod = { ...vod, id: existing?.id ?? randomBytes(6).toString("base64url"), publishedAt: existing?.publishedAt ?? Date.now() };
    this.vods = [...this.vods.filter((one) => one.play !== vod.play), saved];
    this.save();
    return saved;
  }

  remove(id: string): boolean {
    const before = this.vods.length;
    this.vods = this.vods.filter((one) => one.id !== id);
    if (this.vods.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    writeFileSync(`${this.file}.part`, `${JSON.stringify({ version: 1, vods: this.vods }, null, 2)}\n`);
    renameSync(`${this.file}.part`, this.file);
  }
}

export interface VodState {
  name: string;
  kind: "audio" | "video";
  duration: number;
  artist: string;
}

/** Asks a file's own server what it is: its library item, read with the same key. */
export class VodProbe {
  private cache = new Map<string, { at: number; state: VodState | null }>();
  /** `refuse` names why an address may not be fetched from this machine, or "" (see RoomProbe). */
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly refuse: (link: string) => Promise<string> = async () => "",
  ) {}

  async state(play: string, fresh = false): Promise<VodState | null> {
    const cached = this.cache.get(play);
    if (!fresh && cached && Date.now() - cached.at < STATE_TTL_MS) return cached.state;
    const state = await this.ask(play).catch(() => null);
    this.cache.set(play, { at: Date.now(), state });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return state;
  }

  private async ask(play: string): Promise<VodState | null> {
    const address = vodAddress(play);
    if (!address || (await this.refuse(address.play)) !== "") return null;
    const answer = await this.fetcher(`${address.origin}/api/v1/library/items/${address.item}?k=${address.key}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error" });
    if (!answer.ok) return null;
    const item = ((await answer.json()) as { item?: Record<string, unknown> }).item;
    if (!item || item["state"] !== "ready") return null;
    const rel = String(item["rel"] ?? "");
    const fallback = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? address.item;
    return {
      name: String(item["title"] || fallback).slice(0, 160),
      kind: item["video"] === true ? "video" : "audio",
      duration: Number(item["duration"]) || 0,
      artist: String(item["artist"] ?? "").slice(0, 160),
    };
  }
}

/** "1:02:03" or "4:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The published files as guide cards, newest first; one whose server no longer has it says so. */
export async function vodEntries(store: VodStore, probe: VodProbe, base: string): Promise<GuideEntry[]> {
  return Promise.all(store.list().map(async (vod) => {
    const state = await probe.state(vod.play);
    return {
      id: vod.id,
      name: vod.name,
      kind: state?.kind ?? vod.kind,
      group: "vod" as const,
      state: state ? "vod" : "offline",
      page: vodPage(base, vod.id),
      nowPlaying: { title: clock(state?.duration || vod.duration), artist: state?.artist ?? "" },
    };
  }));
}

/** One file as its page reads it: never who published it, always where it plays. */
export function vodView(vod: GuideVod, base: string, state: VodState | null): Record<string, unknown> {
  return {
    id: vod.id,
    name: vod.name,
    kind: state?.kind ?? vod.kind,
    duration: state?.duration || vod.duration,
    artist: state?.artist ?? "",
    note: vod.note,
    basis: vod.basis,
    publishedAt: vod.publishedAt,
    ...(vod.priceCents ? { priceCents: vod.priceCents } : {}),
    available: state !== null,
    play: vod.play,
    page: vodPage(base, vod.id),
  };
}

export interface VodContext {
  store: VodStore;
  probe: VodProbe;
  /** The page base for a file's link. */
  base: string;
  /** Whether the request holds this server's control key (or is its signed-in owner). */
  canControl: boolean;
  /** The nixamp.com account behind the request's session, or "". */
  member: () => Promise<string>;
  /** This server's own play address for one of its library items, for the owner publishing by id; "" when it has none. */
  ownPlay?: (item: string) => string;
  /** What this server's own library says of one of its items, so publishing it never asks itself over the network. */
  ownState?: (item: string) => VodState | null;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  /** The request body as text (server.ts readBody). */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Refused by the caller's rate limit, or null. */
  throttle?: () => { retryAfter: number } | null;
  /** nixamp.com's store grants (music-store.ts GrantVerifier), for a bought download. */
  grants?: { check: (grant: string) => Promise<{ kind: string; artist: string; server: string } | null> };
}

/** Answers /api/v1/guide/vods; false when the path is not one. */
export async function handleVods(request: IncomingMessage, response: ServerResponse, path: string, ctx: VodContext): Promise<boolean> {
  if (path !== "/api/v1/guide/vods" && !path.startsWith("/api/v1/guide/vods/")) return false;
  const method = request.method ?? "GET";
  const one = /^\/api\/v1\/guide\/vods\/([A-Za-z0-9_-]{1,32})$/.exec(path);
  const download = /^\/api\/v1\/guide\/vods\/([A-Za-z0-9_-]{1,32})\/download$/.exec(path);
  if (download && (method === "GET" || method === "HEAD")) {
    const grant = new URL(request.url ?? "/", "http://x").searchParams.get("grant") ?? "";
    const scope = ctx.grants ? await ctx.grants.check(grant) : null;
    const vod = ctx.store.get(download[1]!);
    if (!scope || scope.kind !== "vod" || scope.artist !== download[1] || scope.server !== new URL(ctx.base).origin) {
      ctx.json(response, 403, { error: "that download link has expired or is not one of ours: open your purchase again for a fresh one", code: "bad_grant" });
      return true;
    }
    if (!vod) {
      ctx.json(response, 404, { error: "that video has been taken off this guide", code: "not_found" });
      return true;
    }
    // The file's own server sends it, as an attachment.
    response.writeHead(302, { location: `${vod.play}&download=1`, "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
    response.end();
    return true;
  }
  if (method === "GET" || method === "HEAD") {
    if (path === "/api/v1/guide/vods") {
      ctx.json(response, 200, { vods: await vodEntries(ctx.store, ctx.probe, ctx.base) });
      return true;
    }
    const vod = one ? ctx.store.get(one[1]!) : undefined;
    if (!vod) {
      ctx.json(response, 404, { error: "no such video on this guide", code: "not_found" });
      return true;
    }
    ctx.json(response, 200, { vod: vodView(vod, ctx.base, await ctx.probe.state(vod.play)) });
    return true;
  }
  const by = ctx.canControl ? "" : await ctx.member();
  if (!ctx.canControl && by === "") {
    ctx.json(response, 401, { error: "sign in to nixamp.com to publish a video", code: "sign_in" });
    return true;
  }
  const refused = ctx.throttle?.();
  if (refused) {
    response.setHeader("retry-after", String(refused.retryAfter));
    ctx.json(response, 429, { error: "too many changes; wait a moment", code: "throttled" });
    return true;
  }
  if (path === "/api/v1/guide/vods" && method === "POST") {
    const raw = await ctx.readBody(request).catch(() => null);
    const body = (typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw) as
      { play?: unknown; item?: unknown; basis?: unknown; note?: unknown; title?: unknown; agree?: unknown; price?: unknown } | null;
    // The owner may name one of this server's own items; everybody else hands over the address.
    const own = ctx.canControl && typeof body?.item === "string" && /^[0-9a-f]{16}$/.test(body.item) && ctx.ownPlay ? ctx.ownPlay(body.item) : "";
    const address = vodAddress(own || (typeof body?.play === "string" ? body.play : ""));
    if (!address) {
      ctx.json(response, 400, { error: "play must be a nixamp file's address: https://host/api/v1/library/items/<id>/play?k=KEY", code: "bad_address" });
      return true;
    }
    const basis = ROOM_BASES.find((b) => b === body?.basis);
    if (!basis || body?.agree !== true) {
      ctx.json(response, 400, { error: "say why it may be shared (owned, permission, licensed, creative-commons or public-domain) and agree", code: "basis_required" });
      return true;
    }
    const state = (own && ctx.ownState ? ctx.ownState(String(body?.item)) : null) ?? await ctx.probe.state(address.play, true);
    if (!state) {
      ctx.json(response, 404, { error: "that file is not in its server's library, or the key does not open it", code: "not_found" });
      return true;
    }
    const all = ctx.store.list();
    const taken = all.find((v) => v.play === address.play);
    if (taken && taken.by !== by && !ctx.canControl) {
      ctx.json(response, 409, { error: "somebody else published that file", code: "taken" });
      return true;
    }
    if (by !== "" && all.filter((v) => v.by === by && v.play !== address.play).length >= VODS_PER_MEMBER) {
      ctx.json(response, 409, { error: `a member may have ${VODS_PER_MEMBER} videos on the guide; take one off first`, code: "too_many" });
      return true;
    }
    if (!taken && all.length >= VODS_MAX) {
      ctx.json(response, 409, { error: "the guide is full", code: "full" });
      return true;
    }
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 160) : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
    const owner = taken?.by ?? by;
    // A price, in dollars: only the owner, only on its own, only what it may sell. Left out, the old one stays.
    let priceCents = taken?.priceCents ?? 0;
    if (body?.price !== undefined && body.price !== null) {
      const cents = Math.round(Number(body.price) * 100);
      if (!ctx.canControl || owner !== "") {
        ctx.json(response, 403, { error: "only the guide's owner sells downloads, of what it published itself", code: "not_owner" });
        return true;
      }
      if (!Number.isFinite(cents) || cents < 0 || cents > VOD_PRICE_MAX_CENTS) {
        ctx.json(response, 400, { error: `price is in dollars, 0 (not sold) to ${VOD_PRICE_MAX_CENTS / 100}`, code: "bad_price" });
        return true;
      }
      if (cents > 0 && !SELLABLE_BASES.includes(basis)) {
        ctx.json(response, 400, { error: `a download may be sold only of what you own or what is in the public domain, not ${basis}`, code: "not_sellable" });
        return true;
      }
      priceCents = cents;
    }
    if (priceCents > 0 && !SELLABLE_BASES.includes(basis)) priceCents = 0;
    // Published again without a title or a note keeps the ones it had (a price added later changes nothing else).
    const vod = ctx.store.put({ play: address.play, name: title || taken?.name || state.name, kind: state.kind, duration: state.duration, basis, note: note || taken?.note || "", by: owner, ...(priceCents > 0 ? { priceCents } : {}) });
    ctx.json(response, 200, { vod: vodView(vod, ctx.base, state), page: vodPage(ctx.base, vod.id) });
    return true;
  }
  if (one && method === "DELETE") {
    const vod = ctx.store.get(one[1]!);
    if (!vod || (!ctx.canControl && vod.by !== by)) {
      ctx.json(response, 404, { error: "no such video of yours on the guide", code: "not_found" });
      return true;
    }
    ctx.store.remove(vod.id);
    ctx.json(response, 200, { removed: vod.id });
    return true;
  }
  ctx.json(response, 405, { error: "method not allowed", code: "method_not_allowed" });
  return true;
}

/**
 * Live rooms on the station guide.
 *
 * A room is a channel, or the live stream, of any nixamp server: the address
 * a Share or a "?play=" link carries, `https://host:port/api/channels/<id>?k=KEY`
 * or `https://host:port/api/live?k=KEY`. A nixamp.com member publishes one with
 * a rights basis, as a station is published; the guide lists it beside the
 * stations, and its card opens /watch?play=<that address>, which plays it as
 * a film or as radio, whichever it carries.
 *
 * Nothing here plays anything: the room's own server does, and this only asks
 * it, now and then, whether the room is on the air and what is on it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readConfig } from "./library.ts";
import type { GuideEntry } from "./station-guide.ts";

/** Why a room may be broadcast, the same five reasons a station gives. */
export const ROOM_BASES = ["owned", "permission", "licensed", "creative-commons", "public-domain"] as const;
export type RoomBasis = typeof ROOM_BASES[number];

export interface GuideRoom {
  id: string;
  /** The room's stream address, with its listen key. */
  play: string;
  name: string;
  kind: "audio" | "video";
  basis: RoomBasis;
  note: string;
  /** The nixamp.com account that published it ("" for this server's owner). */
  by: string;
  publishedAt: number;
}

/** Rooms one member may have on the guide at once, and rooms on it in all. */
export const ROOMS_PER_MEMBER = 5;
export const ROOMS_MAX = 200;
const STATE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;

/**
 * A room's address taken apart, or null when it is not one: https (http only
 * for a loopback address, for tests), a channel or the live stream, a key,
 * and nothing else in the query.
 */
export function roomAddress(input: string): { origin: string; channel: string | null; key: string; play: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.hash) return null;
  const channel = /^\/api\/channels\/([A-Za-z0-9._~-]{1,120})\/?$/.exec(url.pathname);
  const live = /^\/api\/live\/?$/.test(url.pathname);
  if (!channel && !live) return null;
  const key = url.searchParams.get("k") ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || [...url.searchParams.keys()].some((name) => name !== "k")) return null;
  const path = channel ? `/api/channels/${channel[1]}` : "/api/live";
  return { origin: url.origin, channel: channel ? channel[1]! : null, key, play: `${url.origin}${path}?k=${key}` };
}

/** Where the guide links a room's page: config `watchBase`, NIXAMP_WATCH_BASE, else this server. */
export function watchBase(fallback: string, env: Record<string, string | undefined> = process.env): string {
  const saved = (() => { try { return readConfig().watchBase ?? ""; } catch { return ""; } })();
  const chosen = (env["NIXAMP_WATCH_BASE"] || saved || fallback).trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s"<>]+$/.test(chosen) ? chosen : fallback;
}

export const watchPage = (base: string, play: string): string => `${base}/watch?play=${encodeURIComponent(play)}`;

export class RoomStore {
  private rooms: GuideRoom[] = [];
  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { rooms?: GuideRoom[] };
        this.rooms = (saved.rooms ?? []).filter((one) => roomAddress(one.play) !== null);
      }
    } catch {
      // Unreadable is empty; the next write replaces it.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `guide-rooms-${port}.json`);
  }

  list(): GuideRoom[] {
    return [...this.rooms];
  }

  get(id: string): GuideRoom | undefined {
    return this.rooms.find((one) => one.id === id);
  }

  /** Publishes a room, or refreshes the one already published at that address. */
  put(room: Omit<GuideRoom, "id" | "publishedAt">): GuideRoom {
    const existing = this.rooms.find((one) => one.play === room.play);
    const saved: GuideRoom = { ...room, id: existing?.id ?? randomBytes(6).toString("base64url"), publishedAt: Date.now() };
    this.rooms = [...this.rooms.filter((one) => one.play !== room.play), saved];
    this.save();
    return saved;
  }

  remove(id: string): boolean {
    const before = this.rooms.length;
    this.rooms = this.rooms.filter((one) => one.id !== id);
    if (this.rooms.length === before) return false;
    this.save();
    return true;
  }

  private save(): void {
    writeFileSync(`${this.file}.part`, `${JSON.stringify({ version: 1, rooms: this.rooms }, null, 2)}\n`);
    renameSync(`${this.file}.part`, this.file);
  }
}

export interface RoomState {
  /** Whether the room's server says it is on the air. */
  live: boolean;
  name: string;
  kind: "audio" | "video";
  nowPlaying: { title: string; artist: string } | null;
}

interface ChannelRow {
  id: string;
  name?: string;
  kind?: string;
  live?: boolean;
  codecs?: { tags?: { title?: string; artist?: string } };
}

/** Asks a room's own server what is on it: its channel list for a channel, the stream's headers for the live stream. */
export class RoomProbe {
  private cache = new Map<string, { at: number; state: RoomState | null }>();
  /**
   * `refuse` names why an address may not be fetched from this machine (a
   * private or loopback network), or "": a member chooses the address, and
   * this server must not become their way into its own network.
   */
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly refuse: (link: string) => Promise<string> = async () => "",
  ) {}

  async state(play: string, fresh = false): Promise<RoomState | null> {
    const cached = this.cache.get(play);
    if (!fresh && cached && Date.now() - cached.at < STATE_TTL_MS) return cached.state;
    const state = await this.ask(play).catch(() => null);
    this.cache.set(play, { at: Date.now(), state });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return state;
  }

  private async ask(play: string): Promise<RoomState | null> {
    const address = roomAddress(play);
    if (!address || (await this.refuse(address.play)) !== "") return null;
    if (address.channel !== null) {
      const answer = await this.fetcher(`${address.origin}/api/channels?k=${address.key}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error" });
      if (!answer.ok) return null;
      const body = (await answer.json()) as { channels?: ChannelRow[] };
      const row = (body.channels ?? []).find((one) => one.id === address.channel);
      if (!row) return null;
      const tags = row.codecs?.tags;
      return {
        live: row.live !== false,
        name: String(row.name ?? address.channel).replace(/\/+$/, "").slice(0, 120),
        kind: row.kind === "video" ? "video" : "audio",
        nowPlaying: tags && (tags.title || tags.artist) ? { title: String(tags.title ?? ""), artist: String(tags.artist ?? "") } : null,
      };
    }
    // The live stream: on the air when it answers with media.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const answer = await this.fetcher(address.play, { signal: controller.signal, redirect: "error" });
      const type = answer.headers.get("content-type") ?? "";
      controller.abort();
      if (!answer.ok) return null;
      return { live: true, name: "Live", kind: type.startsWith("video/") ? "video" : "audio", nowPlaying: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The rooms as guide cards: the page to open, on the air or not, and what is on. */
export async function roomEntries(store: RoomStore, probe: RoomProbe, base: string): Promise<GuideEntry[]> {
  return Promise.all(store.list().map(async (room) => {
    const state = await probe.state(room.play);
    return {
      id: room.id,
      name: room.name,
      kind: state?.kind ?? room.kind,
      group: "rooms" as const,
      state: state?.live ? "live" : "offline",
      page: watchPage(base, room.play),
      nowPlaying: state?.nowPlaying ?? null,
    };
  }));
}

export interface RoomContext {
  store: RoomStore;
  probe: RoomProbe;
  /** The page base for a room's card. */
  base: string;
  /** Whether the request holds this server's control key (or is its signed-in owner). */
  canControl: boolean;
  /** The nixamp.com account behind the request's session, or "". */
  member: () => Promise<string>;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Refused by the caller's rate limit, or null. */
  throttle?: () => { retryAfter: number } | null;
}

/** Answers /api/v1/guide/rooms; false when the path is not one. */
export async function handleRooms(request: IncomingMessage, response: ServerResponse, path: string, ctx: RoomContext): Promise<boolean> {
  if (path !== "/api/v1/guide/rooms" && !path.startsWith("/api/v1/guide/rooms/")) return false;
  const method = request.method ?? "GET";
  if (path === "/api/v1/guide/rooms" && (method === "GET" || method === "HEAD")) {
    ctx.json(response, 200, { rooms: await roomEntries(ctx.store, ctx.probe, ctx.base) });
    return true;
  }
  const by = ctx.canControl ? "" : await ctx.member();
  if (!ctx.canControl && by === "") {
    ctx.json(response, 401, { error: "sign in to nixamp.com to publish a live room", code: "sign_in" });
    return true;
  }
  const refused = ctx.throttle?.();
  if (refused) {
    response.setHeader("retry-after", String(refused.retryAfter));
    ctx.json(response, 429, { error: "too many changes; wait a moment", code: "throttled" });
    return true;
  }
  if (path === "/api/v1/guide/rooms" && method === "POST") {
    const body = (await ctx.readBody(request).catch(() => null)) as { play?: unknown; basis?: unknown; note?: unknown; title?: unknown; agree?: unknown } | null;
    const address = roomAddress(typeof body?.play === "string" ? body.play : "");
    if (!address) {
      ctx.json(response, 400, { error: "play must be a nixamp room's stream address: https://host/api/channels/<id>?k=KEY", code: "bad_address" });
      return true;
    }
    const basis = ROOM_BASES.find((one) => one === body?.basis);
    if (!basis || body?.agree !== true) {
      ctx.json(response, 400, { error: "say why it may be broadcast (owned, permission, licensed, creative-commons or public-domain) and agree", code: "basis_required" });
      return true;
    }
    const state = await ctx.probe.state(address.play, true);
    if (!state) {
      ctx.json(response, 404, { error: "that room is not on its server, or the key does not open it", code: "not_found" });
      return true;
    }
    const all = ctx.store.list();
    const mine = all.filter((one) => one.by === by && one.play !== address.play);
    if (by !== "" && mine.length >= ROOMS_PER_MEMBER) {
      ctx.json(response, 409, { error: `a member may have ${ROOMS_PER_MEMBER} rooms on the guide; take one off first`, code: "too_many" });
      return true;
    }
    if (!all.some((one) => one.play === address.play) && all.length >= ROOMS_MAX) {
      ctx.json(response, 409, { error: "the guide is full", code: "full" });
      return true;
    }
    const taken = all.find((one) => one.play === address.play);
    if (taken && taken.by !== by && !ctx.canControl) {
      ctx.json(response, 409, { error: "somebody else published that room", code: "taken" });
      return true;
    }
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
    const room = ctx.store.put({ play: address.play, name: title || state.name, kind: state.kind, basis, note, by: taken?.by ?? by });
    ctx.json(response, 200, { room: { id: room.id, name: room.name, kind: room.kind, basis: room.basis }, page: watchPage(ctx.base, room.play) });
    return true;
  }
  const one = /^\/api\/v1\/guide\/rooms\/([A-Za-z0-9_-]{1,32})$/.exec(path);
  if (one && method === "DELETE") {
    const room = ctx.store.get(one[1]!);
    if (!room || (!ctx.canControl && room.by !== by)) {
      ctx.json(response, 404, { error: "no such room of yours on the guide", code: "not_found" });
      return true;
    }
    ctx.store.remove(room.id);
    ctx.json(response, 200, { removed: room.id });
    return true;
  }
  ctx.json(response, 405, { error: "method not allowed", code: "method_not_allowed" });
  return true;
}

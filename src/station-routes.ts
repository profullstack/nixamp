/**
 * /api/v1/stations: making, running and sharing stations.
 *
 * Two kinds of caller, kept apart. The owner -- the control key, or the
 * nixamp.com account that owns this server -- manages: create, edit, start,
 * stop, skip, share. A listener holds one station's link and may do three
 * things with it: hear the stream, ask what is on, and fetch an .m3u for
 * another player. A listener's link never opens the library, another station,
 * or anything that changes what is playing.
 *
 * Errors carry a stable `code` beside the sentence, so the page, the CLI and
 * an agent over MCP can each tell "rights_required" from "not_found" without
 * reading English.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Channels } from "./channels.ts";
import type { StationRunner } from "./station-runner.ts";
import { alertsFor, type Limits, type StationUsage } from "./station-metering.ts";
import { aiFromTags, type TrackFacts } from "./track-facts.ts";
import type { Lyrics } from "./lyrics.ts";
import type { PublishReport } from "./lyrics-publish.ts";
import { quietDuringBreaks } from "./break-silence.ts";
import { PASS_PARAM } from "./listen-pass.ts";
import { watchBase } from "./guide-rooms.ts";
import { radioPeers, radioStations } from "./radio-pages.ts";
import {
  StationError, channelOf, tokensMatch, type OwnerStation, type PublicStation, type Station, type StationStore,
} from "./stations.ts";

/** The three things a station's link opens. */
const LISTEN = /^\/api\/v1\/stations\/([a-z0-9]{10})\/(stream|state|listen\.m3u|events|now|art|lyrics)$/;

/** Whether this path is one a station's own link may open, without the server's key. */
export function isStationListenPath(path: string): boolean {
  return LISTEN.test(path) || path === "/api/v1/stations/guide";
}

export interface StationContext {
  store: StationStore;
  runner: StationRunner;
  channels: Channels;
  /** Holds the control key, or is signed in as this server's owner. */
  canControl: boolean;
  /** The nixamp.com account asking, "" when it is the control key. */
  account: string;
  /** Files chosen by track index or by folder; null when neither was given. */
  select: (body: { items?: unknown; folder?: unknown }) => string[] | null;
  /** What the library knows about a file, for now playing. */
  trackFor: (file: string) => { title: string; artist: string; album: string } | null;
  /** Whether the library knows this file as moving picture; absent in tests that do not care. */
  isVideo?: (file: string) => boolean;
  /** This server's address as the asker reached it, for links. */
  base: string;
  /**
   * This server's public https address, for links that leave this request's
   * host: the guide is often shown under another name (a Moshpit name through
   * a gateway), and a station is listened to here, not there.
   */
  publicBase?: string;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
  /** Headers every answer carries (CORS). */
  headers: Record<string, string>;
  /** Metering and limits; absent in tests that do not care. */
  usage?: StationUsage;
  limits?: Limits;
  /** Null to go ahead with a change, or how long to wait (control rate limit). */
  throttle?: () => { retryAfter: number } | null;
  /** What a listener may know about the track on the air (track-facts.ts). */
  facts?: (station: Station, file: string) => Promise<TrackFacts>;
  /** How long a file is, in seconds (the library's probe); 0 when unknown. For the page's progress bar. */
  durationOf?: (file: string) => number;
  /** The cover picture inside a file (JPEG/PNG bytes), or null. */
  cover?: (file: string) => Promise<{ bytes: Buffer; type: string } | null>;
  /** The words of a file, from its tags or nichedb; null when none are known. */
  lyrics?: (station: Station, file: string) => Promise<Lyrics | null>;
  /** Our own songs' words, published back to nichedb (lyrics-publish.ts). */
  lyricsPublisher?: { status: () => unknown; publish: (station: Station) => Promise<PublishReport> };
  /** Whether a listen pass is good: its holder hears silence in place of a radio station's breaks. */
  passes?: { good: (pass: string) => Promise<boolean> };
  /** Auto stations: run a sync with these settings (and keep them), or read them. */
  auto?: { sync: (input: Record<string, unknown>) => Promise<unknown>; setting: () => unknown };
  /** The public stations other servers list (guide peers); absent when there are none. */
  peers?: () => Promise<unknown[]>;
  /** Live rooms members published to this guide (guide-rooms.ts); absent when this server keeps none. */
  rooms?: () => Promise<unknown[]>;
}

function fail(ctx: StationContext, response: ServerResponse, error: unknown): void {
  if (error instanceof StationError) {
    ctx.json(response, error.status, { error: error.message, code: error.code });
    return;
  }
  ctx.json(response, 500, { error: error instanceof Error ? error.message : String(error), code: "internal" });
}

function links(ctx: StationContext, station: Station, base = ctx.base): { page: string; stream: string; m3u: string; state: string } {
  const query = `t=${encodeURIComponent(station.listenToken)}`;
  const at = `${base}/api/v1/stations/${station.id}`;
  return {
    page: `${base}/station/${station.id}?${query}`,
    stream: `${at}/stream?${query}`,
    m3u: `${at}/listen.m3u?${query}`,
    state: `${at}/state?${query}`,
  };
}

/** The file on the air now, as the channel's own encoder last reported it. */
function nowPlayingFile(ctx: StationContext, station: Station): string {
  const info = ctx.channels.info(channelOf(station.id));
  if (!info?.playlist?.length) return "";
  return info.playlist[info.playlistAt ?? 0] ?? "";
}

export function publicView(ctx: StationContext, station: Station): PublicStation {
  const state = ctx.runner.observed(station.id);
  // Asleep, what it will wake on: the first listener hears that next.
  const asleep = ctx.runner.isSleeping?.(station.id) ?? false;
  const file = asleep ? ctx.runner.nextUp(station.id) : state === "live" || state === "recovering" ? nowPlayingFile(ctx, station) : "";
  // The tags the player read when it put this file on, else the library's.
  const track = file ? (ctx.channels.tagsOf(channelOf(station.id), file) ?? ctx.trackFor(file)) : null;
  // What the channel is carrying wins over the flag: a station made by hand
  // from films streams video whether or not anyone said so.
  const video = station.video || ctx.channels.kindOf(channelOf(station.id)) === "video";
  // How far into the song (or film) on the air, by the encoder's clock, and how long it is.
  const position = file && !asleep ? ctx.channels.info(channelOf(station.id))?.position : undefined;
  const duration = file && ctx.durationOf ? ctx.durationOf(file) : 0;
  const progress = typeof position === "number" && duration > 0 ? { position: Math.round(Math.min(position, duration) * 10) / 10, duration: Math.round(duration * 10) / 10 } : null;
  return {
    id: station.id,
    name: station.name,
    description: station.description,
    visibility: station.visibility,
    state,
    // Tags, or nothing: a bare file name is the owner's, not the public's.
    nowPlaying: track && (track.title || track.artist) ? track : null,
    progress,
    kind: video ? "video" : "audio",
    format: state === "stopped" || state === "offline" ? null : video
      ? { codec: "h264+aac", bitrateKbps: station.bitrate, sampleRate: 48_000, channels: 2 }
      : { codec: "mp3", bitrateKbps: station.bitrate, sampleRate: 48_000, channels: 2 },
    listeners: ctx.runner.listeners(station.id),
  };
}

/** Where the guide puts a station: composed by AI, shared by listeners, or the owner's radio or TV. */
export type GuideGroup = "ai" | "shared" | "radio" | "tv";

export function guideGroup(station: Station): GuideGroup {
  if (station.auto.startsWith("ai:")) return "ai";
  // A station whose owner declared the music AI-made ("made with Suno") is AI radio too.
  if (station.rights?.basis === "owned" && aiFromTags({ comment: station.rights.note })) return "ai";
  if (station.auto.startsWith("share:")) return "shared";
  return station.video ? "tv" : "radio";
}

/** What the public guide shows: public, listed stations, linked at this server's public address. */
export function guideEntries(ctx: StationContext): Array<PublicStation & { page: string; m3u: string; group: GuideGroup; radio: string }> {
  const base = ctx.publicBase || ctx.base;
  // Its shareable page too: /radio/<name> on the guide's public address (radio-pages.ts).
  const radioBase = watchBase(base);
  const names = radioStations(ctx.store.list());
  return [...names].map(([slug, one]) => ({ ...publicView(ctx, one), page: links(ctx, one, base).page, m3u: links(ctx, one, base).m3u, group: guideGroup(one), radio: `${radioBase}/radio/${slug}` }));
}

export function ownerView(ctx: StationContext, station: Station): OwnerStation & { links: ReturnType<typeof links>; nowPlaying: string; sleeping: boolean } {
  const { failures, idempotencyKey: _key, ...rest } = station;
  return {
    ...rest,
    state: ctx.runner.observed(station.id),
    // On the air with nobody listening: no encoder until somebody does.
    sleeping: ctx.runner.isSleeping?.(station.id) ?? false,
    excluded: Object.entries(failures).filter(([, count]) => count >= 3).map(([file]) => file),
    listeners: ctx.runner.listeners(station.id),
    error: ctx.runner.error(station.id),
    links: links(ctx, station),
    nowPlaying: nowPlayingFile(ctx, station),
    ...(ctx.usage && ctx.limits ? {
      metrics: { listeners: ctx.usage.listeners(station.id), month: ctx.usage.thisMonth(station.id), limits: ctx.limits },
      alerts: alertsFor(station, ctx.runner.observed(station.id), ctx.runner.downSince(station.id), ctx.usage.thisMonth(station.id), ctx.limits),
    } : {}),
  };
}

/** Answers anything under /api/v1/stations; false when the path is not one. */
export async function handleStations(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  ctx: StationContext,
): Promise<boolean> {
  if (path !== "/api/v1/stations" && !path.startsWith("/api/v1/stations/")) return false;
  const method = request.method ?? "GET";

  // The public guide: only stations their owner made public and listed, with
  // their links, because public is what that means. Nothing else, ever.
  // A peer asking for this one's (?local=1) gets this server's stations only.
  if (path === "/api/v1/stations/guide" && (method === "GET" || method === "HEAD")) {
    const own = guideEntries(ctx);
    const shown = new Set(own.map((one) => one.page));
    const others = url.searchParams.has("local") || !ctx.peers ? [] : (await ctx.peers())
      .filter((one) => !shown.has((one as { page: string }).page));
    // Rooms are this guide's own; a peer asking for its stations does not list them twice.
    const rooms = url.searchParams.has("local") || !ctx.rooms ? [] : await ctx.rooms();
    if (url.searchParams.has("radio")) {
      // The public guide's own list: every station by its /radio name, no
      // server address or token in it (radio-pages.ts). Peers ask without it.
      const radioBase = watchBase(ctx.publicBase || ctx.base);
      const peerNames = radioPeers(radioStations(ctx.store.list()).keys(), others as Parameters<typeof radioPeers>[1]);
      const peerPage = new Map([...peerNames].map(([slug, one]) => [`${one.origin}/${one.id}`, `${radioBase}/radio/${slug}`]));
      const pageOf = (page: string): string => {
        try {
          const at = new URL(page);
          return peerPage.get(`${at.origin}/${at.pathname.split("/")[2] ?? ""}`) ?? "";
        } catch {
          return "";
        }
      };
      ctx.json(response, 200, { stations: [
        ...rooms,
        ...own.map(({ m3u: _m3u, page: _page, ...one }) => ({ ...one, page: one.radio })),
        ...others.map((one) => ({ ...(one as Record<string, unknown>), page: pageOf((one as { page: string }).page) })).filter((one) => one.page),
      ] });
      return true;
    }
    ctx.json(response, 200, { stations: [...rooms, ...own, ...others] });
    return true;
  }

  const listen = LISTEN.exec(path);
  if (listen) {
    const station = ctx.store.get(listen[1]!);
    const token = url.searchParams.get("t") ?? "";
    // The same answer for "no such station" and "not with that link", so a
    // link cannot be used to find out which stations exist.
    const allowed = station !== undefined &&
      (ctx.canControl || (station.visibility !== "private" && token !== "" && tokensMatch(token, station.listenToken)));
    if (!station || !allowed) {
      ctx.json(response, 404, { error: "no such station, or not with that link", code: "not_found" });
      return true;
    }
    if (method !== "GET" && method !== "HEAD") {
      ctx.json(response, 405, { error: "a station's link can listen, not drive", code: "method_not_allowed" });
      return true;
    }
    const what = listen[2];
    if (what === "events") {
      // Now playing as it changes, for a player to show when its own sound
      // gets there: each "now" is sent when the station's encoder moves on to
      // the next file, and a listener is behind that by its own buffer.
      response.writeHead(200, {
        ...ctx.headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      let instance = 0;
      let lastFile = nowPlayingFile(ctx, station);
      let lastState = ctx.runner.observed(station.id);
      const send = (event: string, data: unknown): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const now = (): Record<string, unknown> => {
        const view = publicView(ctx, station);
        return { station: station.id, playback: `${station.id}:${ctx.channels.info(channelOf(station.id))?.startedAt ?? 0}`, track: `${station.id}:${instance}`, at: Date.now(), state: view.state, nowPlaying: view.nowPlaying };
      };
      // Each "now" carries what is known about the track: who made it, AI or
      // not, whose copyright, how to support them.
      const withFacts = async (): Promise<Record<string, unknown>> => {
        const payload = now();
        const file = nowPlayingFile(ctx, station);
        if (!ctx.facts || !file) return payload;
        try {
          return { ...payload, facts: await ctx.facts(station, file) };
        } catch {
          return payload;
        }
      };
      void withFacts().then((payload) => send("hello", payload));
      const tick = setInterval(() => {
        const current = ctx.store.get(station.id);
        if (!current) {
          response.end();
          return;
        }
        const file = nowPlayingFile(ctx, current);
        const state = ctx.runner.observed(current.id);
        if (file !== lastFile) {
          lastFile = file;
          instance += 1;
          void withFacts().then((payload) => send("now", payload));
        } else if (state !== lastState) {
          send("state", now());
        }
        lastState = state;
      }, 500);
      tick.unref?.();
      const beat = setInterval(() => response.write(": beat\n\n"), 20_000);
      beat.unref?.();
      const untrack = ctx.runner.track(station.id, { end: () => response.end() });
      const leave = (): void => {
        clearInterval(tick);
        clearInterval(beat);
        untrack();
      };
      request.on("close", leave);
      response.on("close", leave);
      return true;
    }
    if (what === "art") {
      const file = nowPlayingFile(ctx, station);
      const picture = file && ctx.cover ? await ctx.cover(file).catch(() => null) : null;
      if (!picture) {
        ctx.json(response, 404, { error: "no cover for what is playing", code: "not_found" });
        return true;
      }
      // The address carries which track (?f=), so a cover may be kept a while.
      response.writeHead(200, { ...ctx.headers, "content-type": picture.type, "content-length": picture.bytes.length, "cache-control": "public, max-age=3600" });
      response.end(method === "HEAD" ? undefined : picture.bytes);
      return true;
    }
    if (what === "lyrics") {
      const file = ctx.runner.observed(station.id) === "live" || ctx.runner.observed(station.id) === "recovering" ? nowPlayingFile(ctx, station) : "";
      const lyrics = file && ctx.lyrics ? await ctx.lyrics(station, file).catch(() => null) : null;
      if (!lyrics) {
        ctx.json(response, 404, { error: "no lyrics for what is playing", code: "not_found" });
        return true;
      }
      ctx.json(response, 200, { lyrics: { title: lyrics.title, artist: lyrics.artist, text: lyrics.text, source: lyrics.source, language: lyrics.language, ...(lyrics.synced ? { synced: lyrics.synced } : {}) } });
      return true;
    }
    if (what === "now") {
      const file = ctx.runner.observed(station.id) === "live" || ctx.runner.observed(station.id) === "recovering" ? nowPlayingFile(ctx, station) : "";
      ctx.json(response, 200, { station: station.id, facts: file && ctx.facts ? await ctx.facts(station, file).catch(() => null) : null });
      return true;
    }
    if (what === "state") {
      ctx.json(response, 200, publicView(ctx, station));
      return true;
    }
    if (what === "listen.m3u") {
      const stream = links(ctx, station).stream;
      response.writeHead(200, {
        ...ctx.headers,
        "content-type": "audio/x-mpegurl; charset=utf-8",
        "content-disposition": `inline; filename="${station.id}.m3u"`,
        "cache-control": "no-store",
      });
      response.end(`#EXTM3U\n#EXTINF:-1,${station.name.replace(/[\r\n]/g, " ")}\n${stream}\n`);
      return true;
    }
    const channelId = channelOf(station.id);
    // Asleep, a HEAD is told what it would get without waking it.
    if (method === "HEAD" && ctx.runner.isSleeping?.(station.id)) {
      response.writeHead(200, { ...ctx.headers, "content-type": station.video ? "video/mp4" : "audio/mpeg", "cache-control": "no-store" });
      response.end();
      return true;
    }
    // Admitted only within the station's and the server's limits, and the
    // month's allowance; refused with what to do about it. Before waking it:
    // a listener turned away is no reason to start the encoder.
    const refused = method === "GET" && ctx.usage && ctx.limits ? ctx.usage.admit(station.id, ctx.limits) : null;
    if (refused) {
      response.writeHead(refused.status, { ...ctx.headers, "content-type": "application/json; charset=utf-8", "retry-after": String(refused.retryAfter) });
      response.end(JSON.stringify({ error: refused.error, code: refused.code, retryAfter: refused.retryAfter }));
      return true;
    }
    // The first listener wakes a sleeping station, and is held until it
    // starts sending, so they hear it begin rather than a stream that ends.
    let closed = false;
    response.once("close", () => { closed = true; });
    await ctx.runner.awake?.(station.id, undefined, () => closed);
    if (closed) return true;
    if (!ctx.channels.has(channelId)) {
      ctx.json(response, 503, { error: "the station is not on the air", code: "not_live", state: ctx.runner.observed(station.id) });
      return true;
    }
    // Signed in at nixamp.com: no breaks, starting a little behind live so
    // they can be left out without a gap. Radio only (Channel.listenWithoutBreaks).
    const pass = url.searchParams.get(PASS_PARAM) ?? "";
    const spared = method === "GET" && !station.video && pass !== "" && ctx.passes ? await ctx.passes.good(pass).catch(() => false) : false;
    response.writeHead(200, { ...ctx.headers, "content-type": ctx.channels.contentType(channelId), "cache-control": "no-store" });
    if (method === "HEAD") {
      response.end();
      return true;
    }
    // Every byte that goes out through the link is counted against the station.
    const usage = ctx.usage;
    const metered = usage
      ? {
          write: (chunk: Buffer): boolean => {
            usage.delivered(station.id, chunk.length);
            return response.write(chunk);
          },
          end: (): void => { response.end(); },
          pending: (): number => response.writableLength,
        }
      : response;
    const detach = spared
      ? ctx.channels.listenWithoutBreaks(channelId, metered, station.bitrate, (out) => quietDuringBreaks(out, station.bitrate, () => true))
      : ctx.channels.listen(channelId, metered);
    if (detach === null) {
      response.end();
      return true;
    }
    const left = usage?.joined(station.id);
    const untrack = ctx.runner.track(station.id, { end: () => response.destroy() });
    let gone = false;
    const leave = (): void => {
      if (gone) return;
      gone = true;
      detach();
      untrack();
      left?.();
    };
    request.on("close", leave);
    response.on("close", leave);
    return true;
  }

  // Everything else is the owner's.
  if (!ctx.canControl) {
    ctx.json(response, 403, { error: "only this server's owner manages its stations", code: "forbidden" });
    return true;
  }
  // Changes are limited apart from listening, so neither starves the other.
  if (method !== "GET" && ctx.throttle) {
    const wait = ctx.throttle();
    if (wait) {
      response.setHeader("retry-after", String(wait.retryAfter));
      ctx.json(response, 429, { error: "too many changes at once; wait a moment", code: "rate_limited", retryAfter: wait.retryAfter });
      return true;
    }
  }

  const body = async (): Promise<Record<string, unknown>> => {
    if (method === "GET" || method === "DELETE") return {};
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
  };

  try {
    if (path === "/api/v1/stations") {
      if (method === "GET") {
        const all = ctx.store.list();
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        ctx.json(response, 200, { stations: all.slice(offset, offset + limit).map((one) => ownerView(ctx, one)), total: all.length, limit, offset });
        return true;
      }
      if (method === "POST") {
        const input = await body();
        const key = String(request.headers["idempotency-key"] ?? input["idempotencyKey"] ?? "").trim();
        const again = ctx.store.byIdempotencyKey(key);
        if (again) {
          ctx.json(response, 200, { station: ownerView(ctx, again), created: false });
          return true;
        }
        const items = ctx.select(input);
        if (items === null) throw new StationError("items_required", "choose files by track index (items) or a folder");
        // Unsaid, a station is TV when most of its files are.
        if (input["video"] === undefined && ctx.isVideo) {
          input["video"] = items.filter((file) => ctx.isVideo!(file)).length * 2 > items.length;
        }
        const station = ctx.store.create(input, items, ctx.account, Date.now(), key);
        ctx.json(response, 201, { station: ownerView(ctx, station), created: true });
        return true;
      }
      ctx.json(response, 405, { error: "GET or POST", code: "method_not_allowed" });
      return true;
    }

    if (path === "/api/v1/stations/auto") {
      if (!ctx.auto) {
        ctx.json(response, 404, { error: "auto stations are not available here", code: "not_found" });
        return true;
      }
      if (method === "GET") {
        ctx.json(response, 200, { setting: ctx.auto.setting() });
        return true;
      }
      if (method === "POST") {
        ctx.json(response, 200, { report: await ctx.auto.sync(await body()) });
        return true;
      }
      ctx.json(response, 405, { error: "GET or POST", code: "method_not_allowed" });
      return true;
    }

    if (path === "/api/v1/stations/lyrics") {
      if (!ctx.lyricsPublisher) {
        ctx.json(response, 404, { error: "lyrics publishing is not available here", code: "not_found" });
        return true;
      }
      if (method !== "GET") {
        ctx.json(response, 405, { error: "GET", code: "method_not_allowed" });
        return true;
      }
      ctx.json(response, 200, ctx.lyricsPublisher.status());
      return true;
    }
    const publishLyrics = /^\/api\/v1\/stations\/lyrics\/([a-z0-9]{10})\/publish$/.exec(path);
    if (publishLyrics) {
      const target = ctx.store.get(publishLyrics[1]!);
      if (!ctx.lyricsPublisher || !target) {
        ctx.json(response, 404, { error: "no such station", code: "not_found" });
        return true;
      }
      if (method !== "POST") {
        ctx.json(response, 405, { error: "POST", code: "method_not_allowed" });
        return true;
      }
      const report = await ctx.lyricsPublisher.publish(target);
      const refused = report.stopped.startsWith("not published") ? "not_eligible" : report.stopped.startsWith("no key") ? "no_key" : "";
      ctx.json(response, refused ? 409 : 200, refused ? { error: report.stopped, code: refused, report } : { report });
      return true;
    }

    const match = /^\/api\/v1\/stations\/([a-z0-9]{10})(?:\/([a-z-]+))?$/.exec(path);
    if (!match) {
      ctx.json(response, 404, { error: "no such station", code: "not_found" });
      return true;
    }
    const id = match[1]!;
    const action = match[2];
    const station = ctx.store.get(id);
    if (!station) {
      ctx.json(response, 404, { error: "no such station", code: "not_found" });
      return true;
    }

    if (action === undefined) {
      if (method === "GET") {
        ctx.json(response, 200, { station: ownerView(ctx, station) });
        return true;
      }
      if (method === "PATCH") {
        const input = await body();
        const items = ctx.select(input);
        const updated = ctx.store.update(id, input, items);
        ctx.json(response, 200, { station: ownerView(ctx, updated) });
        return true;
      }
      if (method === "DELETE") {
        ctx.runner.remove(id);
        ctx.json(response, 200, { deleted: id });
        return true;
      }
      ctx.json(response, 405, { error: "GET, PATCH or DELETE", code: "method_not_allowed" });
      return true;
    }

    if (action === "metrics" && method === "GET") {
      if (!ctx.usage || !ctx.limits) {
        ctx.json(response, 404, { error: "metering is off on this server", code: "not_found" });
        return true;
      }
      ctx.json(response, 200, {
        listeners: ctx.usage.listeners(station.id),
        month: ctx.usage.thisMonth(station.id),
        history: ctx.usage.history(station.id),
        limits: ctx.limits,
        alerts: alertsFor(station, ctx.runner.observed(station.id), ctx.runner.downSince(station.id), ctx.usage.thisMonth(station.id), ctx.limits),
      });
      return true;
    }
    if (method !== "POST") {
      ctx.json(response, 405, { error: "POST", code: "method_not_allowed" });
      return true;
    }
    if (action === "start") {
      const running = ctx.store.list().filter((one) => one.desired === "running" && one.id !== id).length;
      if (ctx.limits && ctx.limits.runningStations > 0 && running >= ctx.limits.runningStations) {
        ctx.json(response, 409, { error: `this server runs at most ${ctx.limits.runningStations} stations at once; stop one first`, code: "too_many_running" });
        return true;
      }
      const started = await ctx.runner.start(id);
      ctx.json(response, 200, { station: ownerView(ctx, started) });
      return true;
    }
    if (action === "stop") {
      ctx.json(response, 200, { station: ownerView(ctx, ctx.runner.stop(id)) });
      return true;
    }
    if (action === "skip") {
      ctx.runner.skip(id);
      ctx.json(response, 200, { station: ownerView(ctx, station) });
      return true;
    }
    if (action === "retry") {
      ctx.json(response, 200, { station: ownerView(ctx, ctx.store.clearFailures(id)) });
      return true;
    }
    if (action === "rotate-link") {
      const rotated = ctx.store.rotateToken(id);
      const dropped = ctx.runner.revoke(id);
      ctx.json(response, 200, { station: ownerView(ctx, rotated), dropped });
      return true;
    }
    if (action === "access") {
      const input = await body();
      const rights = input["rights"];
      const { station: changed, revoked } = ctx.store.setAccess(id, {
        visibility: input["visibility"],
        listed: input["listed"],
        rights: typeof rights === "object" && rights !== null ? rights as { basis?: unknown; note?: unknown } : null,
      }, ctx.account || "control-key");
      const dropped = revoked ? ctx.runner.revoke(id) : 0;
      ctx.json(response, 200, { station: ownerView(ctx, changed), dropped });
      return true;
    }
    ctx.json(response, 404, { error: "no such action", code: "not_found" });
    return true;
  } catch (error) {
    fail(ctx, response, error);
    return true;
  }
}

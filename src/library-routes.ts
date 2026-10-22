/**
 * /api/v1/library: the owner's files, as sources, items and groups.
 *
 * Reading -- search, browse, an item, its stream -- is for whoever got past
 * the server's key: the owner, or somebody the owner gave the listen link to,
 * which has always been how a library is shared. Only the owner sees where a
 * file lives (`path`); everybody else gets its place inside the library.
 * Changing anything -- sources, scans, corrections -- is the owner's.
 * A station's link reaches none of this.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import {
  LibraryError, shown, trackOf, type Browse, type ItemState, type LibraryIndex, type LibraryItem, type Probed, type SearchQuery,
} from "./library-index.ts";
import type { Track } from "./audio.ts";
import type { ListenerStore, Playlist, Queue } from "./library-user.ts";

export interface LibraryContext {
  index: LibraryIndex;
  /** Past the server's key: may read. */
  canRead: boolean;
  /** The control key or the owner: may change things. */
  canWrite: boolean;
  account: string;
  /** Who this is, for their playlists and queue; null when nobody in particular. */
  principal: string | null;
  listeners?: ListenerStore;
  probe: (path: string) => Promise<Probed>;
  /** Tell the player about tags that changed. */
  retag: (tracks: Track[]) => void;
  sendFile: (request: IncomingMessage, response: ServerResponse, file: string, cache: string) => void;
  /** The file as a browser plays it (server.ts playFile): the bytes when it can, MP4 or MP3 when not. */
  play?: (request: IncomingMessage, response: ServerResponse, file: string, download?: string) => Promise<void>;
  /** The item's public play address with the listen key, what a guide publishes on demand; "" when this server has none. */
  playAddress?: (id: string) => string;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
}

/** An item as a caller may see it: the path only for the owner. */
export function itemView(item: LibraryItem, owner: boolean): Record<string, unknown> {
  const tags = shown(item);
  return {
    id: item.id,
    sourceId: item.sourceId,
    rel: item.rel,
    ...(owner ? { path: item.path, override: item.override, size: item.size } : {}),
    state: item.state,
    ...(item.error && owner ? { error: item.error } : {}),
    ...tags,
    duration: item.duration,
    format: { codec: item.codec, bitrateKbps: item.bitrate, sampleRate: item.sampleRate, channels: item.channels },
    video: item.video,
    hasArt: item.hasArt,
  };
}

const STATES = new Set(["pending", "ready", "unsupported", "failed", "unavailable", "all"]);
const SORTS = new Set(["path", "title", "artist", "album", "recent"]);
const KINDS = new Set(["artists", "albums", "genres", "folders"]);

export async function handleLibrary(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  ctx: LibraryContext,
): Promise<boolean> {
  if (path !== "/api/v1/library" && !path.startsWith("/api/v1/library/")) return false;
  const method = request.method ?? "GET";
  const { index } = ctx;
  const fail = (status: number, code: string, error: string): true => {
    ctx.json(response, status, { error, code });
    return true;
  };
  if (!ctx.canRead) return fail(401, "unauthorized", "this library needs its link, or sign in as its owner");
  const needWrite = (): boolean => {
    if (ctx.canWrite) return true;
    fail(403, "forbidden", "only this server's owner changes its library");
    return false;
  };
  const body = async (): Promise<Record<string, unknown>> => {
    const raw = await ctx.readBody(request);
    if (raw.trim() === "") return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new LibraryError("bad_json", "the body is not a JSON object");
    return parsed as Record<string, unknown>;
  };
  const number = (name: string): number | undefined => {
    const value = url.searchParams.get(name);
    return value === null ? undefined : Number(value) || 0;
  };
  const text = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;

  try {
    if (path === "/api/v1/library" && method === "GET") {
      ctx.json(response, 200, {
        items: index.size,
        counts: index.counts(),
        sources: index.sources().map((one) => ({ id: one.id, enabled: one.enabled, lastScan: one.lastScan, ...(ctx.canWrite ? { root: one.root, host: one.host } : {}) })),
      });
      return true;
    }

    if (path === "/api/v1/library/sources") {
      if (method === "GET") {
        ctx.json(response, 200, { sources: index.sources().map((one) => (ctx.canWrite ? one : { id: one.id, enabled: one.enabled, lastScan: one.lastScan })) });
        return true;
      }
      if (method === "POST") {
        if (!needWrite()) return true;
        const input = await body();
        if (typeof input["root"] !== "string" || input["root"].trim() === "") throw new LibraryError("root_required", "say which folder: {\"root\": \"/path\"}");
        const { existsSync, statSync } = await import("node:fs");
        const root = input["root"].trim();
        if (!existsSync(root) || !statSync(root).isDirectory()) throw new LibraryError("not_a_folder", "that is not a folder on this machine");
        const source = index.addSource(root, ctx.account, hostname());
        const { report } = index.scan(source.id, ctx.probe, { onProgress: (changed) => ctx.retag(changed.filter((one) => one.state === "ready").map(trackOf)) });
        ctx.json(response, 201, { source, job: report });
        return true;
      }
      return fail(405, "method_not_allowed", "GET or POST");
    }

    const sourceMatch = /^\/api\/v1\/library\/sources\/([0-9a-f]{16})(?:\/(scan))?$/.exec(path);
    if (sourceMatch) {
      const id = sourceMatch[1]!;
      if (sourceMatch[2] === "scan") {
        if (method !== "POST") return fail(405, "method_not_allowed", "POST");
        if (!needWrite()) return true;
        const input = await body();
        const { report } = index.scan(id, ctx.probe, {
          force: input["force"] === true,
          onProgress: (changed) => ctx.retag(changed.filter((one) => one.state === "ready").map(trackOf)),
        });
        ctx.json(response, 202, { job: report });
        return true;
      }
      if (method === "GET") {
        const source = index.source(id);
        if (!source) return fail(404, "not_found", "no such source");
        ctx.json(response, 200, { source: ctx.canWrite ? source : { id: source.id, enabled: source.enabled, lastScan: source.lastScan } });
        return true;
      }
      if (!needWrite()) return true;
      if (method === "PATCH") {
        const input = await body();
        if (typeof input["enabled"] !== "boolean") throw new LibraryError("invalid_value", "enabled must be true or false");
        ctx.json(response, 200, { source: index.setEnabled(id, input["enabled"]) });
        return true;
      }
      if (method === "DELETE") {
        const forgotten = index.removeSource(id);
        ctx.json(response, 200, { deleted: id, forgotten, filesTouched: 0 });
        return true;
      }
      return fail(405, "method_not_allowed", "GET, PATCH or DELETE");
    }

    if (path === "/api/v1/library/queue" || path === "/api/v1/library/playlists" || path.startsWith("/api/v1/library/playlists/")) {
      const listeners = ctx.listeners;
      if (!listeners) return fail(404, "not_found", "nothing here");
      const who = ctx.principal;
      if (who === null) return fail(401, "sign_in_required", "sign in to nixamp.com to keep playlists and pick up where you left off");
      const known = (id: string): boolean => index.item(id) !== undefined;
      const resolved = (ids: string[]): Array<Record<string, unknown>> => ids.map((id) => {
        const item = index.item(id);
        return item ? itemView(item, ctx.canWrite) : { id, state: "unavailable" };
      });
      const playlistView = (one: Playlist, withItems: boolean): Record<string, unknown> => ({
        id: one.id, name: one.name, count: one.items.length, revision: one.revision, createdAt: one.createdAt, updatedAt: one.updatedAt,
        ...(withItems ? { items: resolved(one.items) } : {}),
      });
      const queueView = (queue: Queue): Record<string, unknown> => ({ ...queue, items: resolved(queue.items), current: queue.items[queue.at] ?? null });

      if (path === "/api/v1/library/queue") {
        if (method === "GET") {
          ctx.json(response, 200, { queue: queueView(listeners.queueOf(who)) });
          return true;
        }
        if (method === "PUT" || method === "PATCH") {
          ctx.json(response, 200, { queue: queueView(listeners.setQueue(who, await body(), known)) });
          return true;
        }
        return fail(405, "method_not_allowed", "GET, PUT or PATCH");
      }
      if (path === "/api/v1/library/playlists") {
        if (method === "GET") {
          ctx.json(response, 200, { playlists: listeners.playlistsOf(who).map((one) => playlistView(one, false)) });
          return true;
        }
        if (method === "POST") {
          ctx.json(response, 201, { playlist: playlistView(listeners.create(who, await body(), known), true) });
          return true;
        }
        return fail(405, "method_not_allowed", "GET or POST");
      }
      const playlistMatch = /^\/api\/v1\/library\/playlists\/([0-9a-f]{16})(?:\/(items))?$/.exec(path);
      if (!playlistMatch) return fail(404, "not_found", "no such playlist");
      const id = playlistMatch[1]!;
      if (playlistMatch[2] === "items") {
        if (method !== "POST") return fail(405, "method_not_allowed", "POST");
        ctx.json(response, 200, { playlist: playlistView(listeners.add(who, id, await body(), known), true) });
        return true;
      }
      if (method === "GET") {
        ctx.json(response, 200, { playlist: playlistView(listeners.playlist(who, id), true) });
        return true;
      }
      if (method === "PATCH") {
        ctx.json(response, 200, { playlist: playlistView(listeners.update(who, id, await body(), known), true) });
        return true;
      }
      if (method === "DELETE") {
        listeners.remove(who, id);
        ctx.json(response, 200, { deleted: id });
        return true;
      }
      return fail(405, "method_not_allowed", "GET, PATCH or DELETE");
    }

    const jobMatch = /^\/api\/v1\/library\/jobs\/([0-9a-f]{16})$/.exec(path);
    if (jobMatch) {
      const job = index.job(jobMatch[1]!);
      if (!job) return fail(404, "not_found", "no such job (jobs are kept until the server restarts)");
      ctx.json(response, 200, { job });
      return true;
    }

    if (path === "/api/v1/library/items" && method === "GET") {
      const state = text("state");
      const sort = text("sort");
      const query: SearchQuery = {
        q: text("q"), artist: text("artist"), album: text("album"), genre: text("genre"), folder: text("folder"), sourceId: text("source"),
        ...(state && STATES.has(state) ? { state: state as ItemState | "all" } : {}),
        ...(sort && SORTS.has(sort) ? { sort: sort as SearchQuery["sort"] } : {}),
        limit: number("limit"), offset: number("offset"),
      };
      const { items, total } = index.search(query);
      ctx.json(response, 200, { items: items.map((one) => itemView(one, ctx.canWrite)), total, limit: Math.min(500, Math.max(1, query.limit ?? 50)), offset: Math.max(0, query.offset ?? 0) });
      return true;
    }

    const browseMatch = /^\/api\/v1\/library\/browse\/([a-z]+)$/.exec(path);
    if (browseMatch && method === "GET") {
      const kind = browseMatch[1]!;
      if (!KINDS.has(kind)) return fail(404, "not_found", "browse artists, albums, genres or folders");
      ctx.json(response, 200, index.browse(kind as Browse, { q: text("q"), limit: number("limit"), offset: number("offset") }));
      return true;
    }

    const itemMatch = /^\/api\/v1\/library\/items\/([0-9a-f]{16})(?:\/(stream|play))?$/.exec(path);
    if (itemMatch) {
      const item = index.item(itemMatch[1]!);
      if (!item) return fail(404, "not_found", "no such item");
      if (itemMatch[2] === "stream" || itemMatch[2] === "play") {
        if (method !== "GET" && method !== "HEAD") return fail(405, "method_not_allowed", "GET");
        if (item.state !== "ready") return fail(409, "not_ready", `that item is ${item.state}`);
        const source = index.source(item.sourceId);
        if (!source?.enabled) return fail(409, "source_disabled", "that item's source is turned off");
        // On demand: what a VOD link plays, from the start and seekable when the browser takes the file as it is.
        if (itemMatch[2] === "play" && ctx.play) {
          // `download=1`: the same file as an attachment, named for what it is (a bought VOD download).
          const named = url.searchParams.get("download") === "1"
            ? (url.searchParams.get("name") || item.override.title || item.title || item.path.split("/").pop()!.replace(/\.[^.]+$/, "")).replace(/[\\/:*?"<>|\x00-\x1f]/g, "").slice(0, 160) || item.id
            : "";
          await ctx.play(request, response, item.path, named || undefined);
          return true;
        }
        // Private: a browser may keep it, a shared cache may not.
        ctx.sendFile(request, response, item.path, "private, max-age=3600");
        return true;
      }
      if (method === "GET") {
        // The owner also gets where it plays publicly, for publishing it on another server's guide.
        const play = ctx.canWrite && ctx.playAddress ? ctx.playAddress(item.id) : "";
        ctx.json(response, 200, { item: { ...itemView(item, ctx.canWrite), ...(play ? { playAddress: play } : {}) } });
        return true;
      }
      if (method === "PATCH") {
        if (!needWrite()) return true;
        const corrected = index.correct(item.id, await body());
        if (corrected.state === "ready") ctx.retag([trackOf(corrected)]);
        ctx.json(response, 200, { item: itemView(corrected, true) });
        return true;
      }
      return fail(405, "method_not_allowed", "GET or PATCH");
    }

    return fail(404, "not_found", "nothing here");
  } catch (error) {
    if (error instanceof LibraryError) return fail(error.status, error.code, error.message);
    if (error instanceof SyntaxError) return fail(400, "bad_json", "the body is not JSON");
    return fail(500, "internal", error instanceof Error ? error.message : String(error));
  }
}

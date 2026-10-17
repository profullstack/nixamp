/**
 * AI radio and listener shares over HTTP.
 *
 * Public, no key, because sharing and reporting are what the guide offers
 * anybody: `/api/v1/share` (what may be shared, and a link to share),
 * `/api/v1/share/upload` (the file as the body), `/api/v1/share/:id?t=`
 * (how it went; DELETE takes it back) and `/api/v1/share/report` (take what
 * is playing off the air). Everything else is the owner's, under
 * /api/v1/stations/ai and /api/v1/stations/shares.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { AI_KEY_NAMES, aiKeysSet, saveAiKey, type AiKeyName } from "./ai-keys.ts";
import type { AiRadio } from "./ai-radio.ts";
import { SHARE_BASES, SHARE_GENRES, ownerShareView, sharerView, type ListenerShares } from "./listener-shares.ts";
import { StationError } from "./stations.ts";
import type { HolderStore } from "./track-facts.ts";

const PUBLIC = /^\/api\/v1\/share(?:\/(upload|report|[a-f0-9]{12}))?$/;

/** Whether this path is one anybody may use without the server's key. */
export function isPublicSharePath(path: string): boolean {
  return PUBLIC.test(path);
}

export interface AiRoutesContext {
  ai?: AiRadio;
  shares?: ListenerShares;
  /** The copyright holders the owner registered, for the now-playing card. */
  holders?: HolderStore;
  canControl: boolean;
  /** Who is asking, for per-sharer limits (an address; hashed before it is kept). */
  caller: string;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
  headers: Record<string, string>;
  /** Null to go ahead, or how long to wait: a public limit on top of the per-sharer one. */
  throttle?: () => { retryAfter: number } | null;
}

async function jsonBody(ctx: AiRoutesContext, request: IncomingMessage): Promise<Record<string, unknown>> {
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

/** Answers the paths above; false when the path is not one of them. */
export async function handleAiRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  ctx: AiRoutesContext,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const publicPath = PUBLIC.exec(path);
  const ownerPath = path === "/api/v1/stations/ai" || path.startsWith("/api/v1/stations/ai/") || path === "/api/v1/stations/shares" || path.startsWith("/api/v1/stations/shares/")
    || path === "/api/v1/stations/holders" || path.startsWith("/api/v1/stations/holders/");
  if (!publicPath && !ownerPath) return false;
  try {
    if (publicPath) {
      const shares = ctx.shares;
      if (!shares) {
        ctx.json(response, 404, { error: "this server does not take shared tracks", code: "not_found" });
        return true;
      }
      const what = publicPath[1];
      if (what === undefined && method === "GET") {
        const setting = shares.setting();
        ctx.json(response, 200, { open: setting.open, bases: SHARE_BASES, genres: SHARE_GENRES, maxMb: Math.round(setting.maxBytes / 1048576), perHour: setting.perHour });
        return true;
      }
      if (method !== "GET" && method !== "DELETE" && ctx.throttle) {
        const wait = ctx.throttle();
        if (wait) {
          response.setHeader("retry-after", String(wait.retryAfter));
          ctx.json(response, 429, { error: "too many at once; wait a moment", code: "rate_limited", retryAfter: wait.retryAfter });
          return true;
        }
      }
      if (what === undefined && method === "POST") {
        const share = shares.fromUrl(await jsonBody(ctx, request), ctx.caller);
        ctx.json(response, 202, { share: sharerView(share), token: share.token, status: `/api/v1/share/${share.id}?t=${share.token}` });
        return true;
      }
      if (what === "upload" && (method === "PUT" || method === "POST")) {
        const input = Object.fromEntries(url.searchParams.entries());
        const share = await shares.fromUpload(request, input, ctx.caller);
        ctx.json(response, 202, { share: sharerView(share), token: share.token, status: `/api/v1/share/${share.id}?t=${share.token}` });
        return true;
      }
      if (what === "report" && method === "POST") {
        const input = await jsonBody(ctx, request);
        ctx.json(response, 200, shares.report(input, ctx.caller));
        return true;
      }
      if (what && /^[a-f0-9]{12}$/.test(what) && (method === "GET" || method === "DELETE")) {
        const share = shares.forSharer(what, url.searchParams.get("t") ?? "");
        if (!share) {
          ctx.json(response, 404, { error: "no such share, or not with that link", code: "not_found" });
          return true;
        }
        ctx.json(response, 200, { share: sharerView(method === "DELETE" ? shares.withdraw(share) : share) });
        return true;
      }
      ctx.json(response, 405, { error: "not like that", code: "method_not_allowed" });
      return true;
    }

    if (!ctx.canControl) {
      ctx.json(response, 403, { error: "only this server's owner manages AI radio and shares", code: "forbidden" });
      return true;
    }

    if (path === "/api/v1/stations/holders" || path.startsWith("/api/v1/stations/holders/")) {
      const holders = ctx.holders;
      if (!holders) {
        ctx.json(response, 404, { error: "copyright holders are not kept here", code: "not_found" });
        return true;
      }
      if (path === "/api/v1/stations/holders" && method === "GET") {
        ctx.json(response, 200, { holders: holders.list() });
        return true;
      }
      if (path === "/api/v1/stations/holders" && method === "POST") {
        ctx.json(response, 200, { holder: holders.set(await jsonBody(ctx, request)) });
        return true;
      }
      const one = /^\/api\/v1\/stations\/holders\/([a-z0-9-]{1,40})$/.exec(path);
      if (one && method === "DELETE") {
        if (!holders.remove(one[1]!)) throw new StationError("not_found", "no such holder", 404);
        ctx.json(response, 200, { deleted: one[1] });
        return true;
      }
      ctx.json(response, 404, { error: "no such holder route", code: "not_found" });
      return true;
    }

    if (path === "/api/v1/stations/shares" || path.startsWith("/api/v1/stations/shares/")) {
      const shares = ctx.shares;
      if (!shares) {
        ctx.json(response, 404, { error: "shares are not available here", code: "not_found" });
        return true;
      }
      if (path === "/api/v1/stations/shares") {
        if (method === "GET") {
          const list = shares.list(url.searchParams.get("state") ?? undefined);
          ctx.json(response, 200, { setting: shares.setting(), total: list.length, shares: list.slice(0, 200).map(ownerShareView) });
          return true;
        }
        if (method === "POST") {
          shares.configure(await jsonBody(ctx, request));
          ctx.json(response, 200, { setting: shares.setting() });
          return true;
        }
      }
      const match = /^\/api\/v1\/stations\/shares\/([a-f0-9]{12})(?:\/(approve|reject))?$/.exec(path);
      if (match) {
        const [, id, decision] = match;
        if (!decision && method === "GET") {
          const share = shares.get(id!);
          if (!share) throw new StationError("not_found", "no such share", 404);
          ctx.json(response, 200, { share: ownerShareView(share) });
          return true;
        }
        if (!decision && method === "DELETE") {
          shares.decide(id!, "delete");
          ctx.json(response, 200, { deleted: id });
          return true;
        }
        if (decision && method === "POST") {
          const input = await jsonBody(ctx, request);
          const share = shares.decide(id!, decision as "approve" | "reject", typeof input["reason"] === "string" ? input["reason"].slice(0, 300) : "");
          ctx.json(response, 200, { share: share ? ownerShareView(share) : null });
          return true;
        }
      }
      ctx.json(response, 404, { error: "no such share route", code: "not_found" });
      return true;
    }

    const ai = ctx.ai;
    if (!ai) {
      ctx.json(response, 404, { error: "AI radio is not available here", code: "not_found" });
      return true;
    }
    if (path === "/api/v1/stations/ai") {
      if (method === "GET") {
        ctx.json(response, 200, { ...ai.status(), keys: aiKeysSet() });
        return true;
      }
      if (method === "POST") {
        ctx.json(response, 200, { settings: ai.configure(await jsonBody(ctx, request)) });
        return true;
      }
    }
    if (path === "/api/v1/stations/ai/keys" && method === "POST") {
      const input = await jsonBody(ctx, request);
      const name = String(input["name"] ?? "");
      if (!AI_KEY_NAMES.includes(name as AiKeyName)) throw new StationError("unknown_key", `keys: ${AI_KEY_NAMES.join(", ")}`);
      saveAiKey(name as AiKeyName, typeof input["value"] === "string" ? input["value"] : "");
      ctx.json(response, 200, { keys: aiKeysSet() });
      return true;
    }
    if (path === "/api/v1/stations/ai/stations" && method === "POST") {
      ctx.json(response, 201, { station: ai.create(await jsonBody(ctx, request)) });
      return true;
    }
    const match = /^\/api\/v1\/stations\/ai\/stations\/([a-f0-9]{10})(?:\/(generate))?$/.exec(path);
    if (match) {
      const [, key, action] = match;
      if (!action && method === "GET") {
        const station = ai.get(key!);
        if (!station) throw new StationError("not_found", "no such AI station", 404);
        ctx.json(response, 200, { station });
        return true;
      }
      if (!action && method === "PATCH") {
        ctx.json(response, 200, { station: ai.update(key!, await jsonBody(ctx, request)) });
        return true;
      }
      if (!action && method === "DELETE") {
        ai.remove(key!, url.searchParams.get("files") === "1");
        ctx.json(response, 200, { deleted: key });
        return true;
      }
      if (action === "generate" && method === "POST") {
        // Composing takes a minute or two; answer when it is on the station.
        ctx.json(response, 200, { track: await ai.generate(key!) });
        return true;
      }
    }
    ctx.json(response, 404, { error: "no such AI radio route", code: "not_found" });
    return true;
  } catch (error) {
    if (error instanceof StationError) {
      ctx.json(response, error.status, { error: error.message, code: error.code });
    } else {
      ctx.json(response, 500, { error: error instanceof Error ? error.message : String(error), code: "internal" });
    }
    return true;
  }
}

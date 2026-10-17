/**
 * /api/v1/integrations/bittorrented/handoffs: where BitTorrented hands music
 * over. Only this server's owner -- the control key, the owner's session, or
 * an app the owner gave the `stations` scope -- may hand anything over, list
 * handoffs, retry one or delete its copies.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { publicHandoff, type Importer } from "./handoff.ts";
import { LibraryError } from "./library-index.ts";

export interface HandoffContext {
  importer: Importer;
  canWrite: boolean;
  /** Whose handoffs: the owner's account, or "owner" for the control key. */
  owner: string;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
}

const BASE = "/api/v1/integrations/bittorrented/handoffs";

export async function handleHandoffs(request: IncomingMessage, response: ServerResponse, path: string, ctx: HandoffContext): Promise<boolean> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const method = request.method ?? "GET";
  const fail = (status: number, code: string, error: string): true => {
    ctx.json(response, status, { error, code });
    return true;
  };
  if (!ctx.canWrite) return fail(403, "forbidden", "only this server's owner (or an app they gave the stations scope) hands music over");
  const body = async (): Promise<Record<string, unknown>> => {
    const raw = await ctx.readBody(request);
    if (raw.trim() === "") return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new LibraryError("bad_json", "the body is not a JSON object");
    return parsed as Record<string, unknown>;
  };
  try {
    if (path === BASE) {
      if (method === "GET") {
        ctx.json(response, 200, { handoffs: ctx.importer.list(ctx.owner).map(publicHandoff) });
        return true;
      }
      if (method === "POST") {
        const { handoff, created } = ctx.importer.create(await body(), ctx.owner);
        ctx.json(response, created ? 201 : 200, { handoff: publicHandoff(handoff), created });
        return true;
      }
      return fail(405, "method_not_allowed", "GET or POST");
    }
    const match = /^\/api\/v1\/integrations\/bittorrented\/handoffs\/([0-9a-f]{16})(?:\/(retry))?$/.exec(path);
    const handoff = match ? ctx.importer.get(match[1]!) : undefined;
    if (!match || !handoff || handoff.owner !== ctx.owner) return fail(404, "not_found", "no such handoff");
    if (match[2] === "retry") {
      if (method !== "POST") return fail(405, "method_not_allowed", "POST");
      ctx.json(response, 200, { handoff: publicHandoff(ctx.importer.retry(handoff.id, await body())) });
      return true;
    }
    if (method === "GET") {
      ctx.json(response, 200, { handoff: publicHandoff(handoff) });
      return true;
    }
    if (method === "DELETE") {
      const removed = ctx.importer.remove(handoff.id);
      ctx.json(response, 200, { deleted: handoff.id, copiesRemoved: removed });
      return true;
    }
    return fail(405, "method_not_allowed", "GET or DELETE");
  } catch (error) {
    if (error instanceof LibraryError) return fail(error.status, error.code, error.message);
    if (error instanceof SyntaxError) return fail(400, "bad_json", "the body is not JSON");
    return fail(500, "internal", error instanceof Error ? error.message : String(error));
  }
}

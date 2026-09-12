/**
 * The HTTP face of the compression service.
 *
 * Under a channel: its policy (read, and change with the version you
 * saw), an analysis of it (a job), and its relay -- out to another nixamp
 * that asks in the envelope's media type, or in from one. Under
 * /api/compression: the server-wide switch and the jobs. All of it is
 * translation; the rules live in the service. The server's own helpers
 * for answering (JSON, counting a stream) are handed in, so this file
 * imports nothing from the server and the server one thing from it.
 */
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MEDIA_TYPE, parseModes } from "./envelope.ts";
import { CODECS_HEADER, KIND_HEADER } from "./receiver.ts";
import type { CompressionService } from "./service.ts";

export interface RouteContext {
  service: CompressionService;
  json: (response: ServerResponse, code: number, body: unknown) => void;
  readBody: (request: IncomingMessage) => Promise<string>;
  /** Whether the caller holds the controls, as opposed to a listening link. */
  controls: () => Promise<boolean>;
  /** Count a streaming response in the connections view. */
  watch: (request: IncomingMessage, response: ServerResponse, track: string) => void;
  cors: Record<string, string>;
}

/** Who a diagnostic job belongs to. Every control holder shares them. */
const CONTROL = "control";

/** The header a conditional change names the version in, or the body's own field. */
function expectedVersion(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = request.headers["if-match"];
  const raw = typeof header === "string" ? header.replace(/^W\//, "").replace(/"/g, "") : body["version"];
  const version = Number(raw);
  return raw === undefined || raw === "" || !Number.isInteger(version) ? undefined : version;
}

async function parsed(request: IncomingMessage, ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const text = await ctx.readBody(request);
    const body = text === "" ? {} : (JSON.parse(text) as unknown);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Routes under /api/channels/:id/. True when the request was answered.
 * `action` and `file` are the path segments after the id.
 */
export async function handleChannelCompression(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RouteContext,
  id: string,
  action: string | undefined,
  file: string | undefined,
): Promise<boolean> {
  const { service, json } = ctx;

  if (action === "compression") {
    if (file === undefined && request.method === "GET") {
      json(response, 200, service.status(id));
      return true;
    }
    if (file === undefined && request.method === "PATCH") {
      if (!(await ctx.controls())) {
        json(response, 403, { error: "the controls are needed to change a policy" });
        return true;
      }
      const body = await parsed(request, ctx);
      if (body === null) {
        json(response, 400, { error: "send a JSON object" });
        return true;
      }
      const { version: _version, ...change } = body;
      const result = service.set(id, change, expectedVersion(request, body));
      if (!result.ok) {
        json(response, result.status, { error: result.errors.join("; "), errors: result.errors, status: service.status(id) });
        return true;
      }
      json(response, 200, service.status(id));
      return true;
    }
    if (file === "analyses" && request.method === "POST") {
      if (!(await ctx.controls())) {
        json(response, 403, { error: "the controls are needed to start an analysis" });
        return true;
      }
      const body = await parsed(request, ctx);
      const seconds = Number(body?.["seconds"] ?? 30);
      const started = service.analyzeChannel(id, Number.isFinite(seconds) ? seconds : 30, CONTROL);
      if ("error" in started) {
        json(response, started.status, { error: started.error });
        return true;
      }
      json(response, started.existing ? 200 : 202, { job: started.job, existing: started.existing });
      return true;
    }
    json(response, 405, { error: "GET or PATCH the policy; POST to analyses" });
    return true;
  }

  if (action === "relay" && file === undefined) {
    if (request.method === "GET") {
      const accept = String(request.headers["accept"] ?? "");
      if (!accept.includes(MEDIA_TYPE)) {
        json(response, 406, {
          error: `this is a relay for another nixamp, sent as ${MEDIA_TYPE}; a player wants the ordinary channel URL`,
          playback: `/api/channels/${id}`,
        });
        return true;
      }
      if (request.headers["range"] !== undefined) {
        json(response, 416, { error: "a relay is a live stream and cannot be asked for a range" });
        return true;
      }
      const offered = parseModes(String(request.headers[CODECS_HEADER] ?? ""));
      const listener = {
        write: (chunk: Buffer): boolean => response.write(chunk),
        end: (): void => {
          response.end();
        },
        pending: (): number => response.writableLength,
      };
      const answer = service.relay(id, listener, offered);
      if (!answer.ok) {
        json(response, answer.status, { error: answer.error, code: answer.code, playback: `/api/channels/${id}` });
        return true;
      }
      ctx.watch(request, response, id);
      response.writeHead(200, {
        ...ctx.cors,
        "content-type": `${MEDIA_TYPE}; version=1`,
        "cache-control": "no-store",
        // Never squeezed again by anything in the way: it is already framed.
        "content-encoding": "identity",
        [CODECS_HEADER]: answer.codecs.join(","),
        [KIND_HEADER]: answer.kind,
        "x-nixamp-generation": String(answer.generation),
      });
      const leave = (): void => answer.session.leave();
      request.on("close", leave);
      response.on("close", leave);
      return true;
    }
    if (request.method === "POST") {
      if (!(await ctx.controls())) {
        json(response, 403, { error: "the controls are needed to bring a relay in" });
        return true;
      }
      const body = await parsed(request, ctx);
      const from = typeof body?.["from"] === "string" ? body["from"] : "";
      if (from === "") {
        json(response, 400, { error: "say where from: { from: \"https://host:port/api/channels/<id>/relay\" }" });
        return true;
      }
      const key = typeof body?.["key"] === "string" ? body["key"] : null;
      const name = typeof body?.["name"] === "string" ? body["name"] : id;
      const started = service.pull(id, from, key, name);
      if (!started.ok) {
        json(response, started.status, { error: started.error });
        return true;
      }
      json(response, 202, { ok: true, channel: id, from });
      return true;
    }
    if (request.method === "DELETE") {
      if (!(await ctx.controls())) {
        json(response, 403, { error: "the controls are needed to stop a relay" });
        return true;
      }
      const stopped = service.stopPull(id);
      json(response, stopped ? 200 : 404, { ok: stopped });
      return true;
    }
    json(response, 405, { error: "GET to receive, POST to bring one in, DELETE to stop it" });
    return true;
  }

  return false;
}

/** Routes under /api/compression. True when the request was answered. */
export async function handleCompressionApi(request: IncomingMessage, response: ServerResponse, ctx: RouteContext, path: string): Promise<boolean> {
  const { service, json } = ctx;
  if (path === "/api/compression") {
    if (request.method === "GET") {
      json(response, 200, service.overview());
      return true;
    }
    if (request.method === "PATCH") {
      if (!(await ctx.controls())) {
        json(response, 403, { error: "the controls are needed to change the server's compression" });
        return true;
      }
      const body = await parsed(request, ctx);
      if (body === null) {
        json(response, 400, { error: "send a JSON object" });
        return true;
      }
      const change: { enabled?: boolean; hlsPackaging?: "mpegts" | "fmp4" } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          json(response, 400, { error: "enabled must be true or false" });
          return true;
        }
        change.enabled = body["enabled"];
      }
      if ("hlsPackaging" in body) {
        if (body["hlsPackaging"] !== "mpegts" && body["hlsPackaging"] !== "fmp4") {
          json(response, 400, { error: "hlsPackaging must be mpegts or fmp4" });
          return true;
        }
        change.hlsPackaging = body["hlsPackaging"];
      }
      json(response, 200, { global: service.setGlobal(change) });
      return true;
    }
    json(response, 405, { error: "GET or PATCH" });
    return true;
  }
  const job = /^\/api\/compression\/analyses\/([a-z0-9]+)$/.exec(path);
  if (job) {
    if (!(await ctx.controls())) {
      json(response, 403, { error: "the controls are needed to see an analysis" });
      return true;
    }
    const jobId = job[1] as string;
    if (request.method === "GET") {
      const found = service.jobs.get(jobId, CONTROL);
      if (!found) {
        json(response, 404, { error: "no such analysis" });
        return true;
      }
      json(response, 200, { job: found });
      return true;
    }
    if (request.method === "DELETE") {
      const cancelled = service.jobs.cancel(jobId, CONTROL);
      json(response, cancelled ? 200 : 404, { ok: cancelled });
      return true;
    }
    json(response, 405, { error: "GET or DELETE" });
    return true;
  }
  return false;
}

/**
 * The static representation of a library file, at /api/media/N/relay.
 * The caller has already resolved N to a path and checked that media may
 * be streamed at all.
 */
export function handleStaticRelay(request: IncomingMessage, response: ServerResponse, ctx: RouteContext, file: string, title: string): void {
  const { service, json } = ctx;
  const accept = String(request.headers["accept"] ?? "");
  if (!accept.includes(MEDIA_TYPE)) {
    json(response, 406, { error: `this is the file's relay representation, sent as ${MEDIA_TYPE}; a player wants the ordinary media URL` });
    return;
  }
  if (request.headers["range"] !== undefined) {
    json(response, 416, { error: "the relay representation cannot be asked for a range; the ordinary media URL can" });
    return;
  }
  const state = service.representation(file);
  if (state.state === "off") {
    json(response, 409, { error: "compression is off for static files on this server", code: "COMPRESSION_OFF" });
    return;
  }
  if (state.state === "failed") {
    json(response, 503, { error: state.reason });
    return;
  }
  if (state.state === "building") {
    response.writeHead(202, { ...ctx.cors, "content-type": "application/json; charset=utf-8", "retry-after": "5" });
    response.end(JSON.stringify({ building: true }));
    return;
  }
  ctx.watch(request, response, title);
  response.writeHead(200, {
    ...ctx.cors,
    "content-type": `${MEDIA_TYPE}; version=1`,
    "content-length": String(state.entry.bytes),
    "content-encoding": "identity",
    "cache-control": "no-store",
    "x-nixamp-sha256": state.entry.sha256,
    "x-nixamp-original-length": String(state.entry.size),
  });
  createReadStream(state.path).pipe(response);
}

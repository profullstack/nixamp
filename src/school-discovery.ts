/**
 * backtoschool.help's own front door for agents: llms.txt, an OpenAPI
 * document of the class API, and MCP at /mcp/public (reading) and /mcp
 * (teaching, as the bearer).
 *
 * The school is served by the nixamp process under another Host, so before
 * this its /llms.txt and /mcp answered as nixamp.com: an agent landing on
 * the school was told about radio stations and handed no class tools. The
 * routes here run only for the school's host, ahead of nixamp's.
 *
 * The tools are school-mcp.ts, called over HTTP against the school's own
 * origin with the caller's token, exactly as from a CLI. Sign-in is nixamp's:
 * one account, one token, and nixamp.com is the authorization server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { SCHOOL_PUBLIC_TOOLS, SCHOOL_TOOLS, callSchoolTool, isSchoolPublicTool, isSchoolTool } from "./school-mcp.ts";
import { SCHOOL_SITE } from "./school-client.ts";

export interface SchoolDiscoveryContext {
  /** This school's origin, e.g. https://backtoschool.help. */
  site: string;
  /** nixamp.com: where tokens come from and where OAuth is. */
  accountSite: string;
  version: string;
  whoIs: (token: string) => Promise<unknown>;
  token: string;
  readBody: (request: IncomingMessage, limit: number) => Promise<string>;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  fetcher?: typeof fetch;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
};

const PATHS = new Set(["/llms.txt", "/openapi.json", "/mcp", "/mcp/public", "/.well-known/oauth-protected-resource"]);

/** Is this host the school? backtoschool.help (or NIXAMP_SCHOOL_URL), with or without www. */
export function isSchoolSite(site: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!site) return false;
  const bare = (value: string): string => new URL(value).hostname.replace(/^www\./, "");
  try {
    return bare(site) === bare(env["NIXAMP_SCHOOL_URL"] ?? SCHOOL_SITE);
  } catch {
    return false;
  }
}

export function schoolLlmsTxt(site: string, accountSite: string): string {
  return `# BackToSchool.help

> Live classes anybody can teach and anybody can join: a broadcast (a nixamp station, a screen share, a video link) with chat and raised hands around it. Free to watch. Accounts are nixamp accounts.

## Web
- ${site}/ : classes live now and coming up
- ${site}/live/<slug> : one class

## MCP
- Public, no account (what is on, one class): ${site}/mcp/public
- Signed in (teach, start, end, delete, check your classes): ${site}/mcp , a nixamp token as the bearer (\`nixamp token create\`) or OAuth via ${accountSite}
- Local over stdio: npx -y nixamp mcp (the class tools are among nixamp's)

Tools: classes_list, class_get, class_teach (a broadcast link in, a live class out), class_create, class_update, class_start, class_end, class_delete, classes_check (which of your live classes no longer play).

## CLI
- Install: curl -fsSL ${accountSite}/install.sh | sh   (or npx -y nixamp)
- Sign in: nixamp login
- nixamp school list --status live
- nixamp school teach <station link> --title "..."   make a class and start it
- nixamp school check | prune --end                 find and end classes whose broadcast stopped
- nixamp school help

## API
- OpenAPI: ${site}/openapi.json
- GET ${site}/api/v1/events?status=live : classes (public ones; ?mine=true with a token)
- GET ${site}/api/v1/events/<slug> : one class
- POST ${site}/api/v1/events : make one {title, broadcastUrl, description, topic, visibility, startsAt}
- POST ${site}/api/v1/events/<slug>/start|end {version} : the version you last read
- PATCH ${site}/api/v1/events/<slug> {..., version}, DELETE ${site}/api/v1/events/<slug>
- Auth: Authorization: Bearer <nixamp token>

## What a broadcast can be
A nixamp station link (https://<server>.nixamp.com:4321/station/<id>?t=<token>), a nixamp.com share link, a Pairux room, or a direct https .m3u8/.mp4/.mp3. Only broadcast what you have the right to: your own teaching, or openly licensed courses (MIT OpenCourseWare is CC BY-NC-SA: free, credited, no ads).
`;
}

export function schoolOpenapi(site: string, accountSite: string, version: string): Record<string, unknown> {
  const ok = { description: "OK", content: { "application/json": { schema: { type: "object" } } } };
  const auth = { security: [{ bearer: [] }] };
  const slug = [{ name: "slug", in: "path", required: true, schema: { type: "string" }, description: "The class's slug or id." }];
  const versioned = { content: { "application/json": { schema: { type: "object", properties: { version: { type: "integer" } }, required: ["version"] } } } };
  const fields = {
    title: { type: "string", maxLength: 160 }, description: { type: "string", maxLength: 5000 }, topic: { type: "string", maxLength: 100 },
    broadcastUrl: { type: "string", format: "uri" }, visibility: { type: "string", enum: ["public", "unlisted", "private"] },
    startsAt: { type: "string", format: "date-time" }, chatEnabled: { type: "boolean" }, handRaiseEnabled: { type: "boolean" },
  };
  return {
    openapi: "3.1.0",
    info: { title: "BackToSchool.help", version, description: "Live classes. Reading is open; teaching wants a nixamp token as the bearer.", license: { name: "MIT", identifier: "MIT" } },
    servers: [{ url: site }],
    externalDocs: { description: "llms.txt: MCP, CLI and API in one place", url: `${site}/llms.txt` },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: `A nixamp token (\`nixamp token create\`) or an OAuth access token from ${accountSite}.` } } },
    paths: {
      "/api/v1/events": {
        get: {
          summary: "Classes", tags: ["classes"], responses: { 200: ok },
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["draft", "scheduled", "starting", "live", "encore", "ended", "cancelled", "archived"] } },
            { name: "mine", in: "query", schema: { type: "boolean" }, description: "Only yours (needs the bearer)." },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          ],
        },
        post: { summary: "Make a class (a draft; start it to go live)", tags: ["classes"], ...auth, requestBody: { content: { "application/json": { schema: { type: "object", properties: { kind: { type: "string", enum: ["class", "talk", "concert"] }, ...fields }, required: ["title"] } } } }, responses: { 200: ok } },
      },
      "/api/v1/events/{slug}": {
        parameters: slug,
        get: { summary: "One class", tags: ["classes"], responses: { 200: ok } },
        patch: { summary: "Change a class you host", tags: ["classes"], ...auth, requestBody: { content: { "application/json": { schema: { type: "object", properties: { ...fields, version: { type: "integer" } }, required: ["version"] } } } }, responses: { 200: ok } },
        delete: { summary: "Delete a class you host", tags: ["classes"], ...auth, responses: { 200: ok } },
      },
      "/api/v1/events/{slug}/start": { parameters: slug, post: { summary: "Go live", tags: ["classes"], ...auth, requestBody: versioned, responses: { 200: ok } } },
      "/api/v1/events/{slug}/end": { parameters: slug, post: { summary: "End it", tags: ["classes"], ...auth, requestBody: versioned, responses: { 200: ok } } },
      "/api/v1/events/{slug}/chat": { parameters: slug, get: { summary: "The class chat", tags: ["chat"], responses: { 200: ok } }, post: { summary: "Say something", tags: ["chat"], ...auth, responses: { 200: ok } } },
      "/api/v1/auth/me": { get: { summary: "Who the bearer is", tags: ["auth"], ...auth, responses: { 200: ok } } },
      "/mcp/public": { post: { summary: "MCP (streamable HTTP, JSON-RPC): classes_list, class_get", tags: ["mcp"], responses: { 200: ok } } },
      "/mcp": { post: { summary: "MCP (streamable HTTP, JSON-RPC): every class tool, as the bearer", tags: ["mcp"], ...auth, responses: { 200: ok } } },
    },
  };
}

type Message = { id?: unknown; method?: unknown; params?: Record<string, unknown> };

export async function handleSchoolDiscovery(request: IncomingMessage, response: ServerResponse, path: string, ctx: SchoolDiscoveryContext): Promise<boolean> {
  if (!PATHS.has(path)) return false;
  const method = request.method ?? "GET";
  const site = ctx.site.replace(/\/+$/, "");
  if (method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return true;
  }
  if (path === "/llms.txt" || path === "/openapi.json" || path === "/.well-known/oauth-protected-resource") {
    if (method !== "GET" && method !== "HEAD") { ctx.json(response, 405, { error: "GET only" }); return true; }
    const [type, body] = path === "/llms.txt"
      ? ["text/plain; charset=utf-8", schoolLlmsTxt(site, ctx.accountSite)]
      : ["application/json; charset=utf-8", JSON.stringify(path === "/openapi.json"
        ? schoolOpenapi(site, ctx.accountSite, ctx.version)
        : { resource: site, authorization_servers: [ctx.accountSite], bearer_methods_supported: ["header"], resource_name: "BackToSchool.help" }, null, 2)];
    response.writeHead(200, { ...CORS, "content-type": type, "cache-control": "public, max-age=300" });
    response.end(method === "HEAD" ? undefined : body);
    return true;
  }
  // MCP. GET has nothing to push; DELETE ends a session nobody keeps.
  if (method === "GET") { response.writeHead(405, { ...CORS, allow: "POST, DELETE" }); response.end(); return true; }
  if (method === "DELETE") { response.writeHead(204, CORS); response.end(); return true; }
  if (method !== "POST") { ctx.json(response, 405, { error: "POST a JSON-RPC message" }); return true; }
  const signed = path === "/mcp";
  if (signed && (await ctx.whoIs(ctx.token)) === null) {
    const error = JSON.stringify({ error: "sign in: a nixamp token as the bearer (`nixamp token create`), or OAuth" });
    response.writeHead(401, {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": `Bearer resource_metadata="${site}/.well-known/oauth-protected-resource"`,
    });
    response.end(error);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.readBody(request, 256 * 1024));
  } catch {
    ctx.json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return true;
  }
  const tools = signed ? SCHOOL_TOOLS : SCHOOL_PUBLIC_TOOLS;
  const allowed = signed ? isSchoolTool : isSchoolPublicTool;
  const answers: unknown[] = [];
  for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Message[]) {
    const id = message?.id ?? null;
    const name = typeof message?.method === "string" ? message.method : "";
    if (name.startsWith("notifications/")) continue;
    if (name === "initialize") {
      answers.push({ jsonrpc: "2.0", id, result: {
        protocolVersion: (message.params?.["protocolVersion"] as string | undefined) ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "backtoschool", title: "BackToSchool.help: live classes", version: "1" },
        instructions: signed
          ? "Live classes on BackToSchool.help. classes_list / class_get to see what is on; class_teach puts a broadcast (a nixamp station link, a Pairux room, an https video) on the air as a class in one call; classes_check finds your live classes whose broadcast stopped, and class_end / class_delete clear them. Only broadcast what you have the right to."
          : "Live classes on BackToSchool.help: classes_list and class_get. To teach, use /mcp with a nixamp token as the bearer.",
      } });
    } else if (name === "ping") {
      answers.push({ jsonrpc: "2.0", id, result: {} });
    } else if (name === "tools/list") {
      answers.push({ jsonrpc: "2.0", id, result: { tools } });
    } else if (name === "tools/call" && allowed(String(message.params?.["name"] ?? ""))) {
      const result = await callSchoolTool(String(message.params!["name"]), (message.params?.["arguments"] ?? {}) as Record<string, unknown>, {
        site, token: ctx.token || null, ...(ctx.fetcher ? { fetcher: ctx.fetcher } : {}),
      });
      answers.push({ jsonrpc: "2.0", id, result });
    } else if (name === "tools/call") {
      answers.push({ jsonrpc: "2.0", id, error: { code: -32001, message: "only classes_list and class_get are public; for the rest use /mcp with a nixamp token as the bearer (`nixamp token create`), or OAuth" } });
    } else {
      answers.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${name}` } });
    }
  }
  if (answers.length === 0) { response.writeHead(202, CORS); response.end(); return true; }
  response.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
  return true;
}

/**
 * The routes behind "Connect nixamp" on a site that runs on this codebase
 * but is not nixamp.com.
 *
 *   GET    /api/v1/nixamp/connect     send the browser to nixamp.com's consent page
 *   GET    /api/v1/nixamp/callback    the code comes back; tokens are kept
 *   GET    /api/v1/nixamp/connection  whether this account is connected, and as whom
 *   DELETE /api/v1/nixamp/connection  withdraw the grant, both sides
 *   GET    /api/v1/nixamp/streams     the servers you run on nixamp, and what is live
 *
 * All five want the site's own session: the person, signed in here. What
 * they hold on nixamp's side is a client token, and it never leaves the
 * server -- the page only ever learns a handle and a list of streams.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenFrom, type Accounts } from "./accounts.ts";
import type { NixampLinks } from "./nixamp-link.ts";
import type { ServerStreams, StreamPick } from "./nixamp-link-types.ts";
export type { ServerStreams, StreamPick } from "./nixamp-link-types.ts";

export interface NixampLinkApiOptions {
  links: NixampLinks;
  accounts: Accounts;
  /** nixamp.com, or whatever is the issuer. */
  issuer: string;
  /** This site, as the redirect URI is built from it: https://backtoschool.help. */
  site: string;
  /** The redirect URIs the client registered on the issuer; the callback must be one. */
  redirectUris: string[];
  /** Where the browser lands after the callback. */
  home?: string;
  secureCookies?: boolean;
  fetcher?: typeof fetch;
}

const COOKIE = "nixamp_connect";
const CALLBACK = "/api/v1/nixamp/callback";

export function nixampLinkPath(path: string): boolean {
  return path === "/api/v1/nixamp/connect" || path === CALLBACK || path === "/api/v1/nixamp/connection" || path === "/api/v1/nixamp/streams";
}

function json(response: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const value = JSON.stringify(body);
  response.writeHead(code, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
  });
  response.end(value);
}

function cookieValue(headers: IncomingMessage["headers"], name: string): string {
  const raw = headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function legCookie(value: string, secure: boolean): string {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, `Path=${CALLBACK}`, "Max-Age=600", "SameSite=Lax", "HttpOnly"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearedLegCookie(): string {
  return `${COOKIE}=; Path=${CALLBACK}; Max-Age=0; SameSite=Lax; HttpOnly`;
}

function landing(home: string, outcome: string, reason = ""): string {
  const url = new URL(home, "http://placeholder.invalid");
  url.searchParams.set("nixamp", outcome);
  if (reason) url.searchParams.set("reason", reason.slice(0, 200));
  return `${url.pathname}${url.search}${url.hash || "#settings"}`;
}

/**
 * Every server the nixamp account remembers, asked what it is doing.
 *
 * The account's own list comes from nixamp.com with the client token; each
 * server is then asked directly, with the share key the account kept for it,
 * and given four seconds. One that does not answer is listed as out of
 * reach rather than dropped, so a host sees why a stream is missing.
 */
export async function streamsFor(token: string, issuer: string, pageSite: string, fetcher: typeof fetch): Promise<ServerStreams[]> {
  const base = issuer.replace(/\/+$/, "");
  let servers: { id: string; name: string; url: string; key: string }[] = [];
  const answer = await fetcher(`${base}/api/v1/servers`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!answer.ok) throw new Error(answer.status === 401 ? "nixamp.com no longer accepts this connection" : `nixamp.com answered ${answer.status}`);
  const body = (await answer.json().catch(() => ({}))) as { servers?: typeof servers };
  servers = Array.isArray(body.servers) ? body.servers : [];
  const page = pageSite.replace(/\/+$/, "");
  const linkTo = (address: string, play: string): string => `${page}/?url=${encodeURIComponent(address)}&play=${encodeURIComponent(play)}`;
  return Promise.all(servers.map(async (server): Promise<ServerStreams> => {
    const out: ServerStreams = { id: server.id, name: server.name || server.url, url: server.url, reachable: false, playing: false, nowPlaying: "", live: "", channels: [] };
    try {
      const url = new URL("/api/streams", server.url.endsWith("/") ? server.url : `${server.url}/`);
      if (server.key) url.searchParams.set("k", server.key);
      const response = await fetcher(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) return out;
      const data = (await response.json()) as {
        server?: { name?: string; nowPlaying?: string; playing?: boolean; url?: string };
        channels?: { id: string; name: string; kind?: string; listeners?: number }[];
      };
      // What a viewer link is built on: the server's own view-only address
      // when it publishes one, else its plain address. Never the key the
      // account kept, which may open the controls.
      const viewer = data.server?.url && /^https?:\/\//.test(data.server.url) ? data.server.url : server.url;
      out.reachable = true;
      out.name = data.server?.name || out.name;
      out.playing = data.server?.playing === true;
      out.nowPlaying = data.server?.nowPlaying ?? "";
      out.live = out.playing ? linkTo(viewer, "live") : "";
      out.channels = (data.channels ?? []).map((one): StreamPick => ({
        server: out.name,
        serverUrl: server.url,
        id: one.id,
        name: one.name,
        kind: one.kind ?? "audio",
        listeners: typeof one.listeners === "number" ? one.listeners : 0,
        link: linkTo(viewer, `channel:${one.id}`),
      }));
    } catch {
      // Out of reach: said so, above.
    }
    return out;
  }));
}

export async function handleNixampLinkApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: NixampLinkApiOptions,
): Promise<boolean> {
  const path = url.pathname;
  if (!nixampLinkPath(path)) return false;
  const home = options.home ?? "/";
  const redirectUri = `${options.site.replace(/\/+$/, "")}${CALLBACK}`;
  const registered = options.redirectUris.includes(redirectUri);

  const account = await options.accounts.whoIs(tokenFrom(request.headers));
  if (account === null) {
    if (path === CALLBACK) {
      response.writeHead(302, { location: landing(home, "failed", "sign in here first, then connect again"), "set-cookie": clearedLegCookie() });
      response.end();
      return true;
    }
    json(response, 401, { error: "sign in first" });
    return true;
  }

  if (path === "/api/v1/nixamp/connect") {
    if (request.method !== "GET") { json(response, 405, { error: "GET only" }); return true; }
    if (!registered) { json(response, 400, { error: "this site is not registered as a nixamp client" }); return true; }
    const leg = options.links.begin(redirectUri);
    response.writeHead(302, { location: leg.url, "set-cookie": legCookie(`${leg.state}.${leg.verifier}`, options.secureCookies ?? false), "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (path === CALLBACK) {
    if (request.method !== "GET") { json(response, 405, { error: "GET only" }); return true; }
    const kept = cookieValue(request.headers, COOKIE);
    const dot = kept.indexOf(".");
    const state = dot > 0 ? kept.slice(0, dot) : "";
    const verifier = dot > 0 ? kept.slice(dot + 1) : "";
    const headers = { "set-cookie": clearedLegCookie(), "cache-control": "no-store" };
    const refused = url.searchParams.get("error");
    if (refused) {
      response.writeHead(302, { ...headers, location: landing(home, refused === "access_denied" ? "denied" : "failed", url.searchParams.get("error_description") ?? refused) });
      response.end();
      return true;
    }
    const code = url.searchParams.get("code") ?? "";
    if (state === "" || url.searchParams.get("state") !== state || code === "") {
      response.writeHead(302, { ...headers, location: landing(home, "failed", "that link is not the one this browser started; try again") });
      response.end();
      return true;
    }
    try {
      await options.links.finish(account.id, { code, verifier, redirectUri });
      response.writeHead(302, { ...headers, location: landing(home, "connected") });
    } catch (error) {
      response.writeHead(302, { ...headers, location: landing(home, "failed", (error as Error).message) });
    }
    response.end();
    return true;
  }

  if (path === "/api/v1/nixamp/connection") {
    if (request.method === "GET") {
      json(response, 200, { ...(await options.links.of(account.id)), available: registered });
      return true;
    }
    if (request.method === "DELETE") {
      json(response, 200, { ok: true, withdrawn: await options.links.disconnect(account.id) });
      return true;
    }
    json(response, 405, { error: "GET or DELETE" });
    return true;
  }

  // /api/v1/nixamp/streams
  if (request.method !== "GET") { json(response, 405, { error: "GET only" }); return true; }
  const token = await options.links.accessToken(account.id);
  if (token === "") { json(response, 409, { error: "connect your nixamp account first", connected: false }); return true; }
  try {
    json(response, 200, { servers: await streamsFor(token, options.issuer, options.issuer, options.fetcher ?? fetch) });
  } catch (error) {
    json(response, 502, { error: (error as Error).message });
  }
  return true;
}

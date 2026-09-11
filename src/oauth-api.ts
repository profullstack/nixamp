/**
 * The OAuth 2.1 endpoints, and the watch-party API they guard.
 *
 * Five URLs make nixamp an authorization server:
 *
 *   /.well-known/oauth-authorization-server  what and where everything is
 *   /api/v1/oauth/authorize                  the consent page, and the code
 *   /api/v1/oauth/token                      code or refresh -> tokens
 *   /api/v1/oauth/revoke                     hand a token back
 *   /api/v1/oauth/userinfo                   who the token belongs to
 *
 * and four more make a watch party somewhere else into a room here:
 *
 *   POST /api/v1/watch-parties               bridge one, idempotently
 *   GET  /api/v1/watch-parties               the ones you could join
 *   GET  /api/v1/watch-parties/<code>        one, with where playback is
 *   POST /api/v1/watch-parties/<code>/playback  the host moving everybody
 *   POST /api/v1/watch-parties/<code>/end       the host ending it
 *
 * The watch-party routes take either a session (a person on nixamp.com) or an
 * OAuth access token with the `parties` scope (bittorrented.com acting for
 * them). That is the whole point of the pairing: the same five endpoints
 * answer the web app, the CLI, the desktop app, the MCP server and the site
 * on the other side of the link, and none of them is a special case.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenFrom, type Account, type Accounts } from "./accounts.ts";
import type { Handles } from "./handles.ts";
import { LiveEventError } from "./live-events.ts";
import {
  AuthorizationServer,
  OAuthError,
  SCOPES,
  SCOPE_NAMES,
  type AuthorizeRequest,
  type Scope,
} from "./oauth-server.ts";
import { WatchPartyError, type PartyView, type WatchParties } from "./watch-party.ts";

export interface OAuthApiOptions {
  server: AuthorizationServer;
  accounts: Accounts;
  parties?: WatchParties;
  handles?: Handles;
  /** True where the cookie may be marked Secure. */
  secureCookies?: boolean;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function json(response: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const value = JSON.stringify(body);
  response.writeHead(code, {
    ...CORS,
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    // RFC 6749 §5.1: a token response is never cached, anywhere.
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(value);
}

function html(response: ServerResponse, code: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(code, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new OAuthError("invalid_request", "body too large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE_STYLE = `
  :root { color-scheme: dark }
  body { background:#000; color:#00e676; font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         margin:0; min-height:100vh; display:grid; place-items:center; padding:2rem }
  main { width:min(32rem,100%) }
  h1 { font-size:1.1rem; letter-spacing:.2em; text-transform:uppercase; color:#9ad }
  ul { list-style:none; padding:0; border:1px solid #2a2a2a }
  li { padding:.55rem .8rem; border-bottom:1px solid #1a1a1a; color:#cfcfcf }
  li:last-child { border-bottom:0 }
  li b { color:#00e676; font-weight:400 }
  button { font:inherit; background:#111; color:#00e676; border:1px solid #2a2a2a; padding:.6rem 1rem;
           cursor:pointer; margin-top:.5rem }
  button.primary { border-color:#00e676 }
  form { display:flex; gap:.5rem; flex-wrap:wrap }
  p { color:#9a9a9a } code, a { color:#00e676 }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} - nixamp</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

/**
 * The page that asks.
 *
 * Every parameter of the request is carried through as a hidden field rather
 * than kept in a server-side map, so approving works in a second tab, after a
 * sign-in redirect, and on a deployment with more than one process. Nothing
 * in it is trusted on the way back: the whole request is checked again
 * against the registered client before a code is issued.
 */
export function consentPage(request: AuthorizeRequest, account: Account, handle: string, raw: URLSearchParams): string {
  const hidden = [...raw.entries()]
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join("");
  const who = handle ? `@${handle}` : account.email;
  const site = request.client.homepage
    ? `<a href="${escape(request.client.homepage)}">${escape(request.client.name)}</a>`
    : escape(request.client.name);
  return page(
    `Connect ${request.client.name}`,
    `<h1>Connect ${escape(request.client.name)}</h1>
     <p>${site} wants to act on your nixamp account as <b>${escape(who)}</b>.</p>
     <ul>${request.scope.map((word) => `<li><b>${escape(word)}</b> &mdash; ${escape(SCOPES[word])}</li>`).join("")}</ul>
     <form method="POST" action="/api/v1/oauth/authorize">${hidden}
       <button type="submit" name="decision" value="allow" class="primary">Allow</button>
       <button type="submit" name="decision" value="deny">Not now</button>
     </form>
     <p>You can disconnect it later from the Account panel on nixamp.com.</p>`,
  );
}

function signInFirst(url: URL): string {
  const back = `${url.pathname}${url.search}`;
  return page(
    "Sign in to nixamp",
    `<h1>Sign in first</h1>
     <p>Something wants to connect to your nixamp account, and nixamp does not
        know who you are on this device yet.</p>
     <p><a href="/?next=${encodeURIComponent(back)}">Sign in at nixamp.com</a>, then open this link again.</p>`,
  );
}

/** A refusal that cannot be redirected is a page; there is nowhere safe to send it. */
function refusalPage(error: string, description: string): string {
  return page("Cannot connect", `<h1>Cannot connect</h1><p>${escape(description)}</p><p><code>${escape(error)}</code></p>`);
}

// --- watch parties -------------------------------------------------------------

/** Who is asking, and whether the client they came through may ask this. */
interface Caller {
  account: Account;
  /** "" when this is the person themselves rather than a client acting for them. */
  clientId: string;
  scope: Scope[];
}

async function callerFor(
  request: IncomingMessage,
  options: OAuthApiOptions,
  needs: Scope,
): Promise<Caller | null> {
  const token = tokenFrom(request.headers);
  if (!token) return null;
  const grant = await options.server.grantFor(token);
  if (grant) {
    return grant.scope.includes(needs) ? { account: grant.account, clientId: grant.clientId, scope: grant.scope } : null;
  }
  // Not an OAuth token: a session or a CLI token, which is the person, and a
  // person needs no scope to act as themselves.
  const account = await options.accounts.whoIs(token);
  return account ? { account, clientId: "", scope: SCOPE_NAMES } : null;
}

function partyBody(parties: WatchParties, view: PartyView, caller: Caller): Record<string, unknown> {
  return {
    party: { ...view.party, positionNow: parties.positionNow(view.party) },
    event: view.event,
    links: parties.links(view.party),
    host: view.event.ownerId === caller.account.id,
  };
}

// --- the handler ---------------------------------------------------------------

export function oauthApiPath(path: string): boolean {
  return (
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/openid-configuration" ||
    path.startsWith("/api/v1/oauth/") ||
    path === "/api/v1/watch-parties" ||
    path.startsWith("/api/v1/watch-parties/")
  );
}

export async function handleOAuthApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: OAuthApiOptions,
): Promise<boolean> {
  const path = url.pathname;
  if (!oauthApiPath(path)) return false;
  const server = options.server;

  try {
    // --- what this server is, and where ----------------------------------
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      json(response, 200, server.metadata(), { "cache-control": "public, max-age=3600" });
      return true;
    }

    // --- the consent page, and the code it issues -------------------------
    if (path === "/api/v1/oauth/authorize") {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && method !== "POST") {
        json(response, 405, { error: "invalid_request", error_description: "GET or POST" });
        return true;
      }
      const params =
        method === "POST" ? new URLSearchParams(await readBody(request)) : new URLSearchParams(url.search);
      const checked = server.check(params);
      if ("error" in checked) {
        // Redirect the refusal only where the redirect URI itself checked out.
        if (checked.redirectUri) {
          response.writeHead(302, {
            location: AuthorizationServer.redirect(checked.redirectUri, {
              error: checked.error,
              error_description: checked.description,
              state: checked.state ?? "",
            }),
          });
          response.end();
          return true;
        }
        html(response, 400, refusalPage(checked.error, checked.description));
        return true;
      }

      const account = await options.accounts.whoIs(tokenFrom(request.headers));
      if (account === null) {
        html(response, 401, signInFirst(url));
        return true;
      }

      if (method === "GET" || method === "HEAD") {
        const handle = (await options.handles?.of(account.id).catch(() => "")) ?? "";
        html(response, 200, consentPage(checked, account, handle, params));
        return true;
      }

      if (params.get("decision") !== "allow") {
        response.writeHead(302, {
          location: AuthorizationServer.redirect(checked.redirectUri, {
            error: "access_denied",
            error_description: "the person said not now",
            state: checked.state,
          }),
        });
        response.end();
        return true;
      }

      const code = await server.issueCode(checked, account);
      response.writeHead(302, {
        location: AuthorizationServer.redirect(checked.redirectUri, { code, state: checked.state }),
      });
      response.end();
      return true;
    }

    // --- the token endpoint ----------------------------------------------
    if (path === "/api/v1/oauth/token") {
      if (request.method !== "POST") {
        json(response, 405, { error: "invalid_request", error_description: "POST only" });
        return true;
      }
      const form = new URLSearchParams(await readBody(request));
      const authorization = Array.isArray(request.headers["authorization"])
        ? request.headers["authorization"][0]
        : request.headers["authorization"];
      const client = server.authenticateClient(form, authorization);
      const grantType = form.get("grant_type") ?? "";
      if (grantType === "authorization_code") {
        json(response, 200, await server.exchangeCode(client, form));
        return true;
      }
      if (grantType === "refresh_token") {
        json(response, 200, await server.refresh(client, form));
        return true;
      }
      // Named rather than shrugged at: "password" and "implicit" are the two
      // somebody will try, and both are gone from OAuth 2.1 on purpose.
      throw new OAuthError(
        "unsupported_grant_type",
        `grant_type must be authorization_code or refresh_token; ${grantType || "none"} is not supported`,
      );
    }

    // --- handing a token back ---------------------------------------------
    if (path === "/api/v1/oauth/revoke") {
      if (request.method !== "POST") {
        json(response, 405, { error: "invalid_request", error_description: "POST only" });
        return true;
      }
      const form = new URLSearchParams(await readBody(request));
      const authorization = Array.isArray(request.headers["authorization"])
        ? request.headers["authorization"][0]
        : request.headers["authorization"];
      const client = server.authenticateClient(form, authorization);
      await server.revoke(client, form.get("token") ?? "");
      // RFC 7009: a token that was never valid is the same answer as one that
      // just stopped being. Saying which would be a way to test tokens.
      json(response, 200, { ok: true });
      return true;
    }

    // --- who a token belongs to -------------------------------------------
    if (path === "/api/v1/oauth/userinfo") {
      const info = await server.userinfo(tokenFrom(request.headers), async (id) =>
        (await options.handles?.of(id)) ?? "",
      );
      if (info === null) {
        response.writeHead(401, {
          ...CORS,
          "www-authenticate": 'Bearer error="invalid_token"',
          "content-type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ error: "invalid_token" }));
        return true;
      }
      json(response, 200, info);
      return true;
    }

    // --- the connections an account has granted ----------------------------
    if (path === "/api/v1/oauth/connections" || path.startsWith("/api/v1/oauth/connections/")) {
      // Deliberately the person only: a client must not be able to see or
      // withdraw what another client holds on the same account.
      const account = await options.accounts.whoIs(tokenFrom(request.headers));
      if (account === null) {
        json(response, 401, { error: "sign in first" });
        return true;
      }
      if (path === "/api/v1/oauth/connections" && request.method === "GET") {
        json(response, 200, { connections: await server.grants(account.id) });
        return true;
      }
      if (path.startsWith("/api/v1/oauth/connections/") && request.method === "DELETE") {
        const clientId = decodeURIComponent(path.slice("/api/v1/oauth/connections/".length));
        const gone = await server.disconnect(account.id, clientId);
        json(response, 200, { ok: true, withdrawn: gone });
        return true;
      }
      json(response, 405, { error: "GET or DELETE" });
      return true;
    }

    // --- watch parties ------------------------------------------------------
    if (path === "/api/v1/watch-parties" || path.startsWith("/api/v1/watch-parties/")) {
      const parties = options.parties;
      if (!parties) {
        json(response, 404, { error: "this nixamp does not keep watch parties" });
        return true;
      }
      const caller = await callerFor(request, options, "parties");
      if (caller === null) {
        json(response, 401, { error: "a session, or a token granted the parties scope, is needed here" });
        return true;
      }
      // A client bridges parties under its own origin, so two sites cannot
      // collide on a six-character code; a person acting directly is filed
      // under nixamp itself.
      const origin = caller.clientId || "nixamp";

      if (path === "/api/v1/watch-parties") {
        if (request.method === "GET") {
          const wanted = url.searchParams.get("origin");
          const found = await parties.list({
            ...(wanted ? { origin: wanted } : {}),
            limit: Number(url.searchParams.get("limit") ?? 30),
          });
          json(response, 200, { parties: found.map((view) => partyBody(parties, view, caller)) });
          return true;
        }
        if (request.method === "POST") {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
          } catch {
            json(response, 400, { error: "bad JSON" });
            return true;
          }
          const view = await parties.bridge(caller.account.id, origin, {
            partyCode: input["partyCode"] ?? input["code"],
            title: input["title"],
            partyUrl: input["partyUrl"],
            mediaTitle: input["mediaTitle"],
            visibility: input["visibility"],
            chatEnabled: input["chatEnabled"],
            handRaiseEnabled: input["handRaiseEnabled"],
          });
          json(response, 201, partyBody(parties, view, caller));
          return true;
        }
        json(response, 405, { error: "GET or POST" });
        return true;
      }

      const rest = path.slice("/api/v1/watch-parties/".length).split("/");
      const reference = decodeURIComponent(rest[0] ?? "");
      const action = rest[1];
      // A party is findable by its code on the origin that bridged it, or by
      // the nixamp slug or room a client was handed, because a nixamp client
      // arriving from a share link has only the latter.
      const view = (await parties.byCode(origin, reference).catch(() => null)) ?? (await parties.byEvent(reference));
      if (!view) {
        json(response, 404, { error: "watch party not found" });
        return true;
      }

      if (!action && request.method === "GET") {
        json(response, 200, partyBody(parties, view, caller));
        return true;
      }
      if (action === "playback" && request.method === "POST") {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
        } catch {
          json(response, 400, { error: "bad JSON" });
          return true;
        }
        const party = await parties.setPlayback(view.event.id, caller.account.id, {
          positionSeconds: input["positionSeconds"],
          playing: input["playing"],
          mediaTitle: input["mediaTitle"],
        });
        json(response, 200, partyBody(parties, { party, event: view.event }, caller));
        return true;
      }
      if (action === "end" && request.method === "POST") {
        const event = await parties.end(view.event.id, caller.account.id);
        json(response, 200, { ok: true, event });
        return true;
      }
      json(response, 405, { error: "method not allowed" });
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof OAuthError) {
      json(response, error.status, { error: error.error, error_description: error.description });
      return true;
    }
    if (error instanceof WatchPartyError || error instanceof LiveEventError) {
      json(response, error.status, { error: error.message });
      return true;
    }
    json(response, 500, { error: "server_error" });
    return true;
  }
}

/**
 * /follow on nixamp.com: follow an artist from a /radio page (radio-pages.ts).
 *
 * The /radio pages are on another site (live.streaming.pit.world), where a
 * nixamp.com session cookie is a third-party cookie and no browser sends it.
 * So Follow there is a link here, where the session is first-party: this page
 * says who you are following, and a same-site form (SameSite=Lax keeps a
 * cross-site POST from carrying the session) follows or unfollows. The follow
 * is the same follows row as following a streamer, keyed "artist:<name>".
 *
 *   GET  /follow?id=artist:<name>&name=<shown>&back=<https page>
 *   POST /follow   id, name, back, act=follow|unfollow  -> 303 back to the GET
 *   GET  /follow/button?id=&name=&back=   the Follow button a /radio page frames
 *
 * The button shows "Following" to a follower. Framed on live.streaming it is
 * a third-party page, which the session cookie (SameSite=Lax) never reaches;
 * so signing in here also leaves a second, narrow cookie on /follow alone
 * (SameSite=None): a signed account id that can read whether you follow an
 * artist and do nothing else. Following and unfollowing stay on /follow, a
 * top-level page, where the session is first-party. A browser that blocks
 * third-party cookies shows "Follow", which opens /follow, which knows.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface FollowPageContext {
  /** The signed-in account, or null. */
  account: () => Promise<{ id: string } | null>;
  follows: {
    follow: (follower: string, streamer: string) => Promise<boolean>;
    unfollow: (follower: string, streamer: string) => Promise<void>;
    isFollowing: (follower: string, streamer: string) => Promise<boolean>;
    followerCount: (streamer: string) => Promise<number>;
  };
  readBody: (request: IncomingMessage) => Promise<string>;
  /** Signs the follow-state cookie; without it the button never says "Following". */
  viewSecret?: string;
  /** The origins that may frame the button (frame-ancestors). */
  frameAncestors?: string[];
  now?: () => number;
}

const ID = /^artist:[a-z0-9-]{1,90}$/;

/** The follow-state cookie: on /follow only, readable cross-site, for 90 days. */
export const VIEW_COOKIE = "nixamp_follow_view";
const VIEW_MS = 90 * 24 * 3600_000;

const viewSign = (secret: string, body: string): string => createHmac("sha256", `follow-view:${secret}`).update(body).digest("base64url");

export function makeView(secret: string, account: string, exp: number): string {
  const body = `fv1.${Buffer.from(account).toString("base64url")}.${exp}`;
  return `${body}.${viewSign(secret, body)}`;
}

/** The account a follow-state cookie names, or "" when it is not ours or has expired. */
export function readView(secret: string, value: string, now = Date.now()): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "fv1") return "";
  const body = parts.slice(0, 3).join(".");
  const expected = Buffer.from(viewSign(secret, body));
  const given = Buffer.from(parts[3]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "";
  if (!(Number(parts[2]) > now)) return "";
  return Buffer.from(parts[1]!, "base64url").toString("utf8");
}

function cookieValue(request: IncomingMessage, name: string): string {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

function viewCookie(ctx: FollowPageContext, account: string): string | null {
  if (!ctx.viewSecret) return null;
  const now = ctx.now?.() ?? Date.now();
  return `${VIEW_COOKIE}=${encodeURIComponent(makeView(ctx.viewSecret, account, now + VIEW_MS))}; Path=/follow; Max-Age=${VIEW_MS / 1000}; SameSite=None; Secure; HttpOnly`;
}

const BUTTON_STYLE = `
:root{color-scheme:light dark;--accent:#1f6feb;--fg:#17171a}
@media (prefers-color-scheme:dark){:root{--accent:#6aa7ff;--fg:#ececf1}}
html,body{margin:0;background:transparent;font:700 16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
a{display:inline-block;max-width:100%;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none;border:1px solid var(--accent);border-radius:999px;padding:6px 14px;background:var(--accent);color:#fff}
a.on{background:transparent;color:var(--fg)}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`;

export function buttonCsp(ancestors: string[]): string {
  return ["default-src 'none'", `style-src ${hash(BUTTON_STYLE)}`, "base-uri 'none'", "form-action 'none'", `frame-ancestors ${ancestors.length ? ancestors.join(" ") : "'none'"}`].join("; ");
}

/** The frame a /radio page shows Follow in. */
export function followButtonFrame(site: string, id: string, name: string, back: string, label = `Follow ${name}`): string {
  const src = `${site}/follow/button?${new URLSearchParams({ id, name, back, label }).toString()}`;
  return `<iframe class="follow" src="${escape(src)}" title="${escape(label)}" loading="lazy" sandbox="allow-top-navigation-by-user-activation allow-same-origin"></iframe>`;
}

function escape(text: string): string {
  return String(text).replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);
}

const STYLE = `
:root{--bg:#080c09;--fg:#e8efe9;--muted:#9aa79d;--card:#0e1410;--line:#1f2a22;--accent:#3ddc84}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{margin:0 0 4px;font-size:1.5rem;overflow-wrap:anywhere}.by{color:var(--muted);margin:0 0 16px}
button,a.go{display:block;text-align:center;text-decoration:none;margin-top:18px;width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:#06120a;font:inherit;font-weight:800;cursor:pointer}
button.quiet{background:transparent;color:var(--fg);border:1px solid var(--line)}
a{color:var(--accent)}a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
small{display:block;margin-top:18px;color:var(--muted)}
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const FOLLOW_CSP = ["default-src 'none'", `style-src ${hash(STYLE)}`, "img-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · nixamp</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.png" type="image/png"><style>${STYLE}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

function send(response: ServerResponse, status: number, html: string, method: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-security-policy": FOLLOW_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  response.end(method === "HEAD" ? undefined : html);
}

/** What the link says, cleaned: an artist id, a name to show, and an https page to go back to. */
export function followTarget(input: URLSearchParams): { id: string; name: string; back: string } | null {
  const id = (input.get("id") ?? "").trim();
  if (!ID.test(id)) return null;
  const name = (input.get("name") ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || id.slice("artist:".length);
  let back = "";
  try {
    const url = new URL(input.get("back") ?? "");
    if (url.protocol === "https:" && !url.username && !url.password) back = url.href;
  } catch {
    back = "";
  }
  return { id, name, back };
}

/** Answers /follow and /follow/button; false for any other path. */
export async function handleFollowPage(request: IncomingMessage, response: ServerResponse, path: string, url: URL, ctx: FollowPageContext): Promise<boolean> {
  if (path === "/follow/button") return followButton(request, response, url, ctx);
  if (path !== "/follow") return false;
  const method = request.method ?? "GET";
  if (method === "POST") {
    // Same site only: a form on another site gets no session (SameSite=Lax), and is told so here too.
    const origin = String(request.headers.origin ?? "");
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0]!.trim();
    if (origin && origin !== "null" && new URL(origin).host !== host) {
      send(response, 403, page("Not from here", `<h1>Not from here</h1><p class="by">Follow from nixamp.com's own page.</p>`), method);
      return true;
    }
    const form = new URLSearchParams(await ctx.readBody(request));
    const target = followTarget(form);
    const me = await ctx.account().catch(() => null);
    if (target && me) {
      if (form.get("act") === "unfollow") await ctx.follows.unfollow(me.id, target.id);
      else await ctx.follows.follow(me.id, target.id);
    }
    const again = target ? `/follow?${new URLSearchParams({ id: target.id, name: target.name, ...(target.back ? { back: target.back } : {}) }).toString()}` : "/follow";
    const cookie = me ? viewCookie(ctx, me.id) : null;
    response.writeHead(303, { location: again, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
    response.end();
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, POST" }).end();
    return true;
  }
  const target = followTarget(url.searchParams);
  if (!target) {
    send(response, 404, page("Nobody to follow", `<h1>Nobody to follow</h1><p class="by">That link does not name an artist.</p>`), method);
    return true;
  }
  const back = target.back ? `<small><a href="${escape(target.back)}">← Back to ${escape(target.name)}</a></small>` : "";
  const me = await ctx.account().catch(() => null);
  if (!me) {
    send(response, 200, page(`Follow ${target.name}`, `<h1>Follow ${escape(target.name)}</h1>
<p class="by">Sign in to nixamp.com to follow the artists you hear on the radio.</p>
<a class="go" href="/radio#music">Sign in to nixamp.com</a>
<small>Signed in, open this page again (or press Follow on the artist's page) to follow.</small>${back}`), method);
    return true;
  }
  const [following, count] = await Promise.all([ctx.follows.isFollowing(me.id, target.id), ctx.follows.followerCount(target.id).catch(() => 0)]);
  // So the Follow button on the artist's page can say "Following" (see the top of this file).
  const cookie = viewCookie(ctx, me.id);
  if (cookie) response.setHeader("set-cookie", cookie);
  const hidden = `<input type="hidden" name="id" value="${escape(target.id)}"><input type="hidden" name="name" value="${escape(target.name)}">${target.back ? `<input type="hidden" name="back" value="${escape(target.back)}">` : ""}`;
  send(response, 200, page(`Follow ${target.name}`, `<h1>${escape(target.name)}</h1>
<p class="by">${following ? "You follow them." : "Follow them to keep them with your follows on nixamp.com."} ${count} follower${count === 1 ? "" : "s"}.</p>
<form method="post" action="/follow">${hidden}<input type="hidden" name="act" value="${following ? "unfollow" : "follow"}">
<button type="submit"${following ? ' class="quiet"' : ""}>${following ? "Unfollow" : `Follow ${escape(target.name)}`}</button></form>
${back}`), method);
  return true;
}

/** The button: "Following" to a follower this browser can show us, "Follow" otherwise; both open /follow. */
async function followButton(request: IncomingMessage, response: ServerResponse, url: URL, ctx: FollowPageContext): Promise<boolean> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET" }).end();
    return true;
  }
  const target = followTarget(url.searchParams);
  const headers = { "content-type": "text/html; charset=utf-8", "content-security-policy": buttonCsp(ctx.frameAncestors ?? []), "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  if (!target) {
    response.writeHead(404, headers);
    response.end(method === "HEAD" ? undefined : "<!doctype html><title>Follow</title>");
    return true;
  }
  // The session when it reaches us (nixamp.com's own pages), else the follow-state cookie.
  const me = await ctx.account().catch(() => null);
  const account = me?.id || (ctx.viewSecret ? readView(ctx.viewSecret, cookieValue(request, VIEW_COOKIE), ctx.now?.() ?? Date.now()) : "");
  const following = account ? await ctx.follows.isFollowing(account, target.id).catch(() => false) : false;
  const label = (url.searchParams.get("label") ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 140) || `Follow ${target.name}`;
  const open = `/follow?${new URLSearchParams({ id: target.id, name: target.name, ...(target.back ? { back: target.back } : {}) }).toString()}`;
  const text = following ? "✓ Following" : label;
  response.writeHead(200, headers);
  response.end(method === "HEAD" ? undefined : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escape(text)}</title><style>${BUTTON_STYLE}</style></head>
<body><a href="${escape(open)}" target="_top"${following ? ' class="on"' : ""} title="${escape(following ? `You follow ${target.name} on nixamp.com` : `${label} on nixamp.com`)}">${escape(text)}</a></body></html>`);
  return true;
}

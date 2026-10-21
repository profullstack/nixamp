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
 */
import { createHash } from "node:crypto";
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
}

const ID = /^artist:[a-z0-9-]{1,90}$/;

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

/** Answers /follow; false for any other path. */
export async function handleFollowPage(request: IncomingMessage, response: ServerResponse, path: string, url: URL, ctx: FollowPageContext): Promise<boolean> {
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
    response.writeHead(303, { location: again, "cache-control": "no-store" });
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
  const hidden = `<input type="hidden" name="id" value="${escape(target.id)}"><input type="hidden" name="name" value="${escape(target.name)}">${target.back ? `<input type="hidden" name="back" value="${escape(target.back)}">` : ""}`;
  send(response, 200, page(`Follow ${target.name}`, `<h1>${escape(target.name)}</h1>
<p class="by">${following ? "You follow them." : "Follow them to keep them with your follows on nixamp.com."} ${count} follower${count === 1 ? "" : "s"}.</p>
<form method="post" action="/follow">${hidden}<input type="hidden" name="act" value="${following ? "unfollow" : "follow"}">
<button type="submit"${following ? ' class="quiet"' : ""}>${following ? "Unfollow" : `Follow ${escape(target.name)}`}</button></form>
${back}`), method);
  return true;
}

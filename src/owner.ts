/**
 * Who may administer this server.
 *
 * Two ways to be allowed, and they answer different questions:
 *
 * - You hold the control key. That is possession of the share link the server
 *   printed, which means you are at the machine or someone at it told you.
 * - You are signed in to nixamp.com as the account that owns this server. That
 *   is identity, and it works from a phone on the other side of the world.
 *
 * The server cannot check a nixamp.com token itself -- it has no part of that
 * secret, and it should not. So it asks nixamp.com who the token belongs to and
 * compares the answer to the owner it recorded at startup. Delegating identity
 * and keeping authorisation local is what lets a nixamp on a laptop trust an
 * account it has never seen.
 */

/** How long an answer from nixamp.com is trusted before asking again. */
export const CACHE_MS = 60_000;

export interface OwnerOptions {
  /** The account id that owns this server, from the CLI session at startup. */
  ownerId: string;
  /** Where to ask about a token. */
  site: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface AdminCheck {
  /** May this caller administer the server? */
  allowed: boolean;
  /** How they proved it, for the admin view to show. */
  as: "key" | "owner" | null;
}

/**
 * Ask nixamp.com who a token belongs to, and remember the answer briefly.
 *
 * Briefly, because an admin request should not cost a round trip to another
 * host every time, and not for long, because a revoked session should stop
 * working in about a minute rather than whenever the process restarts.
 */
export class Owner {
  private readonly cache = new Map<string, { id: string; at: number }>();

  constructor(private readonly options: OwnerOptions) {}

  get claimed(): boolean {
    return this.options.ownerId !== "";
  }

  /** The account a token belongs to, or "" for one nixamp.com does not accept. */
  async accountFor(token: string): Promise<string> {
    if (!token) return "";
    const now = (this.options.now ?? Date.now)();

    const remembered = this.cache.get(token);
    if (remembered && now - remembered.at < CACHE_MS) return remembered.id;

    const send = this.options.fetcher ?? fetch;
    try {
      const answer = await send(`${this.options.site}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!answer.ok) {
        // Remember the refusal too, or a wrong token costs a round trip on
        // every request it is presented with.
        this.cache.set(token, { id: "", at: now });
        return "";
      }
      const body = (await answer.json()) as { account?: { id?: string } };
      const id = typeof body.account?.id === "string" ? body.account.id : "";
      this.cache.set(token, { id, at: now });
      return id;
    } catch {
      // nixamp.com being unreachable must not turn into "everyone is the
      // owner". It turns into "nobody is", and the control key still works.
      return "";
    }
  }

  async check(hasControlKey: boolean, token: string): Promise<AdminCheck> {
    if (hasControlKey) return { allowed: true, as: "key" };
    if (!this.claimed) return { allowed: false, as: null };
    const account = await this.accountFor(token);
    return account !== "" && account === this.options.ownerId
      ? { allowed: true, as: "owner" }
      : { allowed: false, as: null };
  }

  /** Forget everything remembered, so a sign-out takes effect at once. */
  forget(): void {
    this.cache.clear();
  }
}

/** Paths only an administrator may reach. */
export const ADMIN_PATHS = [
  "/api/connections",
  "/api/source",
  "/api/broadcast",
  "/api/ingest",
  "/api/admin",
];

/**
 * Going live and coming back off, which is administering a server.
 *
 * Listed separately from ADMIN_PATHS on purpose: those match by prefix, and
 * `/api/live` itself is the public listen address -- the one the phone line is
 * handed. Gating it by prefix would shut the front door to lock the office.
 */
const LIVE_CONTROL = ["/api/live/start", "/api/live/stop"];

export function needsAdmin(path: string, method = "GET"): boolean {
  if (LIVE_CONTROL.includes(path)) return true;
  if (ADMIN_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  // Publishing to a channel, or ending one, is administering the server.
  // Listening to a channel is not: that is what the share link is for.
  if (path.startsWith("/api/channels/") && method !== "GET") return true;
  // Adding, refreshing or removing a catalog is administering; browsing one,
  // and picking something in it to play, is what the link is for.
  if (path.startsWith("/api/catalogs") && method !== "GET" && !path.endsWith("/play")) return true;
  // Having the server fetch a link -- to put it on the air, or to download
  // it -- is administering: it is a decoder and a download on somebody
  // else's machine, and a listen link used to be able to start as many as
  // it liked. A link a viewer wants to watch plays in their own browser.
  if (path.startsWith("/api/links")) return true;
  // Going live with a file on this server is the same act as going live
  // with a catalog entry, and the same question.
  if (/^\/api\/tracks\/\d+\/live$/.test(path)) return true;
  return false;
}

/**
 * The administering that a member may do too.
 *
 * A member is anybody signed in to nixamp.com: not the owner, not holding
 * the control link, but a known account. Going live is theirs -- a file on
 * this server, a catalog entry, keeping something that was started on
 * demand, and taking off what they put on -- because a directory of servers
 * nobody but their owners can go live on is a directory of empty rooms.
 * Everything else that administers stays the owner's: the source, the
 * connections, the catalogs, the links the server fetches.
 */
export function needsMember(path: string, method = "GET"): boolean {
  if (method === "POST" && /^\/api\/tracks\/\d+\/live$/.test(path)) return true;
  if (method === "POST" && /^\/api\/catalogs\/[^/]+\/entries\/[^/]+\/live$/.test(path)) return true;
  if (method === "POST" && /^\/api\/channels\/[^/]+\/keep$/.test(path)) return true;
  // A link -- a YouTube page, an IPTV feed, a file somewhere -- is the one
  // thing a member can go live with that needs nothing on the server first,
  // and it was the one thing they could not. Going live with one is the same
  // act as going live with a file here: counted, marked theirs, and capped
  // by the handler. Fetching a link to keep (download) stays the owner's.
  if (method === "POST" && path === "/api/links/play") return true;
  // Only their own; the handler checks whose it is.
  if (method === "DELETE" && /^\/api\/channels\/[^/]+$/.test(path)) return true;
  // Renaming what they put on, likewise.
  if (method === "PATCH" && /^\/api\/channels\/[^/]+$/.test(path)) return true;
  return false;
}

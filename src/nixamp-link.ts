/**
 * A nixamp account, connected to an account here.
 *
 * backtoschool.help runs on the nixamp codebase, and for a while its sign-in
 * dialog said so: "your BackToSchool identity is your NixAmp account". That
 * made a password manager file the nixamp password under the school's
 * address, and it made nixamp a thing every teacher had to have. Neither is
 * wanted. A BackToSchool account is a BackToSchool account; nixamp is the
 * broadcast backend a host may plug in, and plugging it in is a choice.
 *
 * So the school is an OAuth 2.1 client of nixamp.com, the way bittorrented
 * is: PKCE, a consent page on nixamp.com, a refresh token kept here against
 * the school account, and a grant the person can withdraw from either side.
 * What the connection buys is the list of the servers they run on nixamp and
 * what is live on them, so "go live" is a pick from a list rather than a
 * link pasted from a terminal.
 *
 * The client half of OAuth is behind an interface, because the server on the
 * other end is this same program in production and a stub in a test.
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "./follows.ts";
import { challengeFor } from "./oauth-server.ts";
import type { LinkView } from "./nixamp-link-types.ts";
export type { LinkView } from "./nixamp-link-types.ts";

const TABLE = "nixamp_links";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    user_id           TEXT PRIMARY KEY,
    nixamp_user_id    TEXT NOT NULL,
    handle            TEXT NOT NULL DEFAULT '',
    scope             TEXT NOT NULL DEFAULT '',
    access_token      TEXT NOT NULL DEFAULT '',
    access_expires_at TIMESTAMPTZ,
    refresh_token     TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/** What the school asks nixamp for: who you are, your servers, and to keep it. */
export const LINK_SCOPE = "profile streams offline_access";

/** How long before an access token's end it is treated as spent. */
const EARLY_MS = 60_000;

export interface TokenGrant {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface WhoAmI {
  sub: string;
  handle?: string;
}

/** The client side of OAuth 2.1, against the issuer, however it is reached. */
export interface OAuthExchange {
  authorizeUrl(query: Record<string, string>): string;
  /** The token endpoint. Rejects with an Error whose message is fit to show. */
  token(form: URLSearchParams): Promise<TokenGrant>;
  userinfo(accessToken: string): Promise<WhoAmI>;
  revoke(token: string): Promise<void>;
}

export const NOT_CONNECTED: LinkView = { connected: false, handle: "", nixampUserId: "", scope: "", since: null };

/** The real thing: nixamp.com over HTTP. */
export function nixampExchange(issuer: string, clientId: string, fetcher: typeof fetch = fetch): OAuthExchange {
  const base = issuer.replace(/\/+$/, "");
  async function post(path: string, form: URLSearchParams, accept: "json" | "none"): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("nixamp.com could not be reached");
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok && accept === "json") {
      const description = typeof body["error_description"] === "string" ? body["error_description"] : typeof body["error"] === "string" ? body["error"] : `nixamp.com answered ${response.status}`;
      throw new Error(description);
    }
    return body;
  }
  return {
    authorizeUrl(query) {
      const url = new URL(`${base}/api/v1/oauth/authorize`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return url.href;
    },
    async token(form) {
      form.set("client_id", clientId);
      const body = await post("/api/v1/oauth/token", form, "json");
      if (typeof body["access_token"] !== "string" || body["access_token"] === "") throw new Error("nixamp.com sent no token");
      return body as unknown as TokenGrant;
    },
    async userinfo(accessToken) {
      let response: Response;
      try {
        response = await fetcher(`${base}/api/v1/oauth/userinfo`, {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("nixamp.com could not be reached");
      }
      if (!response.ok) throw new Error("nixamp.com did not say whose token that is");
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body["sub"] !== "string" || body["sub"] === "") throw new Error("nixamp.com did not say whose token that is");
      return { sub: body["sub"], ...(typeof body["handle"] === "string" ? { handle: body["handle"] } : {}) };
    },
    async revoke(token) {
      const form = new URLSearchParams({ token, client_id: clientId });
      await post("/api/v1/oauth/revoke", form, "none").catch(() => undefined);
    },
  };
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

function view(row: Record<string, unknown> | undefined): LinkView {
  if (!row) return { ...NOT_CONNECTED };
  return {
    connected: true,
    handle: String(row["handle"] ?? ""),
    nixampUserId: String(row["nixamp_user_id"] ?? ""),
    scope: String(row["scope"] ?? ""),
    since: asTime(row["created_at"]),
  };
}

export class NixampLinks {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly exchange: OAuthExchange,
    private readonly clientId: string,
    private readonly now: () => number = () => Date.now(),
    /** How nixamp.com and the servers it lists are reached, for what the tokens are used on. */
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /**
   * The first leg: where to send the browser, and the two secrets the
   * callback must bring back. The state is the CSRF check, the verifier is
   * PKCE; both live in a short cookie on the school's origin, never here.
   */
  begin(redirectUri: string): { url: string; state: string; verifier: string } {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const url = this.exchange.authorizeUrl({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: LINK_SCOPE,
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: "S256",
    });
    return { url, state, verifier };
  }

  /** The second leg: the code becomes tokens, the tokens say whose, and that is kept. */
  async finish(userId: string, leg: { code: string; verifier: string; redirectUri: string }): Promise<LinkView> {
    const grant = await this.exchange.token(new URLSearchParams({
      grant_type: "authorization_code",
      code: leg.code,
      code_verifier: leg.verifier,
      redirect_uri: leg.redirectUri,
    }));
    const who = await this.exchange.userinfo(grant.access_token);
    await this.ensure();
    await this.db.query(
      `INSERT INTO ${TABLE} (user_id, nixamp_user_id, handle, scope, access_token, access_expires_at, refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET nixamp_user_id = EXCLUDED.nixamp_user_id, handle = EXCLUDED.handle,
         scope = EXCLUDED.scope, access_token = EXCLUDED.access_token, access_expires_at = EXCLUDED.access_expires_at,
         refresh_token = EXCLUDED.refresh_token, updated_at = NOW()`,
      [userId, who.sub, who.handle ?? "", grant.scope ?? LINK_SCOPE, grant.access_token, this.expiry(grant), grant.refresh_token ?? ""],
    );
    return this.of(userId);
  }

  private expiry(grant: TokenGrant): Date {
    const seconds = typeof grant.expires_in === "number" && grant.expires_in > 0 ? grant.expires_in : 3600;
    return new Date(this.now() + seconds * 1000);
  }

  async of(userId: string): Promise<LinkView> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT nixamp_user_id, handle, scope, created_at FROM ${TABLE} WHERE user_id = $1`,
      [userId],
    );
    return view(rows[0]);
  }

  /**
   * A token good for a call right now, refreshed when the one kept is about
   * to end. "" when there is no connection, or the refresh was refused --
   * which is what a grant withdrawn on nixamp.com looks like from here, and
   * the row is dropped so the settings page says so too.
   */
  async accessToken(userId: string): Promise<string> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT access_token, access_expires_at, refresh_token FROM ${TABLE} WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return "";
    const access = String(row["access_token"] ?? "");
    const until = asTime(row["access_expires_at"]);
    if (access !== "" && until !== null && until - this.now() > EARLY_MS) return access;
    const refresh = String(row["refresh_token"] ?? "");
    if (refresh === "") return "";
    let grant: TokenGrant;
    try {
      grant = await this.exchange.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }));
    } catch {
      await this.db.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId]);
      return "";
    }
    await this.db.query(
      `UPDATE ${TABLE} SET access_token = $2, access_expires_at = $3, refresh_token = $4, updated_at = NOW() WHERE user_id = $1`,
      [userId, grant.access_token, this.expiry(grant), grant.refresh_token ?? refresh],
    );
    return grant.access_token;
  }

  /** Withdraw the grant on nixamp.com and forget it here. True when there was one. */
  async disconnect(userId: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query(`SELECT refresh_token, access_token FROM ${TABLE} WHERE user_id = $1`, [userId]);
    const row = rows[0];
    if (!row) return false;
    const refresh = String(row["refresh_token"] ?? "");
    const access = String(row["access_token"] ?? "");
    await this.exchange.revoke(refresh !== "" ? refresh : access);
    await this.db.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId]);
    return true;
  }
}

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
 * is: PKCE and a consent page on nixamp.com. What the connection buys is the
 * list of the servers they run on nixamp and what is live on them, so "go
 * live" is a pick from a list rather than a link pasted from a terminal.
 *
 * No token is kept at rest (fleet rule, 2026-10-28: nothing a user gave us
 * may be readable by root on the box). The row here is the identity link
 * only: which nixamp account, as which handle. The access token lives in
 * this process's memory until it expires (an hour) and is never written to
 * the database; no refresh token is asked for. When it is gone (expired, or
 * the server restarted) the person, who is present to go live, clicks
 * "Refresh from nixamp" and says yes once more on nixamp.com.
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
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * What the school asks nixamp for: who you are and your servers. Not
 * offline_access: a refresh token would have to be kept somewhere.
 */
export const LINK_SCOPE = "profile streams";

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

export const NOT_CONNECTED: LinkView = { connected: false, ready: false, handle: "", nixampUserId: "", scope: "", since: null };

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

function view(row: Record<string, unknown> | undefined, ready: boolean): LinkView {
  if (!row) return { ...NOT_CONNECTED };
  return {
    connected: true,
    ready,
    handle: String(row["handle"] ?? ""),
    nixampUserId: String(row["nixamp_user_id"] ?? ""),
    scope: String(row["scope"] ?? ""),
    since: asTime(row["created_at"]),
  };
}

export class NixampLinks {
  private ready: Promise<void> | null = null;
  /** Access tokens, in memory only, until they end. Never in the database. */
  private readonly live = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly db: Queryable,
    private readonly exchange: OAuthExchange,
    private readonly clientId: string,
    private readonly now: () => number = () => Date.now(),
    /** How nixamp.com and the servers it lists are reached, for what the tokens are used on. */
    readonly fetcher: typeof fetch = fetch,
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => this.forgetLegacyTokens());
    await this.ready;
  }

  /**
   * Before 0.79 the tokens were kept in this table in plain text. Hand each
   * refresh token back to nixamp.com (so no grant is left standing there),
   * then drop the columns. The identity link stays; the person clicks
   * "Refresh from nixamp" the next time they go live.
   */
  private async forgetLegacyTokens(): Promise<void> {
    const { rows: columns } = await this.db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = '${TABLE}' AND column_name IN ('access_token', 'refresh_token', 'access_expires_at')`,
    );
    if (columns.length === 0) return;
    const names = new Set(columns.map((row) => String(row["column_name"])));
    if (names.has("refresh_token")) {
      const { rows } = await this.db.query(`SELECT refresh_token FROM ${TABLE} WHERE refresh_token <> ''`);
      for (const row of rows) await this.exchange.revoke(String(row["refresh_token"] ?? "")).catch(() => undefined);
    }
    await this.db.query(
      `ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS access_token, DROP COLUMN IF EXISTS refresh_token, DROP COLUMN IF EXISTS access_expires_at`,
    );
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

  /** The second leg: the code becomes a token, the token says whose; who is kept, the token only in memory. */
  async finish(userId: string, leg: { code: string; verifier: string; redirectUri: string }): Promise<LinkView> {
    const grant = await this.exchange.token(new URLSearchParams({
      grant_type: "authorization_code",
      code: leg.code,
      code_verifier: leg.verifier,
      redirect_uri: leg.redirectUri,
    }));
    // Asked for none, but a refresh token sent anyway is handed straight back.
    if (grant.refresh_token) await this.exchange.revoke(grant.refresh_token).catch(() => undefined);
    const who = await this.exchange.userinfo(grant.access_token);
    await this.ensure();
    await this.db.query(
      `INSERT INTO ${TABLE} (user_id, nixamp_user_id, handle, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET nixamp_user_id = EXCLUDED.nixamp_user_id, handle = EXCLUDED.handle,
         scope = EXCLUDED.scope, updated_at = NOW()`,
      [userId, who.sub, who.handle ?? "", grant.scope ?? LINK_SCOPE],
    );
    const seconds = typeof grant.expires_in === "number" && grant.expires_in > 0 ? grant.expires_in : 3600;
    this.live.set(userId, { token: grant.access_token, until: this.now() + seconds * 1000 });
    return this.of(userId);
  }

  async of(userId: string): Promise<LinkView> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT nixamp_user_id, handle, scope, created_at FROM ${TABLE} WHERE user_id = $1`,
      [userId],
    );
    return view(rows[0], rows[0] !== undefined && this.held(userId) !== "");
  }

  private held(userId: string): string {
    const kept = this.live.get(userId);
    if (!kept) return "";
    if (kept.until - this.now() > EARLY_MS) return kept.token;
    this.live.delete(userId);
    return "";
  }

  /**
   * A token good for a call right now, or "" when there is none in memory:
   * not connected, expired, or the server restarted since. The page then
   * offers "Refresh from nixamp".
   */
  async accessToken(userId: string): Promise<string> {
    await this.ensure();
    return this.held(userId);
  }

  /** nixamp.com refused the token: forget it, so the page asks again. */
  drop(userId: string): void {
    this.live.delete(userId);
  }

  /** Withdraw the token on nixamp.com and forget the connection here. True when there was one. */
  async disconnect(userId: string): Promise<boolean> {
    await this.ensure();
    const token = this.held(userId);
    this.live.delete(userId);
    if (token !== "") await this.exchange.revoke(token).catch(() => undefined);
    const { rows } = await this.db.query(`DELETE FROM ${TABLE} WHERE user_id = $1 RETURNING user_id`, [userId]);
    return rows.length > 0;
  }
}

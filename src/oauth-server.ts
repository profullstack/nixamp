/**
 * nixamp.com as somebody else's sign-in: an OAuth 2.1 authorization server.
 *
 * oauth.ts is the other direction -- nixamp signing in *with* GitHub. This
 * file is bittorrented.com (and anything else registered) signing in with
 * nixamp, so a watch party over there can be a room over here under the
 * same account.
 *
 * It is OAuth 2.1 and not 2.0 on purpose, which means the things 2.0 made
 * optional are not optional here:
 *
 * - the authorization code grant only, with PKCE (S256) on every request,
 *   public client or not. No implicit grant, no password grant.
 * - redirect URIs match the registered string exactly. The one exception is
 *   the loopback port (RFC 8252 §7.3), because a CLI cannot know its port
 *   before it listens.
 * - a code is used once. A second use is treated as theft: everything that
 *   code produced is withdrawn.
 * - refresh tokens rotate. Each refresh answers a new one and retires the
 *   old; presenting a retired one again withdraws the whole family, since
 *   the only way that happens is two parties holding one secret.
 * - bearer tokens are nixamp's own revocable `nxa_` tokens, so an access
 *   token walks through `Accounts.whoIs` like any other and every existing
 *   /api/v1 route already understands it.
 *
 * The server describes itself at /.well-known/oauth-authorization-server
 * (RFC 8414), which is how a client finds the endpoints without a config
 * file naming each one.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Account } from "./accounts.ts";
import type { Queryable } from "./follows.ts";
import { hashSecret, mintToken, splitToken, TOKEN_PREFIX, type Tokens } from "./tokens.ts";

// --- clients -----------------------------------------------------------------

export interface OAuthClient {
  /** As it appears in `client_id`. */
  id: string;
  /** As it appears on the consent page. */
  name: string;
  /** Exact strings. A loopback one (http://127.0.0.1 or http://localhost) matches any port. */
  redirectUris: string[];
  /** sha256 of the secret, for a confidential client; absent for a public one (PKCE alone). */
  secretHash?: string;
  /** Where the client lives, shown as a link on the consent page. */
  homepage?: string;
}

/** What a client may ask for, and what each word means to the rest of nixamp. */
export const SCOPES = {
  profile: "who you are on nixamp (your handle)",
  email: "the address on your account",
  parties: "host and join watch parties as you",
  offline_access: "stay connected without asking again",
} as const;

export type Scope = keyof typeof SCOPES;

export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];

/** How long the pieces live. A code is minutes; a session is not. */
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;

/**
 * The client nixamp ships knowing about. bittorrented.com is the reason this
 * file exists, and asking a deploy to paste its redirect URIs into an
 * environment variable before the two sites can talk is a setup step that
 * would be forgotten. Public (no secret) because PKCE is what protects the
 * exchange, and a secret would only add something to leak.
 */
export const BITTORRENTED_CLIENT: OAuthClient = {
  id: "bittorrented",
  name: "bittorrented.com",
  homepage: "https://bittorrented.com",
  redirectUris: [
    "https://bittorrented.com/api/v1/nixamp/oauth/callback",
    "http://localhost:3000/api/v1/nixamp/oauth/callback",
    "http://127.0.0.1/api/v1/nixamp/oauth/callback",
  ],
};

/**
 * The registered clients: the built-in one, plus whatever NIXAMP_OAUTH_CLIENTS
 * names. The variable is a JSON list of `{id, name, redirectUris, secret?,
 * homepage?}`; an entry with the built-in id replaces it, so a staging
 * bittorrented can point the callback somewhere else.
 */
export function clientsFrom(env: Record<string, string | undefined>): OAuthClient[] {
  const byId = new Map<string, OAuthClient>([[BITTORRENTED_CLIENT.id, BITTORRENTED_CLIENT]]);
  const raw = env["NIXAMP_OAUTH_CLIENTS"];
  if (raw) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const id = typeof record["id"] === "string" ? record["id"].trim() : "";
      const uris = Array.isArray(record["redirectUris"])
        ? record["redirectUris"].filter((one): one is string => typeof one === "string" && one !== "")
        : [];
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || uris.length === 0) continue;
      const client: OAuthClient = {
        id,
        name: typeof record["name"] === "string" && record["name"] ? record["name"] : id,
        redirectUris: uris,
        ...(typeof record["secret"] === "string" && record["secret"] ? { secretHash: hashSecret(record["secret"]) } : {}),
        ...(typeof record["homepage"] === "string" && record["homepage"] ? { homepage: record["homepage"] } : {}),
      };
      byId.set(id, client);
    }
  }
  if (env["NIXAMP_OAUTH_BITTORRENTED"] === "off") byId.delete(BITTORRENTED_CLIENT.id);
  return [...byId.values()];
}

/** Loopback is the address; the port is whatever the CLI got (RFC 8252 §7.3). */
function loopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
}

/** Does this redirect URI belong to the client, exactly, or exactly but for a loopback port? */
export function redirectAllowed(client: OAuthClient, candidate: string): boolean {
  if (client.redirectUris.includes(candidate)) return true;
  let offered: URL;
  try {
    offered = new URL(candidate);
  } catch {
    return false;
  }
  if (!loopback(offered) || offered.hash !== "") return false;
  return client.redirectUris.some((registered) => {
    let known: URL;
    try {
      known = new URL(registered);
    } catch {
      return false;
    }
    return loopback(known) && known.hostname === offered.hostname && known.pathname === offered.pathname && known.search === offered.search;
  });
}

// --- PKCE ----------------------------------------------------------------------

/** RFC 7636 §4.1: 43 to 128 of the unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url of 32 bytes, as S256 makes it. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return false;
  const made = Buffer.from(challengeFor(verifier));
  const kept = Buffer.from(challenge);
  return made.length === kept.length && timingSafeEqual(made, kept);
}

// --- what a request is, once checked -------------------------------------------

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  scope: Scope[];
  state: string;
  codeChallenge: string;
}

/**
 * A request that cannot be answered by redirecting. Sending an error back to
 * an unregistered redirect URI is an open redirector, which is why a bad
 * client or a bad redirect is a page and not a bounce.
 */
export interface AuthorizeRefusal {
  error: string;
  description: string;
  /** Set when the redirect URI checked out, so the client may be told. */
  redirectUri?: string;
  state?: string;
}

export function parseScope(value: unknown): Scope[] | null {
  const words = typeof value === "string" && value.trim() !== "" ? value.trim().split(/\s+/) : ["profile"];
  const chosen: Scope[] = [];
  for (const word of words) {
    if (!SCOPE_NAMES.includes(word as Scope)) return null;
    if (!chosen.includes(word as Scope)) chosen.push(word as Scope);
  }
  return chosen;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

// --- storage -------------------------------------------------------------------

const CODES = "nixamp_oauth_codes";
const REFRESH = "nixamp_oauth_refresh";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${CODES} (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    email          TEXT NOT NULL DEFAULT '',
    redirect_uri   TEXT NOT NULL,
    scope          TEXT NOT NULL DEFAULT '',
    code_challenge TEXT NOT NULL,
    family         TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    used_at        TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS ${REFRESH} (
    id           TEXT PRIMARY KEY,
    secret_hash  TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    email        TEXT NOT NULL DEFAULT '',
    scope        TEXT NOT NULL DEFAULT '',
    family       TEXT NOT NULL,
    access_id    TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    rotated_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS ${REFRESH}_family ON ${REFRESH} (family);
  CREATE INDEX IF NOT EXISTS ${REFRESH}_user ON ${REFRESH} (user_id);
`;

export const REFRESH_PREFIX = "nxr_";

function mintRefresh(): { id: string; secret: string; token: string } {
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `${REFRESH_PREFIX}${id}_${secret}` };
}

function splitRefresh(value: unknown): { id: string; secret: string } | null {
  if (typeof value !== "string" || !value.startsWith(REFRESH_PREFIX)) return null;
  const rest = value.slice(REFRESH_PREFIX.length);
  const cut = rest.indexOf("_");
  if (cut <= 0) return null;
  const id = rest.slice(0, cut);
  const secret = rest.slice(cut + 1);
  return /^[0-9a-f]+$/.test(id) && secret.length >= 16 ? { id, secret } : null;
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return typeof value === "number" ? value : null;
}

/** The body of a successful token response, RFC 6749 §5.1 names and all. */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface AuthorizationServerOptions {
  db: Queryable;
  /** Where access tokens come from, so `whoIs` recognises them. */
  tokens: Tokens;
  clients: OAuthClient[];
  /** The issuer, e.g. https://nixamp.com. */
  issuer: string;
  now?: () => number;
}

export class AuthorizationServer {
  private ready: Promise<void> | null = null;
  private readonly now: () => number;
  readonly issuer: string;
  readonly clients: OAuthClient[];

  constructor(private readonly options: AuthorizationServerOptions) {
    this.now = options.now ?? Date.now;
    this.issuer = options.issuer.replace(/\/+$/, "");
    this.clients = options.clients;
  }

  private async ensure(): Promise<void> {
    this.ready ??= this.options.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  client(id: unknown): OAuthClient | null {
    return typeof id === "string" ? (this.clients.find((one) => one.id === id) ?? null) : null;
  }

  /** RFC 8414. Everything a client needs to find, in the place it looks. */
  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/api/v1/oauth/authorize`,
      token_endpoint: `${this.issuer}/api/v1/oauth/token`,
      revocation_endpoint: `${this.issuer}/api/v1/oauth/revoke`,
      userinfo_endpoint: `${this.issuer}/api/v1/oauth/userinfo`,
      scopes_supported: SCOPE_NAMES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      service_documentation: "https://github.com/profullstack/nixamp",
    };
  }

  /**
   * Check an authorization request before anybody is asked to approve it.
   * The order matters: the client and redirect URI are checked first, and a
   * problem with either is answered to the browser, never to the URI.
   */
  check(params: URLSearchParams): AuthorizeRequest | AuthorizeRefusal {
    const client = this.client(params.get("client_id"));
    if (client === null) return { error: "invalid_client", description: "unknown client_id" };
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!redirectUri || !redirectAllowed(client, redirectUri)) {
      return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
    }
    const state = params.get("state") ?? "";
    const refuse = (error: string, description: string): AuthorizeRefusal => ({ error, description, redirectUri, state });
    if (params.get("response_type") !== "code") {
      return refuse("unsupported_response_type", "only response_type=code is supported");
    }
    const method = params.get("code_challenge_method") ?? "";
    const codeChallenge = params.get("code_challenge") ?? "";
    if (method !== "S256" || !CHALLENGE.test(codeChallenge)) {
      return refuse("invalid_request", "code_challenge with code_challenge_method=S256 is required");
    }
    const scope = parseScope(params.get("scope"));
    if (scope === null) return refuse("invalid_scope", `scope may name ${SCOPE_NAMES.join(", ")}`);
    return { client, redirectUri, scope, state, codeChallenge };
  }

  /** The URL the browser goes back to, with the answer in the query. */
  static redirect(uri: string, params: Record<string, string>): string {
    const url = new URL(uri);
    for (const [name, value] of Object.entries(params)) {
      if (value !== "") url.searchParams.set(name, value);
    }
    return url.toString();
  }

  /** Approved: mint a code the client can exchange, once, within minutes. */
  async issueCode(request: AuthorizeRequest, account: Account): Promise<string> {
    await this.ensure();
    const code = randomBytes(32).toString("base64url");
    const at = this.now();
    await this.options.db.query(
      `INSERT INTO ${CODES} (code_hash, client_id, user_id, email, redirect_uri, scope, code_challenge, family, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        hashSecret(code),
        request.client.id,
        account.id,
        account.email,
        request.redirectUri,
        request.scope.join(" "),
        request.codeChallenge,
        randomBytes(12).toString("hex"),
        new Date(at).toISOString(),
        new Date(at + CODE_TTL_MS).toISOString(),
      ],
    );
    return code;
  }

  /**
   * Who the token endpoint is talking to. A confidential client must present
   * its secret, in the body or as basic auth; a public client must not
   * present one it does not have. Either way the client named must exist.
   */
  authenticateClient(form: URLSearchParams, authorization: string | undefined): OAuthClient {
    let id = form.get("client_id") ?? "";
    let secret = form.get("client_secret") ?? "";
    const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "")?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      const cut = decoded.indexOf(":");
      if (cut > 0) {
        id = decodeURIComponent(decoded.slice(0, cut));
        secret = decodeURIComponent(decoded.slice(cut + 1));
      }
    }
    const client = this.client(id);
    if (client === null) throw new OAuthError("invalid_client", "unknown client_id", 401);
    if (client.secretHash) {
      if (!secret || !sameHash(client.secretHash, hashSecret(secret))) {
        throw new OAuthError("invalid_client", "client authentication failed", 401);
      }
    }
    return client;
  }

  private async withdrawFamily(family: string): Promise<void> {
    const { rows } = await this.options.db.query(
      `UPDATE ${REFRESH} SET revoked_at = NOW() WHERE family = $1 AND revoked_at IS NULL RETURNING access_id`,
      [family],
    );
    for (const row of rows) {
      const accessId = String(row["access_id"] ?? "");
      if (accessId) await this.options.tokens.revokeById(accessId).catch(() => {});
    }
  }

  private async issueTokens(
    client: OAuthClient,
    account: Account,
    scope: string,
    family: string,
  ): Promise<TokenResponse> {
    const words = scope ? scope.split(" ") : [];
    const access = await this.options.tokens.issue({
      account,
      kind: "oauth",
      // The client and the scope, so `nixamp token list` says what this is
      // and userinfo can tell an `email` grant from a `profile` one.
      name: `${client.id} ${scope}`.trim(),
      ttlMs: ACCESS_TTL_MS,
    });
    const answer: TokenResponse = {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: Math.round(ACCESS_TTL_MS / 1000),
      scope,
    };
    if (words.includes("offline_access")) {
      const refresh = mintRefresh();
      const at = this.now();
      await this.options.db.query(
        `INSERT INTO ${REFRESH} (id, secret_hash, client_id, user_id, email, scope, family, access_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          refresh.id,
          hashSecret(refresh.secret),
          client.id,
          account.id,
          account.email,
          scope,
          family,
          access.id,
          new Date(at).toISOString(),
          new Date(at + REFRESH_TTL_MS).toISOString(),
        ],
      );
      answer.refresh_token = refresh.token;
    }
    return answer;
  }

  /** grant_type=authorization_code. */
  async exchangeCode(client: OAuthClient, form: URLSearchParams): Promise<TokenResponse> {
    await this.ensure();
    const code = form.get("code") ?? "";
    if (!code) throw new OAuthError("invalid_request", "code is required");
    const { rows } = await this.options.db.query(
      `SELECT client_id, user_id, email, redirect_uri, scope, code_challenge, family, expires_at, used_at
         FROM ${CODES} WHERE code_hash = $1`,
      [hashSecret(code)],
    );
    const row = rows[0];
    if (!row || String(row["client_id"]) !== client.id) {
      throw new OAuthError("invalid_grant", "that code is not valid");
    }
    const family = String(row["family"] ?? "");
    if (row["used_at"]) {
      // A code presented twice is a code somebody else also has. Everything
      // the first use produced goes with it.
      await this.withdrawFamily(family);
      throw new OAuthError("invalid_grant", "that code was already used");
    }
    const expiresAt = asTime(row["expires_at"]) ?? 0;
    if (expiresAt <= this.now()) throw new OAuthError("invalid_grant", "that code has expired");
    if ((form.get("redirect_uri") ?? "") !== String(row["redirect_uri"])) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the one the code was issued to");
    }
    if (!verifierMatches(form.get("code_verifier"), String(row["code_challenge"] ?? ""))) {
      throw new OAuthError("invalid_grant", "code_verifier does not match");
    }
    await this.options.db.query(`UPDATE ${CODES} SET used_at = NOW() WHERE code_hash = $1`, [hashSecret(code)]);
    const account: Account = { id: String(row["user_id"]), email: String(row["email"] ?? "") };
    return this.issueTokens(client, account, String(row["scope"] ?? ""), family);
  }

  /** grant_type=refresh_token: a new pair, and the old one retired. */
  async refresh(client: OAuthClient, form: URLSearchParams): Promise<TokenResponse> {
    await this.ensure();
    const parts = splitRefresh(form.get("refresh_token"));
    if (parts === null) throw new OAuthError("invalid_grant", "that refresh token is not valid");
    const { rows } = await this.options.db.query(
      `SELECT secret_hash, client_id, user_id, email, scope, family, access_id, expires_at, rotated_at, revoked_at
         FROM ${REFRESH} WHERE id = $1`,
      [parts.id],
    );
    const row = rows[0];
    if (!row || !sameHash(String(row["secret_hash"] ?? ""), hashSecret(parts.secret)) || String(row["client_id"]) !== client.id) {
      throw new OAuthError("invalid_grant", "that refresh token is not valid");
    }
    const family = String(row["family"] ?? "");
    if (row["revoked_at"]) throw new OAuthError("invalid_grant", "that refresh token was revoked");
    if (row["rotated_at"]) {
      // Already exchanged once. Whoever is presenting it now is not the
      // holder of the current one, or is, and lost it -- both end the same.
      await this.withdrawFamily(family);
      throw new OAuthError("invalid_grant", "that refresh token was already used");
    }
    if ((asTime(row["expires_at"]) ?? 0) <= this.now()) {
      throw new OAuthError("invalid_grant", "that refresh token has expired");
    }
    // A narrower scope may be asked for on refresh; a wider one may not.
    const held = String(row["scope"] ?? "").split(" ").filter(Boolean);
    const asked = form.get("scope");
    let scope = held;
    if (asked) {
      const wanted = parseScope(asked);
      if (wanted === null || wanted.some((word) => !held.includes(word))) {
        throw new OAuthError("invalid_scope", "a refresh may narrow the scope, not widen it");
      }
      scope = wanted;
    }
    await this.options.db.query(`UPDATE ${REFRESH} SET rotated_at = NOW() WHERE id = $1`, [parts.id]);
    const accessId = String(row["access_id"] ?? "");
    if (accessId) await this.options.tokens.revokeById(accessId).catch(() => {});
    const account: Account = { id: String(row["user_id"]), email: String(row["email"] ?? "") };
    return this.issueTokens(client, account, scope.join(" "), family);
  }

  /** RFC 7009. Either kind of token; a token that is not ours is "already gone". */
  async revoke(client: OAuthClient, token: string): Promise<void> {
    await this.ensure();
    const refresh = splitRefresh(token);
    if (refresh) {
      const { rows } = await this.options.db.query(`SELECT client_id, family FROM ${REFRESH} WHERE id = $1`, [refresh.id]);
      const row = rows[0];
      if (row && String(row["client_id"]) === client.id) await this.withdrawFamily(String(row["family"]));
      return;
    }
    const access = splitToken(token);
    if (access) {
      const record = await this.options.tokens.inspect(token);
      if (record && record.kind === "oauth" && record.name.split(" ")[0] === client.id) {
        await this.options.tokens.revokeById(access.id);
      }
    }
  }

  /**
   * The grant behind a bearer token, or null for one that is not an OAuth
   * access token at all.
   *
   * This is how a route decides whether the caller may do the thing: the
   * account is who, and the scope is what they were allowed to ask for on
   * that account's behalf. A session cookie or a CLI token answers null
   * here, which is correct -- those are the person themselves, and a route
   * that wants a scope should say so rather than assume.
   */
  async grantFor(token: string): Promise<{ account: Account; clientId: string; scope: Scope[] } | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const record = await this.options.tokens.inspect(token);
    if (!record || record.kind !== "oauth") return null;
    const [clientId = "", ...words] = record.name.split(" ");
    return {
      account: record.account,
      clientId,
      scope: words.filter((word): word is Scope => SCOPE_NAMES.includes(word as Scope)),
    };
  }

  /**
   * What an access token says about its holder, RFC-shaped. The address is
   * only in the answer for a grant that asked for it: a handle is public,
   * an address is a credential.
   */
  async userinfo(token: string, handleOf: (userId: string) => Promise<string>): Promise<Record<string, unknown> | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const record = await this.options.tokens.inspect(token);
    if (!record || record.kind !== "oauth") return null;
    const [clientId = "", ...scope] = record.name.split(" ");
    const handle = await handleOf(record.account.id).catch(() => "");
    return {
      sub: record.account.id,
      client_id: clientId,
      scope: scope.join(" "),
      ...(handle ? { handle, preferred_username: handle } : {}),
      ...(scope.includes("email") ? { email: record.account.email, email_verified: true } : {}),
    };
  }

  /** Every connection an account has granted, for a settings page. */
  async grants(userId: string): Promise<{ id: string; clientId: string; clientName: string; scope: string; createdAt: number }[]> {
    await this.ensure();
    const { rows } = await this.options.db.query(
      `SELECT id, client_id, scope, created_at FROM ${REFRESH}
        WHERE user_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((row) => {
      const clientId = String(row["client_id"] ?? "");
      return {
        id: String(row["id"] ?? ""),
        clientId,
        clientName: this.client(clientId)?.name ?? clientId,
        scope: String(row["scope"] ?? ""),
        createdAt: asTime(row["created_at"]) ?? 0,
      };
    });
  }

  /** Disconnect: the account withdraws everything one client holds. */
  async disconnect(userId: string, clientId: string): Promise<number> {
    await this.ensure();
    const { rows } = await this.options.db.query(
      `SELECT DISTINCT family FROM ${REFRESH} WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [userId, clientId],
    );
    for (const row of rows) await this.withdrawFamily(String(row["family"]));
    return rows.length;
  }
}

/** Only for tests: the token format the code endpoint mints, so a fake DB can match it. */
export const _internal = { mintRefresh, splitRefresh, mintToken };

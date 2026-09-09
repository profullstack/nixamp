/**
 * Accounts on nixamp.com.
 *
 * The house auth module does the work: password and JWT, over the Postgres
 * adapter. This is the shape nixamp needs around it, and the two things the
 * module gets wrong from a caller's point of view:
 *
 * - `login()` and `register()` THROW on a bad password or a taken address
 *   rather than resolving `{ success: false }`, so a bare `if (!result.success)`
 *   never runs. Everything here answers a result instead.
 * - `validateToken()` resolves to the claims directly, not to a wrapper like
 *   the other two, so the shapes differ between calls.
 * - `register()` without `autoVerify` creates an account that `login()` will
 *   refuse for ever, and returns no tokens. nixamp sends no email, so there
 *   would be nothing to click.
 *
 * No magic link: a link in an inbox is no use on a television or a phone that
 * is not the one you read mail on. There is now a third way in that suits a
 * terminal better than either -- OAuth 2.0 reached through the device grant in
 * device.ts -- and what it ends with is a token from tokens.ts.
 */
import { createAuthSystem, PostgresAdapter } from "@profullstack/auth-system";
import { Identities, type Identity, type Users } from "./oauth.ts";
import type { Queryable } from "./follows.ts";
import { type IssuedToken, looksLikeToken, type TokenKind, type TokenRecord, Tokens } from "./tokens.ts";

export interface Account {
  id: string;
  email: string;
}

export interface AuthResult {
  ok: boolean;
  account: Account | null;
  token: string;
  /** Safe to show a stranger: it never says whether an address is registered. */
  error: string;
}

const NO_ACCOUNT: AuthResult = { ok: false, account: null, token: "", error: "" };

/**
 * The same sentence for a wrong password and an address with no account.
 * Saying which is how an endpoint tells a stranger who has registered.
 */
const REFUSED = "that email and password do not match an account";

export interface AccountsOptions {
  /** postgres://user:pass@host/db */
  connectionString: string;
  /** Signing secret. Without one, every session dies on restart. */
  secret: string;
  /** Injected by the tests, which have no database. */
  system?: AuthLike;
  /** Also injected by the tests: the storage tokens and identities sit in. */
  adapter?: AdapterLike;
}

/**
 * The slice of the auth module's storage adapter the rest of this file needs.
 * It is the same Postgres pool the users table lives in, which is why nixamp's
 * two tables need no connection of their own.
 */
export interface AdapterLike extends Queryable, Users {}

/** The slice of the auth system nixamp uses. */
export interface AuthLike {
  register(input: { email: string; password: string; autoVerify?: boolean }): Promise<unknown>;
  login(input: { email: string; password: string }): Promise<unknown>;
  validateToken(token: string): Promise<unknown>;
}

/** Pull an account and a token out of whatever shape the module returned. */
export function readResult(value: unknown): AuthResult {
  const record = (value ?? {}) as Record<string, unknown>;
  const user = (record["user"] ?? {}) as Record<string, unknown>;
  const tokens = (record["tokens"] ?? {}) as Record<string, unknown>;
  const id = typeof user["id"] === "string" ? user["id"] : "";
  const email = typeof user["email"] === "string" ? user["email"] : "";
  const token = typeof tokens["accessToken"] === "string" ? tokens["accessToken"] : "";
  if (!id || !token) return { ...NO_ACCOUNT, error: REFUSED };
  return { ok: true, account: { id, email }, token, error: "" };
}

/** `validateToken` answers claims directly, unlike login and register. */
export function readClaims(value: unknown): Account | null {
  const claims = (value ?? {}) as Record<string, unknown>;
  const id = typeof claims["userId"] === "string" ? claims["userId"] : "";
  const email = typeof claims["email"] === "string" ? claims["email"] : "";
  return id ? { id, email } : null;
}

/** An address that could exist, and a password long enough to be worth having. */
export function checkCredentials(email: unknown, password: unknown): string {
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return "that does not look like an email address";
  }
  if (typeof password !== "string" || password.length < 10) {
    // Length is checked here so a hopeless password never reaches the
    // database. The auth module then applies its own composition rules on top,
    // and its refusals are passed through rather than swallowed.
    return "a password needs at least 10 characters";
  }
  if (password.length > 200) return "that password is too long";
  return "";
}

export class Accounts {
  private readonly system: AuthLike;
  /** Null only where a test injected an auth system and no storage. */
  readonly tokens: Tokens | null;
  private readonly identities: Identities | null;

  constructor(options: AccountsOptions) {
    // The adapter is kept rather than only handed over: tokens and provider
    // identities are nixamp's own tables in the same database, and a second
    // pool for two small tables would be a second thing to configure.
    const adapter =
      options.adapter ??
      (options.system
        ? null
        : (new PostgresAdapter({ connectionString: options.connectionString }) as unknown as AdapterLike));
    this.system =
      options.system ??
      (createAuthSystem({
        adapter,
        jwtSecret: options.secret,
      }) as AuthLike);
    this.tokens = adapter ? new Tokens(adapter) : null;
    this.identities = adapter ? new Identities(adapter, adapter) : null;
  }

  async signUp(email: unknown, password: unknown): Promise<AuthResult> {
    const wrong = checkCredentials(email, password);
    if (wrong) return { ...NO_ACCOUNT, error: wrong };
    try {
      // autoVerify does two things, and both are necessary here: without it
      // the account is created unverified and login() refuses it forever --
      // nixamp sends no email, so there is nothing to click -- and register()
      // returns no tokens, so signing up would not sign you in.
      return readResult(
        await this.system.register({
          email: email as string,
          password: password as string,
          autoVerify: true,
        }),
      );
    } catch (error) {
      const message = (error as Error).message ?? "";
      // "already exists" is the one case worth naming: a sign-up form that
      // will not say why is a sign-up form people give up on. It reveals
      // nothing that trying to sign up does not reveal anyway.
      if (/exist|taken|duplicate/i.test(message)) {
        return { ...NO_ACCOUNT, error: "there is already an account with that email" };
      }
      // The module has its own password rules -- an uppercase letter, and so
      // on -- and refuses with a sentence saying which. Hiding that behind
      // "could not create that account" leaves someone retyping a password
      // that will never be accepted.
      const complaint = /^Invalid (?:password|email)[:\s]+(.*)$/i.exec(message);
      if (complaint?.[1]) return { ...NO_ACCOUNT, error: complaint[1].trim().toLowerCase() };
      return { ...NO_ACCOUNT, error: "could not create that account" };
    }
  }

  async signIn(email: unknown, password: unknown): Promise<AuthResult> {
    if (checkCredentials(email, password)) return { ...NO_ACCOUNT, error: REFUSED };
    try {
      return readResult(await this.system.login({ email: email as string, password: password as string }));
    } catch {
      // login() throws on bad credentials, so this is the ordinary path.
      return { ...NO_ACCOUNT, error: REFUSED };
    }
  }

  /**
   * Who a token belongs to, whichever kind of token it is.
   *
   * A `nxa_` token is one this server issued and can withdraw, so it is looked
   * up. Anything else is a JWT from the auth module, which is self-describing
   * and cannot be. Both answer the same shape, so nothing downstream has to
   * know which door the caller came in by.
   */
  async whoIs(token: string): Promise<Account | null> {
    if (!token) return null;
    if (looksLikeToken(token)) {
      if (this.tokens === null) return null;
      try {
        return await this.tokens.verify(token);
      } catch {
        return null;
      }
    }
    try {
      return readClaims(await this.system.validateToken(token));
    } catch {
      return null;
    }
  }

  /**
   * The token a signed-in caller carries away.
   *
   * A revocable token is preferred to the module's JWT wherever there is
   * storage to keep one in, because signing out of a laptop you no longer have
   * should mean something. The JWT is the fallback, and the only difference to
   * a caller is that one of the two can be taken away.
   */
  async sessionFor(account: Account, fallback = ""): Promise<string> {
    if (this.tokens === null) return fallback;
    try {
      return (await this.tokens.issue({ account, kind: "session" })).token;
    } catch {
      return fallback;
    }
  }

  /** Sign in as whoever a provider says this is, making the account if it is new. */
  async signInWith(identity: Identity): Promise<AuthResult> {
    if (this.identities === null) return { ...NO_ACCOUNT, error: "this nixamp does not keep accounts" };
    let account: Account | null = null;
    try {
      account = await this.identities.resolve(identity);
    } catch {
      account = null;
    }
    if (account === null) {
      return { ...NO_ACCOUNT, error: `${identity.provider} did not give a verified email address` };
    }
    const token = await this.sessionFor(account);
    if (!token) return { ...NO_ACCOUNT, error: "could not start a session" };
    return { ok: true, account, token, error: "" };
  }

  /** A token a person made on purpose, for a script that cannot sign in. */
  async mintCliToken(account: Account, name: string, ttlMs: number | null = null): Promise<IssuedToken | null> {
    return this.tokens === null ? null : this.tokens.issue({ account, kind: "cli", name, ttlMs });
  }

  async listTokens(userId: string, kind?: TokenKind): Promise<TokenRecord[]> {
    return this.tokens === null ? [] : this.tokens.list(userId, kind);
  }

  async revokeToken(userId: string, id: string): Promise<boolean> {
    return this.tokens === null ? false : this.tokens.revoke(userId, id);
  }

  /** Signing out ends this session and leaves every other token alone. */
  async endSession(token: string): Promise<void> {
    if (this.tokens === null || !looksLikeToken(token)) return;
    try {
      await this.tokens.revokeToken(token);
    } catch {
      // A session that cannot be deleted still expires, and refusing to sign
      // somebody out because the database blinked would be worse.
    }
  }
}

/** The bearer token on a request, from the header or the session cookie. */
export function tokenFrom(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers["authorization"];
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const bearer = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
  if (bearer) return bearer.trim();

  const cookie = Array.isArray(headers["cookie"]) ? headers["cookie"][0] : headers["cookie"];
  for (const part of (cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "nixamp_session" && rest.length > 0) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/**
 * The session cookie. HttpOnly because nothing in the page reads it -- the
 * browser attaches it by itself -- and Secure only where the page was served
 * over https, since a nixamp on your own network is plain http.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `nixamp_session=${encodeURIComponent(token)}`,
    "Path=/",
    "Max-Age=2592000",
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(): string {
  return "nixamp_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly";
}

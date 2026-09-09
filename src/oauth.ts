/**
 * Signing in with somebody else's account.
 *
 * Two providers, GitHub and Google, both plain OAuth 2.0 authorization code
 * with a client secret held on the server. Neither is configured unless its
 * two environment variables are set, and what is configured is advertised at
 * /api/v1/auth/providers so the CLI can offer exactly the choices that will
 * work rather than a menu of things that 404.
 *
 * The callback lives at /api/v1/<provider>/oauth/callback, which is the shape
 * the rest of the fleet registers with providers: the site's API namespace,
 * the version, then provider, function, endpoint.
 *
 * The one rule worth stating out loud: an address links to an account only if
 * the provider says it verified it. GitHub and Google both report that per
 * address, and both are asked. Without that check, anyone who can add an
 * unverified address at a provider could claim somebody else's nixamp account.
 */
import { randomBytes } from "node:crypto";
import type { Account } from "./accounts.ts";
import type { DeviceGrants } from "./device.ts";
import type { Queryable } from "./follows.ts";

export interface Provider {
  /** As it appears in a URL and in `nixamp login --with <id>`. */
  id: string;
  /** As it appears to a person. */
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Turn the provider's access token into an address it stands behind. */
  identify(accessToken: string, send: typeof fetch): Promise<Identity | null>;
}

/** Who the provider says this is. `subject` is stable when an address is not. */
export interface Identity {
  provider: string;
  subject: string;
  email: string;
}

const AGENT = { "user-agent": "nixamp" };

async function readJson(answer: Response): Promise<Record<string, unknown>> {
  if (!answer.ok) return {};
  return (await answer.json().catch(() => ({}))) as Record<string, unknown>;
}

export function githubProvider(clientId: string, clientSecret: string): Provider {
  return {
    id: "github",
    name: "GitHub",
    clientId,
    clientSecret,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // The address is the part nixamp needs, and GitHub keeps it behind its own
    // scope even when it is public on a profile.
    scope: "read:user user:email",
    async identify(accessToken, send) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", ...AGENT };
      const who = await readJson(await send("https://api.github.com/user", { headers }));
      const subject = who["id"] === undefined ? "" : String(who["id"]);
      if (!subject) return null;

      // /user carries an address only if the account made it public, and even
      // then it may be an unverified one, so the addresses endpoint is asked.
      const answer = await send("https://api.github.com/user/emails", { headers });
      const list = answer.ok ? ((await answer.json().catch(() => [])) as Record<string, unknown>[]) : [];
      const usable = Array.isArray(list) ? list.filter((row) => row["verified"] === true) : [];
      const chosen = usable.find((row) => row["primary"] === true) ?? usable[0];
      const email = typeof chosen?.["email"] === "string" ? chosen["email"] : "";
      if (!email) return null;
      return { provider: "github", subject, email: email.toLowerCase() };
    },
  };
}

export function googleProvider(clientId: string, clientSecret: string): Provider {
  return {
    id: "google",
    name: "Google",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email",
    async identify(accessToken, send) {
      const who = await readJson(
        await send("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { authorization: `Bearer ${accessToken}`, ...AGENT },
        }),
      );
      const subject = typeof who["sub"] === "string" ? who["sub"] : "";
      const email = typeof who["email"] === "string" ? who["email"] : "";
      // Google reports this as a boolean or as the string "true" depending on
      // which endpoint answered, and an unverified address is not a claim.
      const verified = who["email_verified"] === true || who["email_verified"] === "true";
      if (!subject || !email || !verified) return null;
      return { provider: "google", subject, email: email.toLowerCase() };
    },
  };
}

/** Whichever providers this deployment has been given both halves of. */
export function providersFrom(env: Record<string, string | undefined>): Provider[] {
  const found: Provider[] = [];
  if (env["GITHUB_CLIENT_ID"] && env["GITHUB_CLIENT_SECRET"]) {
    found.push(githubProvider(env["GITHUB_CLIENT_ID"], env["GITHUB_CLIENT_SECRET"]));
  }
  if (env["GOOGLE_CLIENT_ID"] && env["GOOGLE_CLIENT_SECRET"]) {
    found.push(googleProvider(env["GOOGLE_CLIENT_ID"], env["GOOGLE_CLIENT_SECRET"]));
  }
  return found;
}

export function redirectUri(site: string, provider: Provider): string {
  return `${site.replace(/\/+$/, "")}/api/v1/${provider.id}/oauth/callback`;
}

/** Where to send the browser. `state` is the only thing standing between this and CSRF. */
export function authorizeUrl(provider: Provider, site: string, state: string): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri(site, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Swap the code for an access token. Empty string means the provider refused. */
export async function exchangeCode(
  provider: Provider,
  code: string,
  site: string,
  send: typeof fetch = fetch,
): Promise<string> {
  const answer = await send(provider.tokenUrl, {
    method: "POST",
    headers: {
      // GitHub answers form-encoded unless asked for JSON, which is the trap
      // that makes a working exchange look like an empty token.
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...AGENT,
    },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri(site, provider),
      grant_type: "authorization_code",
    }).toString(),
  });
  const body = await readJson(answer);
  return typeof body["access_token"] === "string" ? body["access_token"] : "";
}

// --- linking an identity to an account --------------------------------------

const TABLE = "nixamp_identities";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, subject)
  );
`;

/** The slice of the auth module's storage adapter that identities need. */
export interface Users {
  getUserByEmail(email: string): Promise<{ id?: string; email?: string } | null | undefined>;
  createUser(user: {
    email: string;
    password: string | null;
    emailVerified: boolean;
    profile?: Record<string, unknown>;
  }): Promise<{ id?: string; email?: string }>;
}

/**
 * The account behind a provider identity, creating one the first time.
 *
 * The account row is made with no password at all rather than a random one
 * nobody knows. A null password is a fact -- this account signs in with GitHub
 * -- where a random password is a credential sitting in a database waiting to
 * be found.
 */
export class Identities {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly users: Users,
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  async resolve(identity: Identity): Promise<Account | null> {
    if (!identity.subject || !identity.email) return null;
    await this.ensure();

    // Already linked. The subject is what is matched, not the address: people
    // change the address on a GitHub account and stay the same person.
    const { rows } = await this.db.query(`SELECT user_id, email FROM ${TABLE} WHERE provider = $1 AND subject = $2`, [
      identity.provider,
      identity.subject,
    ]);
    const linked = rows[0];
    if (linked) {
      const id = String(linked["user_id"] ?? "");
      if (String(linked["email"] ?? "") !== identity.email) {
        await this.db.query(`UPDATE ${TABLE} SET email = $3 WHERE provider = $1 AND subject = $2`, [
          identity.provider,
          identity.subject,
          identity.email,
        ]);
      }
      return { id, email: identity.email };
    }

    // Not linked, but the address may already have an account -- somebody who
    // signed up with a password and is now signing in with GitHub. Linking on
    // a verified address is what makes those the same account instead of two.
    const existing = await this.users.getUserByEmail(identity.email);
    const account = existing?.id
      ? { id: existing.id, email: existing.email ?? identity.email }
      : await (async () => {
          const made = await this.users.createUser({
            email: identity.email,
            password: null,
            // The provider verified it, which is the whole reason this is
            // allowed to become an account without an email being sent.
            emailVerified: true,
            profile: { signedUpWith: identity.provider },
          });
          return { id: String(made.id ?? ""), email: made.email ?? identity.email };
        })();

    if (!account.id) return null;
    await this.db.query(
      `INSERT INTO ${TABLE} (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email`,
      [identity.provider, identity.subject, account.id, identity.email],
    );
    return account;
  }
}

// --- the sign-in surface ----------------------------------------------------

/**
 * What a round trip to a provider is for.
 *
 * A browser sent to GitHub comes back with a code and a state, and nothing
 * else: whatever the request knew has to be remembered here in the meantime.
 * The state is unguessable and single-use, which is what makes a callback
 * somebody else caused useless.
 */
export interface Pending {
  provider: string;
  /** Set when this round trip is approving a terminal rather than a browser. */
  userCode: string;
  createdAt: number;
}

/** A state is only ever open for the length of one sign-in. */
export const STATE_TTL_MS = 600_000;

export class SignIn {
  private readonly states = new Map<string, Pending>();

  constructor(
    readonly providers: Provider[],
    readonly device: DeviceGrants,
    readonly site: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** What /api/v1/auth/providers says, and what the CLI menu is built from. */
  get offered(): { id: string; name: string }[] {
    return this.providers.map((provider) => ({ id: provider.id, name: provider.name }));
  }

  provider(id: unknown): Provider | null {
    return this.providers.find((candidate) => candidate.id === id) ?? null;
  }

  /** Start a round trip, and answer the URL the browser should go to. */
  begin(provider: Provider, userCode = ""): string {
    this.sweep();
    const state = randomBytes(24).toString("base64url");
    this.states.set(state, { provider: provider.id, userCode, createdAt: this.now() });
    return authorizeUrl(provider, this.site, state);
  }

  /** Redeem a state exactly once, so a replayed callback finds nothing. */
  claim(state: unknown): Pending | null {
    if (typeof state !== "string" || state === "") return null;
    const pending = this.states.get(state);
    if (!pending) return null;
    this.states.delete(state);
    return this.now() - pending.createdAt > STATE_TTL_MS ? null : pending;
  }

  private sweep(): void {
    const at = this.now();
    for (const [state, pending] of this.states) {
      if (at - pending.createdAt > STATE_TTL_MS) this.states.delete(state);
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE_STYLE = `
  :root { color-scheme: dark }
  body { background:#000; color:#00e676; font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         margin:0; min-height:100vh; display:grid; place-items:center; padding:2rem }
  main { width:min(30rem,100%) }
  h1 { font-size:1.1rem; letter-spacing:.2em; text-transform:uppercase; color:#9ad }
  input { font:inherit; background:#111; color:#00e676; border:1px solid #2a2a2a; padding:.6rem .8rem;
          width:100%; box-sizing:border-box; letter-spacing:.25em; text-transform:uppercase }
  button { font:inherit; background:#111; color:#00e676; border:1px solid #2a2a2a; padding:.6rem 1rem;
           cursor:pointer; width:100%; margin-top:.5rem; text-align:left }
  button:hover { border-color:#00e676 }
  p { color:#9a9a9a } code { color:#00e676 }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - nixamp</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

/**
 * The page the terminal sends somebody to.
 *
 * It is served by the API rather than the app because it has to work before
 * there is a session and without the web build being present -- a nixamp
 * deployed with no web assets can still sign a terminal in.
 */
export function devicePage(signIn: SignIn, code: string, signedInAs: string): string {
  const value = escapeHtml(code);
  const choices = signIn.providers
    .map(
      (provider) =>
        `<button type="submit" name="with" value="${escapeHtml(provider.id)}">Continue with ${escapeHtml(provider.name)}</button>`,
    )
    .join("");
  const approve = signedInAs
    ? `<button type="submit" name="with" value="">Approve as ${escapeHtml(signedInAs)}</button>`
    : "";
  return page(
    "Connect a terminal",
    `<h1>Connect a terminal</h1>
     <p>Your terminal is showing a code. Type it here, then choose how to sign in.</p>
     <form method="POST" action="/api/v1/auth/device">
       <input name="code" value="${value}" placeholder="XXXX-XXXX" autocomplete="off"
              autocapitalize="characters" spellcheck="false" required>
       ${approve}${choices}
     </form>
     ${signIn.providers.length === 0 && !signedInAs ? "<p>Sign in on this site first, then come back to this page.</p>" : ""}`,
  );
}

export function deviceDonePage(email: string): string {
  return page(
    "Terminal connected",
    `<h1>Terminal connected</h1>
     <p>Signed in as <code>${escapeHtml(email)}</code>. Go back to your terminal; you can close this.</p>`,
  );
}

export function signInFailedPage(why: string): string {
  return page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(why)}</p>`);
}

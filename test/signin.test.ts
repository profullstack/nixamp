import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts, type AuthLike } from "../src/accounts.ts";
import { DeviceGrants, makeUserCode, normalizeUserCode, POLL_INTERVAL_SECONDS } from "../src/device.ts";
import {
  authorizeUrl,
  devicePage,
  exchangeCode,
  githubProvider,
  googleProvider,
  Identities,
  providersFrom,
  redirectUri,
  SignIn,
  STATE_TTL_MS,
} from "../src/oauth.ts";
import { BAD_KEY_LIMIT, callerOf, Guard, SIGN_IN_LIMIT } from "../src/guard.ts";
import { createServer, EmptyEngine } from "../src/server.ts";
import { anonymousHandle, cleanHandle, Handles, isReserved } from "../src/handles.ts";
import { nameOfDir } from "../src/opendirs.ts";
import { cleanName, cleanUrl, Servers } from "../src/servers.ts";
import { hashSecret, mintToken, splitToken, Tokens } from "../src/tokens.ts";
import {
  askWays,
  chooseWay,
  deviceLogin,
  login,
  parseLoginArgs,
  readSession,
  type LoginOptions,
} from "../src/session.ts";

/**
 * Enough Postgres to run the two tables in this feature, and no more. It
 * recognises the handful of statements the code actually sends, which is the
 * point: the logic under test is what the rows mean, not what a database does
 * with them.
 */
function fakeDb() {
  const tokens = new Map<string, Record<string, unknown>>();
  const identities = new Map<string, Record<string, unknown>>();
  const handles = new Map<string, string>();
  const servers = new Map<string, Record<string, unknown>>();
  const seen: string[] = [];

  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.trim().replace(/\s+/g, " ");
    seen.push(sql);
    if (sql.startsWith("CREATE TABLE")) return { rows: [] };

    if (sql.startsWith("INSERT INTO nixamp_tokens")) {
      const [id, user_id, email, kind, name, secret_hash, created_at, expires_at] = values;
      tokens.set(String(id), {
        id,
        user_id,
        email,
        kind,
        name,
        secret_hash,
        created_at,
        expires_at,
        last_used_at: null,
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id, user_id, email, secret_hash")) {
      const row = tokens.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("UPDATE nixamp_tokens SET last_used_at")) {
      const row = tokens.get(String(values[0]));
      if (row) row["last_used_at"] = values[1];
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id, name, kind, created_at")) {
      const wanted = values[1];
      const rows = [...tokens.values()]
        .filter((row) => row["user_id"] === values[0] && (wanted === undefined || row["kind"] === wanted))
        .sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])));
      return { rows };
    }
    if (sql.startsWith("DELETE FROM nixamp_tokens")) {
      const gone: Record<string, unknown>[] = [];
      for (const [id, row] of tokens) {
        const byId = sql.includes("WHERE user_id = $1 AND id = $2")
          ? row["user_id"] === values[0] && id === String(values[1])
          : sql.includes("kind = 'session'")
            ? id === String(values[0]) && row["kind"] === "session"
            : id === String(values[0]);
        if (byId) {
          gone.push({ id });
          tokens.delete(id);
        }
      }
      return { rows: gone };
    }

    const key = `${String(values[0])}/${String(values[1])}`;
    if (sql.startsWith("SELECT user_id, email FROM nixamp_identities")) {
      const row = identities.get(key);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("UPDATE nixamp_identities")) {
      const row = identities.get(key);
      if (row) row["email"] = values[2];
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO nixamp_identities")) {
      identities.set(key, { provider: values[0], subject: values[1], user_id: values[2], email: values[3] });
      return { rows: [] };
    }
    // --- handles ---
    if (sql.startsWith("SELECT handle FROM nixamp_handles")) {
      const row = handles.get(String(values[0]));
      return { rows: row ? [{ handle: row }] : [] };
    }
    if (sql.startsWith("SELECT user_id FROM nixamp_handles")) {
      for (const [user, handle] of handles) {
        if (handle.toLowerCase() === String(values[0])) return { rows: [{ user_id: user }] };
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT user_id, handle FROM nixamp_handles")) {
      const wanted = new Set((values[0] as string[]) ?? []);
      return {
        rows: [...handles].filter(([user]) => wanted.has(user)).map(([user, handle]) => ({ user_id: user, handle })),
      };
    }
    if (sql.startsWith("INSERT INTO nixamp_handles")) {
      handles.set(String(values[0]), String(values[1]));
      return { rows: [] };
    }

    // --- servers ---
    if (sql.startsWith("SELECT id, name, url, share_key")) {
      return { rows: [...servers.values()].filter((row) => row["user_id"] === values[0]) };
    }
    if (sql.startsWith("INSERT INTO nixamp_servers")) {
      const [id, user_id, name, url, share_key] = values;
      const existing = [...servers.values()].find((r) => r["user_id"] === user_id && r["url"] === url);
      const row = existing ?? { id, user_id, url, created_at: "2026-01-01", updated_at: "2026-01-01", last_seen_at: null };
      row["name"] = name;
      row["share_key"] = share_key;
      servers.set(String(row["id"]), row);
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE nixamp_servers")) {
      const row = servers.get(String(values[1]));
      return { rows: row && row["user_id"] === values[0] ? [row] : [] };
    }
    if (sql.startsWith("DELETE FROM nixamp_servers")) {
      const row = servers.get(String(values[1]));
      if (row && row["user_id"] === values[0]) {
        servers.delete(String(values[1]));
        return { rows: [row] };
      }
      return { rows: [] };
    }

    throw new Error(`unexpected SQL: ${sql}`);
  };

  return { query, tokens, identities, handles, servers, seen };
}

const account = { id: "u1", email: "a@b.com" };

// --- tokens -----------------------------------------------------------------

test("a token carries the id it is looked up by, and nothing that is stored", () => {
  const made = mintToken();
  assert.ok(made.token.startsWith("nxa_"));
  assert.deepEqual(splitToken(made.token), { id: made.id, secret: made.secret });

  // Anything that is not one of ours does not become one by being long.
  assert.equal(splitToken("eyJhbGciOiJIUzI1NiJ9.abc.def"), null);
  assert.equal(splitToken("nxa_"), null);
  assert.equal(splitToken("nxa_notthere"), null);
  assert.equal(splitToken("nxa_zzzz_" + "x".repeat(40)), null, "the id half is hex");
  assert.equal(splitToken("nxa_abcd_short"), null, "a secret that short was never issued");
});

test("a token verifies once, and stops when it is revoked", async () => {
  const db = fakeDb();
  const store = new Tokens(db);
  const issued = await store.issue({ account, kind: "cli", name: "ci", ttlMs: null });

  assert.deepEqual(await store.verify(issued.token), account);
  // The stored half is a hash: the token itself is nowhere in the row.
  const row = [...db.tokens.values()][0] as Record<string, unknown>;
  assert.equal(row["secret_hash"], hashSecret(splitToken(issued.token)?.secret ?? ""));
  assert.ok(!JSON.stringify(row).includes(splitToken(issued.token)?.secret ?? "no"));

  // The same id with somebody else's secret is not the same token.
  const forged = `nxa_${issued.id}_${"a".repeat(43)}`;
  assert.equal(await store.verify(forged), null);

  assert.equal(await store.revoke("someone-else", issued.id), false);
  assert.equal(await store.revoke(account.id, issued.id), true);
  assert.equal(await store.verify(issued.token), null);
});

test("an expired token is refused and tidied away", async () => {
  let now = 1_000_000;
  const db = fakeDb();
  const store = new Tokens(db, () => now);
  const issued = await store.issue({ account, kind: "session", ttlMs: 60_000 });

  assert.deepEqual(await store.verify(issued.token), account);
  now += 60_001;
  assert.equal(await store.verify(issued.token), null);
  assert.equal(db.tokens.size, 0, "it is deleted on the way past, not left to rot");
});

test("signing out ends the session and leaves the CI token alone", async () => {
  const db = fakeDb();
  const store = new Tokens(db);
  const session = await store.issue({ account, kind: "session" });
  const forCi = await store.issue({ account, kind: "cli", name: "ci", ttlMs: null });

  assert.equal(await store.revokeToken(session.token), true);
  assert.equal(await store.verify(session.token), null);
  // The whole reason the two kinds are distinguished.
  assert.equal(await store.revokeToken(forCi.token), false);
  assert.deepEqual(await store.verify(forCi.token), account);

  const listed = await store.list(account.id, "cli");
  assert.deepEqual(
    listed.map((token) => token.name),
    ["ci"],
  );
  assert.equal(listed[0]?.expiresAt, null, "a token for a script does not expire on its own");
});

// --- the device grant -------------------------------------------------------

test("a user code is unambiguous to read out and forgiving to type in", () => {
  const code = makeUserCode((size) => new Uint8Array(size).fill(3));
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.doesNotMatch(code, /[AEIOU01]/, "no vowels to spell with, no glyphs to confuse");

  assert.equal(normalizeUserCode("wxyz4rtb"), "WXYZ-4RTB");
  assert.equal(normalizeUserCode(" wxyz-4rtb "), "WXYZ-4RTB");
  assert.equal(normalizeUserCode("wxyz"), "");
  assert.equal(normalizeUserCode(42), "");
});

test("a terminal waits, is approved once, and cannot be approved twice", () => {
  let now = 0;
  const grants = new DeviceGrants({ now: () => now });
  const grant = grants.start();

  assert.deepEqual(grants.poll(grant.deviceCode), { status: "pending" });
  // Asking again straight away is answered with slow_down, per RFC 8628.
  assert.deepEqual(grants.poll(grant.deviceCode), { status: "slow_down" });

  now += POLL_INTERVAL_SECONDS * 1000;
  assert.equal(grants.approve(grant.userCode, { token: "nxa_x", email: "a@b.com" }), true);
  assert.deepEqual(grants.poll(grant.deviceCode), { status: "ok", token: "nxa_x", email: "a@b.com" });

  // Redeemed is gone: a device code is worth one session and no more.
  now += POLL_INTERVAL_SECONDS * 1000;
  assert.deepEqual(grants.poll(grant.deviceCode), { status: "expired" });
  assert.equal(grants.approve(grant.userCode, { token: "nxa_y", email: "a@b.com" }), false);
  assert.equal(grants.size, 0);
});

test("a code nobody approved expires, and a refused one says so", () => {
  let now = 0;
  const grants = new DeviceGrants({ now: () => now });
  const waiting = grants.start();
  now += 600_001;
  assert.deepEqual(grants.poll(waiting.deviceCode), { status: "expired" });
  assert.equal(grants.find(waiting.userCode), null);

  const refused = grants.start();
  assert.equal(grants.deny(refused.userCode), true);
  assert.deepEqual(grants.poll(refused.deviceCode), { status: "denied" });
});

// --- providers --------------------------------------------------------------

test("only providers with both halves configured are offered", () => {
  assert.deepEqual(providersFrom({}), []);
  assert.deepEqual(providersFrom({ GITHUB_CLIENT_ID: "id" }), [], "half of a provider is not one");
  const both = providersFrom({
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
  });
  assert.deepEqual(
    both.map((provider) => provider.id),
    ["github", "google"],
  );
});

test("the callback is the house shape, and the authorize URL carries the state", () => {
  const provider = githubProvider("id", "secret");
  assert.equal(
    redirectUri("https://nixamp.com/", provider),
    "https://nixamp.com/api/v1/github/oauth/callback",
  );
  const url = new URL(authorizeUrl(provider, "https://nixamp.com", "st4te"));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "id");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("redirect_uri"), "https://nixamp.com/api/v1/github/oauth/callback");
});

test("GitHub is asked for a verified address, not whichever one is public", async () => {
  const provider = githubProvider("id", "secret");
  const send = (async (where: string) => {
    if (String(where).endsWith("/user")) return Response.json({ id: 42, email: "public@b.com" });
    return Response.json([
      { email: "unverified@b.com", primary: true, verified: false },
      { email: "real@b.com", primary: false, verified: true },
    ]);
  }) as unknown as typeof fetch;

  // The primary address is unverified, so it is not the one used.
  assert.deepEqual(await provider.identify("t", send), {
    provider: "github",
    subject: "42",
    email: "real@b.com",
  });

  const nothingVerified = (async (where: string) =>
    String(where).endsWith("/user")
      ? Response.json({ id: 42 })
      : Response.json([{ email: "x@b.com", primary: true, verified: false }])) as unknown as typeof fetch;
  assert.equal(await provider.identify("t", nothingVerified), null);
});

test("Google without email_verified is not an identity", async () => {
  const provider = googleProvider("id", "secret");
  const verified = (async () =>
    Response.json({ sub: "9", email: "A@B.com", email_verified: true })) as unknown as typeof fetch;
  assert.deepEqual(await provider.identify("t", verified), {
    provider: "google",
    subject: "9",
    email: "a@b.com",
  });

  const not = (async () =>
    Response.json({ sub: "9", email: "a@b.com", email_verified: false })) as unknown as typeof fetch;
  assert.equal(await provider.identify("t", not), null);
});

test("the code exchange asks for JSON, which is what GitHub needs to answer with", async () => {
  let asked: { url: string; headers: Record<string, string>; body: string } | null = null;
  const send = (async (url: string, init: RequestInit) => {
    asked = {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    };
    return Response.json({ access_token: "gho_1" });
  }) as unknown as typeof fetch;

  const provider = githubProvider("id", "secret");
  assert.equal(await exchangeCode(provider, "c0de", "https://nixamp.com", send), "gho_1");
  assert.equal(asked?.headers["accept"], "application/json");
  assert.match(asked?.body ?? "", /client_secret=secret/);
  assert.match(asked?.body ?? "", /code=c0de/);

  const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  assert.equal(await exchangeCode(provider, "c0de", "https://nixamp.com", refused), "");
});

// --- linking ----------------------------------------------------------------

test("an identity finds the account that already has the address, then itself", async () => {
  const db = fakeDb();
  const made: Record<string, unknown>[] = [];
  const users = {
    async getUserByEmail(email: string) {
      return email === "known@b.com" ? { id: "existing", email } : null;
    },
    async createUser(user: Record<string, unknown>) {
      made.push(user);
      return { id: `new-${made.length}`, email: String(user["email"]) };
    },
  };
  const identities = new Identities(db, users as never);

  // An address that already has a password account becomes the same account,
  // not a second one.
  assert.deepEqual(await identities.resolve({ provider: "github", subject: "7", email: "known@b.com" }), {
    id: "existing",
    email: "known@b.com",
  });
  assert.equal(made.length, 0);

  // A new address creates an account with no password at all.
  assert.deepEqual(await identities.resolve({ provider: "github", subject: "8", email: "new@b.com" }), {
    id: "new-1",
    email: "new@b.com",
  });
  assert.equal(made[0]?.["password"], null);
  assert.equal(made[0]?.["emailVerified"], true);

  // Coming back is matched on the subject, so changing the address at GitHub
  // does not make a second account.
  assert.deepEqual(await identities.resolve({ provider: "github", subject: "8", email: "moved@b.com" }), {
    id: "new-1",
    email: "moved@b.com",
  });
  assert.equal(made.length, 1);
});

// --- states -----------------------------------------------------------------

test("a state is good once, and not for long", () => {
  let now = 0;
  const provider = githubProvider("id", "secret");
  const signIn = new SignIn([provider], new DeviceGrants({ now: () => now }), "https://nixamp.com", () => now);

  const state = new URL(signIn.begin(provider, "WXYZ-4RTB")).searchParams.get("state") ?? "";
  assert.notEqual(state, "");
  assert.deepEqual(signIn.claim(state), { provider: "github", userCode: "WXYZ-4RTB", createdAt: 0 });
  assert.equal(signIn.claim(state), null, "a replayed callback finds nothing");
  assert.equal(signIn.claim(""), null);

  const stale = new URL(signIn.begin(provider)).searchParams.get("state") ?? "";
  now += STATE_TTL_MS + 1;
  assert.equal(signIn.claim(stale), null);
});

test("the approval page offers what is configured, and escapes what was typed", () => {
  const signIn = new SignIn([githubProvider("id", "secret")], new DeviceGrants(), "https://nixamp.com");
  const page = devicePage(signIn, `"><script>alert(1)</script>`, "a@b.com");
  assert.match(page, /Continue with GitHub/);
  assert.match(page, /Approve as a@b\.com/);
  assert.doesNotMatch(page, /<script>alert/, "the code field is not a way to write HTML");

  // Nobody signed in and no providers is a page that says so rather than an
  // empty form.
  const bare = devicePage(new SignIn([], new DeviceGrants(), "https://nixamp.com"), "", "");
  assert.match(bare, /Sign in on this site first/);
});

// --- accounts, over the top of all of it ------------------------------------

function fakeAuth(): AuthLike {
  return {
    register: async () => ({ user: account, tokens: { accessToken: "jwt" } }),
    login: async () => ({ user: account, tokens: { accessToken: "jwt" } }),
    validateToken: async (token: string) => (token === "jwt" ? { userId: "u1", email: "a@b.com" } : null),
  };
}

test("both kinds of token answer whoIs, by different routes", async () => {
  const db = fakeDb();
  const accounts = new Accounts({
    connectionString: "",
    secret: "",
    system: fakeAuth(),
    adapter: { ...db, getUserByEmail: async () => null, createUser: async () => ({ id: "n", email: "" }) },
  });

  // A JWT still validates through the module.
  assert.deepEqual(await accounts.whoIs("jwt"), account);
  assert.equal(await accounts.whoIs("nonsense"), null);
  assert.equal(await accounts.whoIs(""), null);

  // A session issued here validates by lookup, and ends when it is ended.
  const token = await accounts.sessionFor(account);
  assert.ok(token.startsWith("nxa_"));
  assert.deepEqual(await accounts.whoIs(token), account);
  await accounts.endSession(token);
  assert.equal(await accounts.whoIs(token), null);
});

test("signing in with a provider mints a session, and refuses an unverified one", async () => {
  const db = fakeDb();
  const accounts = new Accounts({
    connectionString: "",
    secret: "",
    system: fakeAuth(),
    adapter: {
      ...db,
      getUserByEmail: async () => null,
      createUser: async (user: { email: string }) => ({ id: "made", email: user.email }),
    },
  });

  const result = await accounts.signInWith({ provider: "github", subject: "1", email: "a@b.com" });
  assert.equal(result.ok, true);
  assert.equal(result.account?.id, "made");
  assert.deepEqual(await accounts.whoIs(result.token), { id: "made", email: "a@b.com" });

  // No address means the provider stood behind nothing.
  const nothing = await accounts.signInWith({ provider: "github", subject: "1", email: "" });
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /verified email/);
});

// --- over HTTP, through the real routes --------------------------------------

/** The sign-in half of a nixamp.com, on a port, with nothing real behind it. */
async function withSignIn(
  body: (base: string, parts: { accounts: Accounts; signIn: SignIn; tick: (ms: number) => void }) => Promise<void>,
  intervalSeconds = POLL_INTERVAL_SECONDS,
  system: AuthLike = fakeAuth(),
): Promise<void> {
  // The grants keep their own clock so a test can step past the interval the
  // server tells a terminal to wait, rather than waiting it out.
  let now = Date.now();
  const db = fakeDb();
  const accounts = new Accounts({
    connectionString: "",
    secret: "",
    system,
    adapter: {
      ...db,
      getUserByEmail: async () => null,
      createUser: async (user: { email: string }) => ({ id: "made", email: user.email }),
    },
  });
  const signIn = new SignIn(
    [githubProvider("id", "secret")],
    new DeviceGrants({ now: () => now, intervalSeconds }),
    "https://nixamp.com",
  );
  const server = createServer(new EmptyEngine("nothing here"), {
    web: null,
    media: true,
    version: "test",
    accounts,
    signIn,
    // Wired exactly as serve() wires them, because the point of this harness
    // is the route and a route with nothing behind it answers 404 for the
    // wrong reason.
    handles: new Handles(db),
    servers: new Servers(db),
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`, {
      accounts,
      signIn,
      tick: (ms) => {
        now += ms;
      },
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("the site says which ways in it has", async () => {
  await withSignIn(async (base) => {
    const answer = await fetch(`${base}/api/v1/auth/providers`);
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), {
      password: true,
      device: true,
      providers: [{ id: "github", name: "GitHub" }],
    });
  });
});

test("a terminal is given a code, waits, and is signed in when it is approved", async () => {
  await withSignIn(async (base, { accounts, signIn, tick }) => {
    const started = await (await fetch(`${base}/api/v1/auth/device/code`, { method: "POST", body: "{}" })).json();
    assert.match(started.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(started.verification_uri, "https://nixamp.com/api/v1/auth/device");
    assert.equal(started.interval, POLL_INTERVAL_SECONDS);

    const poll = async () =>
      fetch(`${base}/api/v1/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: started.device_code }),
      });

    const pending = await poll();
    assert.equal(pending.status, 400);
    assert.equal((await pending.json()).error, "authorization_pending");

    // Asking again straight away is told to wait, not answered.
    assert.equal((await (await poll()).json()).error, "slow_down");
    tick(POLL_INTERVAL_SECONDS * 1000);

    // The browser half, as the page's form does it.
    const account = { id: "u1", email: "a@b.com" };
    signIn.device.approve(started.user_code, {
      token: await accounts.sessionFor(account),
      email: account.email,
    });

    const done = await poll();
    assert.equal(done.status, 200);
    const session = await done.json();
    assert.equal(session.email, "a@b.com");

    // And the token it was given is one the site accepts.
    const me = await fetch(`${base}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.deepEqual(await me.json(), { account });

    // A device code is spent once.
    tick(POLL_INTERVAL_SECONDS * 1000);
    assert.equal((await (await poll()).json()).error, "expired_token");
  });
});

test("an unknown device code is expired rather than described", async () => {
  await withSignIn(async (base) => {
    const answer = await fetch(`${base}/api/v1/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "made-up" }),
    });
    assert.equal(answer.status, 400);
    assert.equal((await answer.json()).error, "expired_token");
  });
});

test("the approval page is served without a session, and the form redirects to the provider", async () => {
  await withSignIn(async (base) => {
    const page = await fetch(`${base}/api/v1/auth/device?code=WXYZ-4RTB`);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await page.text(), /Continue with GitHub/);

    const started = await (await fetch(`${base}/api/v1/auth/device/code`, { method: "POST", body: "{}" })).json();
    const sent = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: started.user_code, with: "github" }).toString(),
      redirect: "manual",
    });
    assert.equal(sent.status, 302);
    const to = new URL(sent.headers.get("location") ?? "");
    assert.equal(to.host, "github.com");
    assert.notEqual(to.searchParams.get("state"), null);

    // A code nobody is waiting on is not a redirect to anywhere.
    const stale = await fetch(`${base}/api/v1/auth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "AAAA-BBBB", with: "github" }).toString(),
      redirect: "manual",
    });
    assert.equal(stale.status, 404);
  });
});

test("a callback with a spent state signs nobody in", async () => {
  await withSignIn(async (base) => {
    const answer = await fetch(`${base}/api/v1/github/oauth/callback?code=c&state=never-issued`, {
      redirect: "manual",
    });
    assert.equal(answer.status, 400);
    assert.match(await answer.text(), /expired/);

    // A provider this site does not have is not a route.
    const nobody = await fetch(`${base}/api/v1/gitlab/oauth/start`, { redirect: "manual" });
    assert.equal(nobody.status, 404);
  });
});

test("tokens are made, listed and revoked by their owner and nobody else", async () => {
  await withSignIn(async (base, { accounts }) => {
    const mine = await accounts.sessionFor({ id: "u1", email: "a@b.com" });
    const theirs = await accounts.sessionFor({ id: "u2", email: "c@d.com" });
    const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

    const anonymous = await fetch(`${base}/api/v1/auth/tokens`);
    assert.equal(anonymous.status, 401);

    const made = await fetch(`${base}/api/v1/auth/tokens`, {
      method: "POST",
      headers: as(mine),
      body: JSON.stringify({ name: "ci" }),
    });
    assert.equal(made.status, 201);
    const created = await made.json();
    assert.ok(created.token.startsWith("nxa_"));

    // It works as a way in, which is the entire point of it.
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: as(created.token) });
    assert.equal(me.status, 200);

    const listed = await (await fetch(`${base}/api/v1/auth/tokens`, { headers: as(mine) })).json();
    assert.deepEqual(
      listed.tokens.map((token: { name: string }) => token.name),
      ["ci"],
      "sessions are not listed as tokens somebody made",
    );

    // Somebody else's id is not somebody else's token.
    const notYours = await fetch(`${base}/api/v1/auth/tokens/${created.id}`, {
      method: "DELETE",
      headers: as(theirs),
    });
    assert.equal(notYours.status, 404);
    assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: as(created.token) })).status, 200);

    const revoked = await fetch(`${base}/api/v1/auth/tokens/${created.id}`, {
      method: "DELETE",
      headers: as(mine),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: as(created.token) })).status, 401);
  });
});

test("signing out ends the session it was asked with", async () => {
  await withSignIn(async (base, { accounts }) => {
    const token = await accounts.sessionFor({ id: "u1", email: "a@b.com" });
    const out = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /nixamp_session=; /);
    assert.equal((await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  });
});

// --- the CLI ----------------------------------------------------------------

test("login flags parse, including the ones people type instead", () => {
  assert.equal(parseLoginArgs(["--with", "github"]).with, "github");
  assert.equal(parseLoginArgs(["--provider", "google"]).with, "google");
  assert.equal(parseLoginArgs(["--github"]).with, "github");
  assert.equal(parseLoginArgs(["--token", "nxa_1_x"]).token, "nxa_1_x");
  assert.equal(parseLoginArgs(["--password"]).password, true);
  assert.equal(parseLoginArgs(["--device"]).device, true);
  assert.equal(parseLoginArgs(["--no-browser"]).noBrowser, true);
  assert.equal(parseLoginArgs([]).with, "");
  // What it always did, unchanged.
  assert.equal(parseLoginArgs(["a@b.com"]).email, "a@b.com");
  assert.equal(parseLoginArgs(["--site", "http://localhost:8000/"]).site, "http://localhost:8000");
});

test("an older nixamp with no providers endpoint still means email and password", async () => {
  const missing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  assert.deepEqual(await askWays("https://old.example", missing), {
    password: true,
    device: false,
    providers: [],
  });

  const offline = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal((await askWays("https://old.example", offline)).device, false);
});

test("what is chosen when nobody is there to choose", async () => {
  const bare: LoginOptions = {
    site: "https://nixamp.com",
    email: "",
    signUp: false,
    with: "",
    device: false,
    password: false,
    token: "",
    noBrowser: false,
  };
  const ways = { password: true, device: true, providers: [{ id: "github", name: "GitHub" }] };

  // A named provider that the site does not have is a refusal, not a fallback
  // into a password prompt nobody asked for.
  assert.equal(await chooseWay(ways, { ...bare, with: "gitlab" }), null);
  assert.equal(await chooseWay(ways, { ...bare, with: "github" }), "github");
  // Naming an address is asking for the password flow.
  assert.equal(await chooseWay(ways, { ...bare, email: "a@b.com" }), "password");
  // A site with the device grant but no providers has nothing to offer, so a
  // bare `nixamp login` asks for a password rather than a menu of one thing.
  assert.equal(await chooseWay({ ...ways, providers: [] }, bare), "password");
  // Asking for the browser anyway is allowed: it is how somebody whose browser
  // is already signed in approves without naming a provider.
  assert.equal(await chooseWay({ ...ways, providers: [] }, { ...bare, device: true }), "device");
  assert.equal(await chooseWay({ ...ways, device: false }, { ...bare, device: true }), null);
});

test("the device flow waits, obeys slow_down, and comes back with a session", async () => {
  const said: string[] = [];
  const waits: number[] = [];
  let opened = "";
  let polls = 0;

  const send = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/device/code")) {
      return Response.json({
        device_code: "dev1",
        user_code: "WXYZ-4RTB",
        verification_uri: "https://nixamp.com/api/v1/auth/device",
        verification_uri_complete: "https://nixamp.com/api/v1/auth/device?code=WXYZ-4RTB",
        expires_in: 600,
        interval: 5,
      });
    }
    assert.equal(JSON.parse(String(init?.body)).device_code, "dev1");
    polls += 1;
    if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
    if (polls === 2) return Response.json({ error: "slow_down" }, { status: 400 });
    return Response.json({ token: "nxa_1_secret", email: "a@b.com" });
  }) as unknown as typeof fetch;

  const got = await deviceLogin("https://nixamp.com", "github", send, {
    say: (line) => said.push(line),
    wait: async (ms) => void waits.push(ms),
    open: (url) => (opened = url),
  });

  assert.deepEqual(got, { token: "nxa_1_secret", email: "a@b.com" });
  // A named provider skips the picker: the browser only has to approve.
  assert.equal(opened, "https://nixamp.com/api/v1/github/oauth/start?device=WXYZ-4RTB");
  assert.ok(said.some((line) => line.includes("WXYZ-4RTB")), "the code is always printed");
  // 5s, 5s, then backed off after slow_down.
  assert.deepEqual(waits, [5000, 5000, 10000]);
});

test("a refused approval is not waited out", async () => {
  const send = (async (url: string) =>
    String(url).endsWith("/device/code")
      ? Response.json({ device_code: "d", user_code: "WXYZ-4RTB", interval: 1 })
      : Response.json({ error: "access_denied" }, { status: 400 })) as unknown as typeof fetch;

  const got = await deviceLogin("https://nixamp.com", "", send, {
    say: () => {},
    wait: async () => {},
    open: () => {},
  });
  assert.equal(got, "that sign-in was refused");
});

test("`nixamp login --with github` ends with a session on disk", async () => {
  const home = mkdtempSync(join(tmpdir(), "nixamp-login-"));
  const before = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = home;
  try {
    await withSignIn(async (base, { accounts, signIn }) => {
      // The terminal side, running for real: it asks what the site offers,
      // starts a device grant, and polls until the browser half happens.
      const running = login(["--site", base, "--with", "github", "--no-browser"], fetch);

      // The browser half, which in life is somebody pressing a button.
      const account = { id: "u1", email: "a@b.com" };
      for (let tries = 0; tries < 100; tries += 1) {
        await new Promise((done) => setTimeout(done, 20));
        const waiting = signIn.device.pending()[0];
        if (waiting === undefined) continue;
        signIn.device.approve(waiting.userCode, {
          token: await accounts.sessionFor(account),
          email: account.email,
        });
        break;
      }

      assert.equal(await running, 0);
      const written = JSON.parse(readFileSync(join(home, "nixamp", "session.json"), "utf8")) as {
        site: string;
        email: string;
        token: string;
      };
      assert.equal(written.site, base);
      assert.equal(written.email, "a@b.com");
      assert.ok(written.token.startsWith("nxa_"));

      // And it is a session the site accepts, which is the whole errand.
      const me = await fetch(`${base}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${written.token}` },
      });
      assert.deepEqual(await me.json(), { account });
    }, 1);
  } finally {
    if (before === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = before;
    rmSync(home, { recursive: true, force: true });
  }
});

test("NIXAMP_TOKEN is a signed-in nixamp with no login at all", () => {
  const session = readSession({ NIXAMP_TOKEN: "nxa_1_x", NIXAMP_SITE: "https://nixamp.com/" });
  assert.equal(session?.token, "nxa_1_x");
  assert.equal(session?.site, "https://nixamp.com");
  // No site named still means the one everybody means.
  assert.equal(readSession({ NIXAMP_TOKEN: "nxa_1_x" })?.site, "https://nixamp.com");
});

// --- saying no to somebody asking too often ---------------------------------

test("a window allows what it allows, then refuses until it rolls", () => {
  let now = 0;
  const guard = new Guard(() => now);
  const limit = { allowed: 3, windowMs: 1000 };

  assert.deepEqual(guard.check("a", limit), { ok: true, left: 2, retryAfter: 1 });
  assert.equal(guard.check("a", limit).ok, true);
  assert.equal(guard.check("a", limit).ok, true);
  const refused = guard.check("a", limit);
  assert.equal(refused.ok, false);
  assert.equal(refused.left, 0);
  assert.ok(refused.retryAfter >= 1, "and says how long to wait");

  // One caller's window is not another's.
  assert.equal(guard.check("b", limit).ok, true);

  now += 1001;
  assert.equal(guard.check("a", limit).ok, true, "the window rolled");
});

test("getting it right costs nothing", () => {
  let now = 0;
  const guard = new Guard(() => now);
  const limit = { allowed: 2, windowMs: 1000 };
  guard.check("a", limit);
  guard.check("a", limit);
  // A success wipes the slate, so ordinary use never approaches a limit.
  guard.forget("a");
  assert.equal(guard.check("a", limit).ok, true);
  assert.equal(guard.check("a", limit).ok, true);
});

test("a forwarded address is believed only where there is a proxy", () => {
  const headers = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
  // Behind a proxy the socket is the proxy, and the leftmost entry is who asked.
  assert.equal(callerOf(headers, "10.0.0.1", true), "203.0.113.9");
  // Directly reachable, the header is whatever the caller felt like sending,
  // and believing it would hand them a fresh identity per request.
  assert.equal(callerOf(headers, "198.51.100.4", false), "198.51.100.4");
  assert.equal(callerOf({}, undefined, true), "unknown");
});

test("the limits are the ones the endpoints need", () => {
  // Far more than a person mistypes, far less than a word list needs.
  assert.equal(SIGN_IN_LIMIT.allowed, 10);
  assert.equal(SIGN_IN_LIMIT.windowMs, 15 * 60_000);
  assert.ok(BAD_KEY_LIMIT.allowed > SIGN_IN_LIMIT.allowed, "a stale link retries by itself");
});

test("a password cannot be guessed at leisure", async () => {
  // The real module throws on a wrong password; the stub used everywhere else
  // says yes to everything, which would make this test pass for no reason.
  const refusing: AuthLike = {
    register: async () => ({}),
    login: async () => {
      throw new Error("Invalid email or password");
    },
    validateToken: async () => null,
  };
  await withSignIn(async (base) => {
    const attempt = (password: string) =>
      fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password }),
      });

    // The module refuses each of these; the point is what happens after ten.
    for (let tries = 0; tries < 10; tries += 1) {
      const answer = await attempt(`wrong-guess-${tries}`);
      assert.equal(answer.status, 401, `attempt ${tries} should be a plain refusal`);
    }

    const stopped = await attempt("wrong-guess-11");
    assert.equal(stopped.status, 429);
    assert.ok(Number(stopped.headers.get("retry-after")) > 0, "and says how long to wait");
    assert.match((await stopped.json()).error, /too many attempts/);
  }, POLL_INTERVAL_SECONDS, refusing);
});

// --- the servers an account runs --------------------------------------------

test("a stored address is one a browser can open, and nothing else", () => {
  assert.equal(cleanUrl("http://104.152.209.195:4321"), "http://104.152.209.195:4321");
  assert.equal(cleanUrl("https://nixamp.example.com/"), "https://nixamp.example.com");
  // Anything after the origin is dropped: a nixamp is a host and a port.
  assert.equal(cleanUrl("http://box.local:4321/s/KEY?x=1"), "http://box.local:4321");

  // These end up in somebody else's href, so only the two schemes that mean
  // "a server" get through.
  assert.equal(cleanUrl("javascript:alert(1)"), "");
  assert.equal(cleanUrl("data:text/html,<script>"), "");
  assert.equal(cleanUrl("file:///etc/passwd"), "");
  assert.equal(cleanUrl("not a url"), "");
  assert.equal(cleanUrl(""), "");
  assert.equal(cleanUrl(42), "");
});

test("a server without a name still has one", () => {
  assert.equal(cleanName("  Living room  ", "http://x:1"), "Living room");
  // The host beats "untitled", and is what somebody would have typed anyway.
  // With the port, so two nixamps on one machine are not both called "box".
  assert.equal(cleanName("", "http://box.local:4321"), "box.local:4321");
  assert.equal(cleanName(undefined, "http://104.152.209.195:4321"), "104.152.209.195:4321");
  assert.equal(cleanName("", "not a url"), "a nixamp");
  assert.equal(cleanName("x".repeat(200), "http://x:1").length, 60);
});

test("the server list is the account's, and nobody else's", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    async query(text: string, values: unknown[] = []) {
      const sql = text.trim().replace(/\s+/g, " ");
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("INSERT INTO nixamp_servers")) {
        const [id, user_id, name, url, share_key] = values;
        // The upsert is on (user_id, url), which is what a daemon announcing
        // itself twice depends on.
        const existing = [...rows.values()].find((r) => r["user_id"] === user_id && r["url"] === url);
        const row = existing ?? { id, user_id, url, created_at: "2026-01-01", updated_at: "2026-01-01" };
        row["name"] = name;
        row["share_key"] = share_key;
        rows.set(String(row["id"]), row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT id, name, url, share_key")) {
        return { rows: [...rows.values()].filter((r) => r["user_id"] === values[0]) };
      }
      if (sql.startsWith("DELETE FROM nixamp_servers")) {
        const gone: Record<string, unknown>[] = [];
        for (const [id, row] of rows) {
          if (row["user_id"] === values[0] && id === String(values[1])) {
            gone.push(row);
            rows.delete(id);
          }
        }
        return { rows: gone };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const servers = new Servers(db);
  const mine = { id: "u1", email: "a@b.com" };
  const added = await servers.add(mine, { url: "http://box.local:4321", name: "Living room", key: "K" });
  assert.equal(added?.name, "Living room");
  assert.equal(added?.url, "http://box.local:4321");

  // Adding the same address again moves the entry forward rather than failing,
  // because that is what a daemon does after a restart.
  const again = await servers.add(mine, { url: "http://box.local:4321/", name: "Kitchen" });
  assert.equal(again?.id, added?.id);
  assert.equal((await servers.list("u1")).length, 1);
  assert.equal((await servers.list("u1"))[0]?.name, "Kitchen");

  // An address that is not one is refused rather than stored.
  assert.equal(await servers.add(mine, { url: "javascript:alert(1)" }), null);

  // Somebody else's list is empty, and their id deletes nothing of ours.
  assert.deepEqual(await servers.list("u2"), []);
  assert.equal(await servers.remove("u2", added?.id ?? ""), false);
  assert.equal(await servers.remove("u1", added?.id ?? ""), true);
  assert.deepEqual(await servers.list("u1"), []);
});

// --- the name other people see ----------------------------------------------

test("a handle is what a URL, a subdomain and a text message all tolerate", () => {
  assert.equal(cleanHandle("chovy"), "chovy");
  assert.equal(cleanHandle("  Chovy  "), "chovy", "case and space are not part of a name");
  assert.equal(cleanHandle("bad-religion-82"), "bad-religion-82");

  assert.equal(cleanHandle("a"), "", "one character is not a name");
  assert.equal(cleanHandle("-chovy"), "", "a label cannot start with a hyphen");
  assert.equal(cleanHandle("chovy-"), "");
  assert.equal(cleanHandle("ch ovy"), "");
  assert.equal(cleanHandle("chovy@home"), "");
  // Doubled hyphens are how punycode marks an encoded label, so one here can
  // collide with an internationalised domain.
  assert.equal(cleanHandle("xn--foo"), "");
  assert.equal(cleanHandle("x".repeat(31)), "");

  // A subdomain carrying one of these would impersonate the service.
  assert.equal(isReserved("www"), true);
  assert.equal(isReserved("admin"), true);
  assert.equal(isReserved("chovy"), false);
});

test("a default handle says nothing about the address behind it", () => {
  const made = anonymousHandle((size) => new Uint8Array(size).fill(0xab));
  assert.equal(made, "nixamp-abababab");
  // The whole point: anthony@profullstack.com must never become "anthony",
  // and it is a leak nobody notices until it is in a public listing.
  assert.doesNotMatch(made, /anthony|profullstack/);
});

test("a folder is named after the folder, not after the URL", () => {
  assert.equal(
    nameOfDir("https://dev.profullstack.com/~anthony/done/BAD%20RELIGION/%5B1982%5D%20How%20Could%20Hell%20Be%20Any%20Worse/"),
    "[1982] How Could Hell Be Any Worse",
  );
  assert.equal(nameOfDir("http://box.example:19499/"), "box.example:19499");
  assert.equal(nameOfDir("not a url"), "an open directory");
});

test("the account's own routes are reachable, which they were not", async () => {
  // They were nested inside the `/api/v1/auth/` block, so every one of them
  // 404ed from the moment it shipped. The stores had tests; the routes had
  // none, and a store nobody can reach is not a feature.
  await withSignIn(async (base, { accounts }) => {
    const token = await accounts.sessionFor({ id: "u1", email: "a@b.com" });
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const handle = await fetch(`${base}/api/v1/me/handle`, { headers: auth });
    assert.equal(handle.status, 200, "GET /api/v1/me/handle");

    const claimed = await fetch(`${base}/api/v1/me/handle`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ handle: "chovy" }),
    });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).handle, "chovy");

    const list = await fetch(`${base}/api/v1/servers`, { headers: auth });
    assert.equal(list.status, 200, "GET /api/v1/servers");

    const added = await fetch(`${base}/api/v1/servers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: "http://box.local:4321", name: "Living room" }),
    });
    assert.equal(added.status, 201);

    // Signed out they are refused rather than missing, which is a different
    // thing to tell a caller.
    assert.equal((await fetch(`${base}/api/v1/servers`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/me/handle`)).status, 401);
  });
});

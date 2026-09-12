import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Accounts, type AdapterLike, type AuthLike } from "../src/accounts.ts";
import type { Queryable } from "../src/follows.ts";
import { LiveEvents } from "../src/live-events.ts";
import {
  AuthorizationServer,
  BITTORRENTED_CLIENT,
  challengeFor,
  clientsFrom,
  redirectAllowed,
  SCOPE_NAMES,
  verifierMatches,
} from "../src/oauth-server.ts";
import { createServer, EmptyEngine } from "../src/server.ts";
import { cleanPartyCode, cleanPartyUrl, WatchParties } from "../src/watch-party.ts";

/**
 * Enough Postgres for the tables this feature adds, and no more.
 *
 * It recognises the statements the code actually sends, which is the point:
 * what is under test is what the rows mean -- a code that may be spent once,
 * a refresh token that retires when it is used, a party that bridges to one
 * room however many times it is asked -- not what a database does with them.
 */
function fakeDb(): Queryable & { events: Map<string, Record<string, unknown>> } {
  const codes = new Map<string, Record<string, unknown>>();
  const refresh = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();
  const parties = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const now = (): string => new Date().toISOString();

  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.trim().replace(/\s+/g, " ");
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) return { rows: [] };

    // --- nixamp_tokens ----------------------------------------------------
    if (sql.startsWith("INSERT INTO nixamp_tokens")) {
      const [id, user_id, email, kind, name, secret_hash, created_at, expires_at] = values;
      tokens.set(String(id), { id, user_id, email, kind, name, secret_hash, created_at, expires_at, last_used_at: null });
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM nixamp_tokens WHERE id = $1")) {
      const had = tokens.delete(String(values[0]));
      return { rows: had ? [{ id: values[0] }] : [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_tokens WHERE id = $1")) {
      const row = tokens.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("UPDATE nixamp_tokens SET last_used_at")) return { rows: [] };

    // --- nixamp_oauth_codes -----------------------------------------------
    if (sql.startsWith("INSERT INTO nixamp_oauth_codes")) {
      const [code_hash, client_id, user_id, email, redirect_uri, scope, code_challenge, family, created_at, expires_at] = values;
      codes.set(String(code_hash), {
        code_hash, client_id, user_id, email, redirect_uri, scope, code_challenge, family, created_at, expires_at, used_at: null,
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_oauth_codes WHERE code_hash = $1")) {
      const row = codes.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("UPDATE nixamp_oauth_codes SET used_at")) {
      const row = codes.get(String(values[0]));
      if (row) row["used_at"] = now();
      return { rows: [] };
    }

    // --- nixamp_oauth_refresh ---------------------------------------------
    if (sql.startsWith("INSERT INTO nixamp_oauth_refresh")) {
      const [id, secret_hash, client_id, user_id, email, scope, family, access_id, created_at, expires_at] = values;
      refresh.set(String(id), {
        id, secret_hash, client_id, user_id, email, scope, family, access_id, created_at, expires_at,
        rotated_at: null, revoked_at: null,
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_oauth_refresh WHERE id = $1")) {
      const row = refresh.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("UPDATE nixamp_oauth_refresh SET rotated_at")) {
      const row = refresh.get(String(values[0]));
      if (row) row["rotated_at"] = now();
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE nixamp_oauth_refresh SET revoked_at")) {
      const hit: Record<string, unknown>[] = [];
      for (const row of refresh.values()) {
        if (row["family"] === values[0] && row["revoked_at"] === null) {
          row["revoked_at"] = now();
          hit.push({ access_id: row["access_id"] });
        }
      }
      return { rows: hit };
    }
    if (sql.includes("SELECT DISTINCT family FROM nixamp_oauth_refresh")) {
      const families = new Set<string>();
      for (const row of refresh.values()) {
        if (row["user_id"] === values[0] && row["client_id"] === values[1] && row["revoked_at"] === null) {
          families.add(String(row["family"]));
        }
      }
      return { rows: [...families].map((family) => ({ family })) };
    }
    if (sql.includes("FROM nixamp_oauth_refresh WHERE user_id = $1")) {
      return {
        rows: [...refresh.values()].filter(
          (row) => row["user_id"] === values[0] && row["revoked_at"] === null && row["rotated_at"] === null,
        ),
      };
    }

    // --- nixamp_watch_parties ----------------------------------------------
    if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_watch_parties WHERE origin = $1")) {
      const row = [...parties.values()].find((one) => one["origin"] === values[0] && one["party_code"] === values[1]);
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_watch_parties WHERE event_id = $1")) {
      const row = parties.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("INSERT INTO nixamp_watch_parties")) {
      const [event_id, origin, party_code, party_url, media_title] = values;
      if ([...parties.values()].some((one) => one["origin"] === origin && one["party_code"] === party_code)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      const row = {
        event_id, origin, party_code, party_url, media_title,
        position_seconds: 0, playing: false, position_at: now(), created_at: now(), updated_at: now(),
      };
      parties.set(String(event_id), row);
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE nixamp_watch_parties SET party_url")) {
      const row = parties.get(String(values[0]));
      if (!row) return { rows: [] };
      if (values[1]) row["party_url"] = values[1];
      if (values[2]) row["media_title"] = values[2];
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE nixamp_watch_parties SET position_seconds")) {
      const row = parties.get(String(values[0]));
      if (!row) return { rows: [] };
      row["position_seconds"] = values[1];
      row["playing"] = values[2];
      if (values[3]) row["media_title"] = values[3];
      row["position_at"] = values[4];
      return { rows: [row] };
    }
    if (sql.includes("FROM nixamp_watch_parties p")) {
      const rows = [...parties.values()].filter((one) => {
        const event = events.get(String(one["event_id"]));
        return event?.["status"] === "live" && event["visibility"] !== "private";
      });
      return { rows };
    }

    // --- live_events --------------------------------------------------------
    if (sql.startsWith("INSERT INTO live_events")) {
      // Column order follows the INSERT in src/live-events.ts, which grew
      // kind, doors and the ticket fields with the concert work (#125).
      const [id, slug, owner_id, title, description, topic, kind, doors_open_at, ticket_price_cents, ticket_currency, ticket_minutes, pay_to, starts_at, ends_at, timezone, minutes, status, visibility, room_id, chat, hand, recording, layout] = values;
      const row = {
        id, slug, owner_id, title, description, topic, kind, doors_open_at,
        ticket_price_cents, ticket_currency, ticket_minutes, pay_to: pay_to || null,
        starts_at, ends_at, timezone,
        expected_duration_minutes: minutes, status, visibility, room_id,
        chat_enabled: chat, hand_raise_enabled: hand, recording_enabled: recording,
        recording_id: null, layout_id: layout || null, version: 1,
        created_at: now(), updated_at: now(),
        invitee_ids: [], speaker_ids: [], artist_ids: [], moderator_ids: [],
      };
      events.set(String(id), row);
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE live_events SET")) {
      const row = events.get(String(values[0])) ?? [...events.values()].find((one) => one["slug"] === values[0]);
      if (!row || row["owner_id"] !== values[1] || row["version"] !== values[2]) return { rows: [] };
      row["title"] = values[3];
      row["description"] = values[4];
      row["status"] = values[10];
      row["visibility"] = values[11];
      row["version"] = Number(row["version"]) + 1;
      row["updated_at"] = now();
      return { rows: [row] };
    }
    if (sql.startsWith("DELETE FROM live_events")) {
      const row = [...events.values()].find((one) => (one["id"] === values[0] || one["slug"] === values[0]) && one["owner_id"] === values[1]);
      if (row) events.delete(String(row["id"]));
      return { rows: row ? [{ id: row["id"] }] : [] };
    }
    if (sql.includes("FROM live_events e")) {
      if (sql.includes("e.room_id = $1")) {
        const row = [...events.values()].find((one) => one["room_id"] === values[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("e.id = $1 OR e.slug = $1")) {
        const row = [...events.values()].find((one) => one["id"] === values[0] || one["slug"] === values[0]);
        return { rows: row ? [row] : [] };
      }
      return { rows: [...events.values()] };
    }
    if (sql.includes("FROM live_event_invitations")) return { rows: [] };
    return { rows: [] };
  };

  return { query, events };
}

/** Accounts backed by the fake, so the tokens it issues are real `nxa_` ones. */
function fakeAccounts(db: Queryable): Accounts {
  const users = new Map<string, { id: string; email: string }>([["host@example.com", { id: "host-1", email: "host@example.com" }]]);
  const adapter: AdapterLike = {
    query: db.query.bind(db),
    async getUserByEmail(email) {
      return users.get(email) ?? null;
    },
    async createUser(user) {
      const made = { id: `user-${users.size + 1}`, email: user.email };
      users.set(user.email, made);
      return made;
    },
  };
  const system: AuthLike = {
    async register() {
      return {};
    },
    async login() {
      return {};
    },
    async validateToken() {
      return null;
    },
  };
  return new Accounts({ connectionString: "", secret: "s", adapter, system });
}

interface Harness {
  base: string;
  db: ReturnType<typeof fakeDb>;
  accounts: Accounts;
  server: AuthorizationServer;
  parties: WatchParties;
  /** A session token for host-1, the way a browser would carry one. */
  session: string;
}

async function withServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const db = fakeDb();
  const accounts = fakeAccounts(db);
  const authServer = new AuthorizationServer({
    db,
    tokens: accounts.tokens!,
    clients: clientsFrom({}),
    issuer: "https://nixamp.test",
  });
  const events = new LiveEvents(db);
  const parties = new WatchParties({
    db,
    events,
    site: "https://nixamp.test",
    hostsFor: () => ["bittorrented.com"],
  });
  const http = createServer(new EmptyEngine(), {
    web: null,
    media: true,
    version: "test",
    load: async () => [],
    accounts,
    authServer,
    parties,
    events,
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const { port } = http.address() as AddressInfo;
  const session = await accounts.sessionFor({ id: "host-1", email: "host@example.com" });
  try {
    await run({ base: `http://127.0.0.1:${port}`, db, accounts, server: authServer, parties, session });
  } finally {
    await new Promise<void>((done) => http.close(() => done()));
  }
}

/** The whole browser half of an authorization code flow, without a browser. */
async function authorize(
  harness: Harness,
  options: { scope?: string; verifier?: string; redirectUri?: string; decision?: string } = {},
): Promise<{ location: string; verifier: string }> {
  const verifier = options.verifier ?? randomBytes(32).toString("base64url");
  const form = new URLSearchParams({
    response_type: "code",
    client_id: BITTORRENTED_CLIENT.id,
    redirect_uri: options.redirectUri ?? BITTORRENTED_CLIENT.redirectUris[0]!,
    scope: options.scope ?? "profile parties offline_access",
    state: "xyz",
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    decision: options.decision ?? "allow",
  });
  const answer = await fetch(`${harness.base}/api/v1/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${harness.session}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { location: answer.headers.get("location") ?? "", verifier };
}

async function exchange(harness: Harness, code: string, verifier: string): Promise<Record<string, string>> {
  const answer = await fetch(`${harness.base}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: BITTORRENTED_CLIENT.id,
      redirect_uri: BITTORRENTED_CLIENT.redirectUris[0]!,
      code,
      code_verifier: verifier,
    }).toString(),
  });
  return (await answer.json()) as Record<string, string>;
}

// --- the pieces, without a server ---------------------------------------------

test("a redirect URI matches exactly, and only a loopback port may vary", () => {
  const client = { id: "x", name: "X", redirectUris: ["https://bittorrented.com/api/v1/nixamp/oauth/callback", "http://127.0.0.1/cb"] };
  assert.ok(redirectAllowed(client, "https://bittorrented.com/api/v1/nixamp/oauth/callback"));
  // Not a prefix match, not a subdomain, not a different path.
  assert.equal(redirectAllowed(client, "https://bittorrented.com/api/v1/nixamp/oauth/callback/evil"), false);
  assert.equal(redirectAllowed(client, "https://evil.bittorrented.com/api/v1/nixamp/oauth/callback"), false);
  assert.equal(redirectAllowed(client, "https://bittorrented.com.evil.test/api/v1/nixamp/oauth/callback"), false);
  // A CLI cannot know its port before it listens, so the port alone may vary.
  assert.ok(redirectAllowed(client, "http://127.0.0.1:53219/cb"));
  assert.equal(redirectAllowed(client, "http://127.0.0.1:53219/other"), false);
});

test("PKCE accepts only a well-formed verifier that hashes to the challenge", () => {
  const verifier = randomBytes(32).toString("base64url");
  assert.ok(verifierMatches(verifier, challengeFor(verifier)));
  assert.equal(verifierMatches(`${verifier}x`, challengeFor(verifier)), false);
  // Too short to be a verifier at all, however it hashes.
  assert.equal(verifierMatches("short", challengeFor("short")), false);
  assert.equal(verifierMatches(undefined, challengeFor(verifier)), false);
});

test("bittorrented.com is registered out of the box, and the env may add more", () => {
  assert.ok(clientsFrom({}).some((client) => client.id === "bittorrented"));
  const extra = clientsFrom({
    NIXAMP_OAUTH_CLIENTS: JSON.stringify([{ id: "other", name: "Other", redirectUris: ["https://other.test/cb"] }]),
  });
  assert.deepEqual(extra.map((client) => client.id).sort(), ["bittorrented", "other"]);
  // An entry with no redirect URI is not a client; it is a mistake.
  assert.equal(clientsFrom({ NIXAMP_OAUTH_CLIENTS: '[{"id":"bad"}]' }).length, 1);
});

test("a party code is rubbed of the spacing people type, and a watch link must be the client's own site", () => {
  assert.equal(cleanPartyCode("abc 123"), "ABC123");
  assert.equal(cleanPartyCode("ABC-123"), "ABC123");
  assert.throws(() => cleanPartyCode("no!"), /party code/);
  assert.equal(cleanPartyUrl("https://bittorrented.com/watch-party?code=ABC123", ["bittorrented.com"]),
    "https://bittorrented.com/watch-party?code=ABC123");
  assert.throws(() => cleanPartyUrl("https://evil.test/watch", ["bittorrented.com"]), /not on this client/);
  assert.throws(() => cleanPartyUrl("http://bittorrented.com/watch", ["bittorrented.com"]), /https/);
});

// --- the flow, over HTTP -------------------------------------------------------

test("the metadata document says what the server is and where", async () => {
  await withServer(async (harness) => {
    const answer = await fetch(`${harness.base}/.well-known/oauth-authorization-server`);
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as Record<string, unknown>;
    assert.equal(body["issuer"], "https://nixamp.test");
    assert.equal(body["authorization_endpoint"], "https://nixamp.test/api/v1/oauth/authorize");
    assert.deepEqual(body["code_challenge_methods_supported"], ["S256"]);
    assert.deepEqual(body["response_types_supported"], ["code"]);
    // OAuth 2.1: no implicit, no password.
    assert.deepEqual(body["grant_types_supported"], ["authorization_code", "refresh_token"]);
    assert.deepEqual(body["scopes_supported"], SCOPE_NAMES);
  });
});

test("an authorization request without PKCE is refused, back to the client", async () => {
  await withServer(async (harness) => {
    const answer = await fetch(
      `${harness.base}/api/v1/oauth/authorize?response_type=code&client_id=bittorrented` +
        `&redirect_uri=${encodeURIComponent(BITTORRENTED_CLIENT.redirectUris[0]!)}&state=xyz`,
      { redirect: "manual", headers: { authorization: `Bearer ${harness.session}` } },
    );
    assert.equal(answer.status, 302);
    const location = new URL(answer.headers.get("location") ?? "");
    assert.equal(location.searchParams.get("error"), "invalid_request");
    assert.match(location.searchParams.get("error_description") ?? "", /code_challenge/);
    assert.equal(location.searchParams.get("state"), "xyz");
  });
});

test("a bad redirect URI is a page, never a redirect", async () => {
  await withServer(async (harness) => {
    const answer = await fetch(
      `${harness.base}/api/v1/oauth/authorize?response_type=code&client_id=bittorrented` +
        `&redirect_uri=${encodeURIComponent("https://evil.test/steal")}&state=xyz`,
      { redirect: "manual", headers: { authorization: `Bearer ${harness.session}` } },
    );
    // Bouncing an error to an unregistered URI would make this an open redirector.
    assert.equal(answer.status, 400);
    assert.equal(answer.headers.get("location"), null);
    assert.match(answer.headers.get("content-type") ?? "", /text\/html/);
  });
});

test("code, PKCE and refresh: the whole grant, and the access token is a nixamp token", async () => {
  await withServer(async (harness) => {
    const { location, verifier } = await authorize(harness);
    const code = new URL(location).searchParams.get("code") ?? "";
    assert.ok(code);
    assert.equal(new URL(location).searchParams.get("state"), "xyz");

    const granted = await exchange(harness, code, verifier);
    assert.equal(granted["token_type"], "Bearer");
    assert.ok(granted["access_token"]?.startsWith("nxa_"));
    assert.ok(granted["refresh_token"]?.startsWith("nxr_"));
    assert.equal(granted["scope"], "profile parties offline_access");

    // The access token walks through whoIs like any other, which is what
    // makes every existing /api/v1 route understand it.
    const who = await harness.accounts.whoIs(granted["access_token"]!);
    assert.equal(who?.id, "host-1");

    const info = await fetch(`${harness.base}/api/v1/oauth/userinfo`, {
      headers: { authorization: `Bearer ${granted["access_token"]}` },
    });
    const claims = (await info.json()) as Record<string, unknown>;
    assert.equal(claims["sub"], "host-1");
    assert.equal(claims["client_id"], "bittorrented");
    // No `email` scope was asked for, so no address is handed over.
    assert.equal(claims["email"], undefined);

    // Refresh rotates: a new pair, and a different refresh token.
    const refreshed = await fetch(`${harness.base}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "bittorrented",
        refresh_token: granted["refresh_token"]!,
      }).toString(),
    });
    const next = (await refreshed.json()) as Record<string, string>;
    assert.equal(refreshed.status, 200);
    assert.notEqual(next["refresh_token"], granted["refresh_token"]);
    assert.notEqual(next["access_token"], granted["access_token"]);

    // The retired one, used again, withdraws the whole family: that only
    // happens when two parties hold one secret.
    const replayed = await fetch(`${harness.base}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "bittorrented",
        refresh_token: granted["refresh_token"]!,
      }).toString(),
    });
    assert.equal(replayed.status, 400);
    assert.equal(((await replayed.json()) as Record<string, string>)["error"], "invalid_grant");
    assert.equal(await harness.accounts.whoIs(next["access_token"]!), null);
  });
});

test("a code is spent once, and spending it twice withdraws what it produced", async () => {
  await withServer(async (harness) => {
    const { location, verifier } = await authorize(harness);
    const code = new URL(location).searchParams.get("code") ?? "";
    const first = await exchange(harness, code, verifier);
    assert.ok(first["access_token"]);
    const again = await exchange(harness, code, verifier);
    assert.equal(again["error"], "invalid_grant");
    // The first exchange's tokens go too: a replayed code means somebody else
    // has it, and there is no telling which of the two was the thief.
    assert.equal(await harness.accounts.whoIs(first["access_token"]!), null);
  });
});

test("the wrong verifier gets nothing, however good the code is", async () => {
  await withServer(async (harness) => {
    const { location } = await authorize(harness);
    const code = new URL(location).searchParams.get("code") ?? "";
    const stolen = await exchange(harness, code, randomBytes(32).toString("base64url"));
    assert.equal(stolen["error"], "invalid_grant");
    assert.match(stolen["error_description"] ?? "", /code_verifier/);
  });
});

test("the grants OAuth 2.1 removed are refused by name", async () => {
  await withServer(async (harness) => {
    for (const grantType of ["password", "implicit", "client_credentials"]) {
      const answer = await fetch(`${harness.base}/api/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: grantType,
          client_id: "bittorrented",
          username: "host@example.com",
          password: "hunter2",
        }).toString(),
      });
      assert.equal(answer.status, 400);
      assert.equal(((await answer.json()) as Record<string, string>)["error"], "unsupported_grant_type");
    }
  });
});

test("saying no sends the client an access_denied and no code", async () => {
  await withServer(async (harness) => {
    const { location } = await authorize(harness, { decision: "deny" });
    const url = new URL(location);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("code"), null);
  });
});

test("the consent page asks before anything is granted, and needs a signed-in person", async () => {
  await withServer(async (harness) => {
    const query =
      `response_type=code&client_id=bittorrented&redirect_uri=${encodeURIComponent(BITTORRENTED_CLIENT.redirectUris[0]!)}` +
      `&scope=profile+parties&state=xyz&code_challenge=${challengeFor("x".repeat(43))}&code_challenge_method=S256`;
    const anonymous = await fetch(`${harness.base}/api/v1/oauth/authorize?${query}`, { redirect: "manual" });
    assert.equal(anonymous.status, 401);

    const asked = await fetch(`${harness.base}/api/v1/oauth/authorize?${query}`, {
      redirect: "manual",
      headers: { authorization: `Bearer ${harness.session}` },
    });
    assert.equal(asked.status, 200);
    const page = await asked.text();
    assert.match(page, /bittorrented\.com/);
    // Every scope is named on the page, not summarised as "access your account".
    assert.match(page, /host and join watch parties/);
  });
});

// --- the watch party bridge ------------------------------------------------------

async function connected(harness: Harness, scope = "profile parties"): Promise<string> {
  const { location, verifier } = await authorize(harness, { scope });
  const code = new URL(location).searchParams.get("code") ?? "";
  return (await exchange(harness, code, verifier))["access_token"]!;
}

test("a watch party bridges to a nixamp room, once, however many times it is asked", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness);
    const bridge = async () =>
      fetch(`${harness.base}/api/v1/watch-parties`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          partyCode: "abc123",
          title: "Dune, together",
          partyUrl: "https://bittorrented.com/watch-party?code=ABC123",
          mediaTitle: "Dune (2021)",
        }),
      });

    const first = await bridge();
    assert.equal(first.status, 201);
    const made = (await first.json()) as {
      party: { partyCode: string; roomId: string; origin: string };
      event: { id: string; status: string; visibility: string };
      links: { nixampUrl: string; partyUrl: string };
      host: boolean;
    };
    assert.equal(made.party.partyCode, "ABC123");
    assert.equal(made.party.origin, "bittorrented");
    // Live at once: a watch party exists because people are watching it now.
    assert.equal(made.event.status, "live");
    assert.equal(made.event.visibility, "unlisted");
    assert.ok(made.host);
    assert.match(made.links.nixampUrl, /^https:\/\/nixamp\.test\/live\//);

    // The client calls this every time somebody opens the party page, so the
    // second call must answer the same room rather than make another.
    const second = await bridge();
    const again = (await second.json()) as { party: { roomId: string }; event: { id: string } };
    assert.equal(again.event.id, made.event.id);
    assert.equal(again.party.roomId, made.party.roomId);
  });
});

test("a watch link must be on the client's own site", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness);
    const answer = await fetch(`${harness.base}/api/v1/watch-parties`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ partyCode: "ABC124", partyUrl: "https://evil.test/come-here" }),
    });
    assert.equal(answer.status, 403);
  });
});

test("a token without the parties scope cannot touch a party", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness, "profile");
    const answer = await fetch(`${harness.base}/api/v1/watch-parties`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ partyCode: "ABC125" }),
    });
    assert.equal(answer.status, 401);
  });
});

test("only the host moves everybody's playback, and a late joiner is told where it is now", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness);
    const made = await fetch(`${harness.base}/api/v1/watch-parties`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ partyCode: "ABC126", mediaTitle: "Dune (2021)" }),
    }).then((answer) => answer.json()) as { party: { partyCode: string } };

    const moved = await fetch(`${harness.base}/api/v1/watch-parties/${made.party.partyCode}/playback`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: 930, playing: true }),
    });
    assert.equal(moved.status, 200);
    const state = (await moved.json()) as { party: { positionSeconds: number; playing: boolean; positionNow: number } };
    assert.equal(state.party.positionSeconds, 930);
    assert.ok(state.party.playing);
    // A playing film has moved on since the host last said anything, so the
    // answer is never behind where it actually is.
    assert.ok(state.party.positionNow >= 930);

    // A different account holds a token for the same client but is not the host.
    const other = await harness.accounts.tokens!.issue({
      account: { id: "account-2", email: "other@example.com" },
      kind: "oauth",
      name: "bittorrented profile parties",
    });
    const refused = await fetch(`${harness.base}/api/v1/watch-parties/${made.party.partyCode}/playback`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: 0 }),
    });
    assert.equal(refused.status, 403);
  });
});

test("a person's own session reaches the parties without any OAuth at all", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness);
    await fetch(`${harness.base}/api/v1/watch-parties`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ partyCode: "ABC127", title: "Dune, together" }),
    });
    // The same list, asked for with the session a browser on nixamp.com holds.
    const listed = await fetch(`${harness.base}/api/v1/watch-parties`, {
      headers: { authorization: `Bearer ${harness.session}` },
    });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { parties: { party: { partyCode: string } }[] };
    assert.ok(body.parties.some((row) => row.party.partyCode === "ABC127"));
  });
});

test("an account can see what it connected, and take it away", async () => {
  await withServer(async (harness) => {
    const token = await connected(harness, "profile parties offline_access");
    const listed = await fetch(`${harness.base}/api/v1/oauth/connections`, {
      headers: { authorization: `Bearer ${harness.session}` },
    });
    const body = (await listed.json()) as { connections: { clientId: string; clientName: string }[] };
    assert.equal(body.connections[0]?.clientId, "bittorrented");
    assert.equal(body.connections[0]?.clientName, "bittorrented.com");

    const off = await fetch(`${harness.base}/api/v1/oauth/connections/bittorrented`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${harness.session}` },
    });
    assert.equal(off.status, 200);
    // Disconnecting withdraws the access token the connection was holding.
    assert.equal(await harness.accounts.whoIs(token), null);
  });
});

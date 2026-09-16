import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PostgresAdapter } from "@profullstack/auth-system";
import pg from "pg";
import { Accounts, type AdapterLike } from "../src/accounts.ts";
import type { Queryable } from "../src/follows.ts";
import { Handles } from "../src/handles.ts";
import { LINK_SCOPE, NixampLinks, nixampExchange, type OAuthExchange, type TokenGrant } from "../src/nixamp-link.ts";
import { streamsFor } from "../src/nixamp-link-api.ts";
import { AuthorizationServer, BACKTOSCHOOL_CLIENT, clientsFrom, SCOPES } from "../src/oauth-server.ts";
import { createServer, EmptyEngine } from "../src/server.ts";
import { Servers } from "../src/servers.ts";

/** One table, in a Map. */
function fakeDb(): Queryable & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    async query(text: string, values: unknown[] = []) {
      const sql = text.trim().replace(/\s+/g, " ");
      if (sql.startsWith("CREATE TABLE")) return { rows: [] };
      if (sql.startsWith("INSERT INTO nixamp_links")) {
        const [user_id, nixamp_user_id, handle, scope, access_token, access_expires_at, refresh_token] = values;
        const had = rows.get(String(user_id));
        rows.set(String(user_id), { user_id, nixamp_user_id, handle, scope, access_token, access_expires_at, refresh_token, created_at: had?.["created_at"] ?? new Date() });
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nixamp_links SET access_token")) {
        const [user_id, access_token, access_expires_at, refresh_token] = values;
        const row = rows.get(String(user_id));
        if (row) Object.assign(row, { access_token, access_expires_at, refresh_token });
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM nixamp_links")) {
        rows.delete(String(values[0]));
        return { rows: [] };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM nixamp_links WHERE user_id = $1")) {
        const row = rows.get(String(values[0]));
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function fakeExchange(log: string[]): OAuthExchange & { fail: boolean } {
  let n = 0;
  const it = {
    fail: false,
    authorizeUrl(query: Record<string, string>) {
      return `https://nixamp.test/api/v1/oauth/authorize?${new URLSearchParams(query)}`;
    },
    async token(form: URLSearchParams): Promise<TokenGrant> {
      log.push(`token:${form.get("grant_type")}`);
      if (it.fail) throw new Error("invalid_grant");
      n += 1;
      return { access_token: `nxa_access_${n}`, refresh_token: `nxr_refresh_${n}`, expires_in: 3600, scope: LINK_SCOPE };
    },
    async userinfo(token: string) {
      log.push(`userinfo:${token}`);
      return { sub: "nixamp-user-9", handle: "chovy" };
    },
    async revoke(token: string) {
      log.push(`revoke:${token}`);
    },
  };
  return it;
}

test("a connection is begun with PKCE, kept with its tokens, refreshed when stale, and withdrawn on both sides", async () => {
  const log: string[] = [];
  const exchange = fakeExchange(log);
  let clock = 1_000_000;
  const links = new NixampLinks(fakeDb(), exchange, "backtoschool", () => clock);

  const leg = links.begin("https://backtoschool.help/api/v1/nixamp/callback");
  const url = new URL(leg.url);
  assert.equal(url.searchParams.get("client_id"), "backtoschool");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), LINK_SCOPE);
  assert.equal(url.searchParams.get("state"), leg.state);
  assert.ok(leg.verifier.length >= 43);
  assert.notEqual(url.searchParams.get("code_challenge"), leg.verifier, "the verifier itself never leaves");
  assert.deepEqual(await links.of("school-1"), { connected: false, handle: "", nixampUserId: "", scope: "", since: null });

  const made = await links.finish("school-1", { code: "c0de", verifier: leg.verifier, redirectUri: "https://backtoschool.help/api/v1/nixamp/callback" });
  assert.equal(made.connected, true);
  assert.equal(made.handle, "chovy");
  assert.equal(made.nixampUserId, "nixamp-user-9");
  assert.deepEqual(log, ["token:authorization_code", "userinfo:nxa_access_1"]);

  assert.equal(await links.accessToken("school-1"), "nxa_access_1", "fresh: served as kept");
  clock += 3600 * 1000;
  assert.equal(await links.accessToken("school-1"), "nxa_access_2", "stale: refreshed");
  assert.equal(log.at(-1), "token:refresh_token");
  assert.equal(await links.accessToken("school-1"), "nxa_access_2", "and the new one is kept");

  clock += 3600 * 1000;
  exchange.fail = true;
  assert.equal(await links.accessToken("school-1"), "", "a refused refresh is a withdrawn grant");
  assert.equal((await links.of("school-1")).connected, false);
  assert.equal(await links.disconnect("school-1"), false);

  exchange.fail = false;
  await links.finish("school-1", { code: "c0de2", verifier: leg.verifier, redirectUri: "https://backtoschool.help/api/v1/nixamp/callback" });
  assert.equal(await links.disconnect("school-1"), true);
  assert.equal(log.at(-1), "revoke:nxr_refresh_3", "the refresh token is what is handed back");
  assert.equal((await links.of("school-1")).connected, false);
});

test("the school is a registered public client with a streams scope", () => {
  const clients = clientsFrom({});
  assert.ok(clients.some((one) => one.id === "backtoschool" && !one.secretHash));
  assert.ok(BACKTOSCHOOL_CLIENT.redirectUris.includes("https://backtoschool.help/api/v1/nixamp/callback"));
  assert.ok(!clientsFrom({ NIXAMP_OAUTH_BACKTOSCHOOL: "off" }).some((one) => one.id === "backtoschool"));
  assert.match(SCOPES.streams, /servers you run/);
});

test("streams are read from every server the account remembers, one that is down is said to be", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://nixamp.test/api/v1/servers") {
      return Response.json({ servers: [
        { id: "s1", name: "study", url: "https://study.example", key: "k3y" },
        { id: "s2", name: "", url: "https://down.example", key: "" },
      ] });
    }
    if (url.startsWith("https://study.example/api/streams")) {
      assert.equal(new URL(url).searchParams.get("k"), "k3y", "the account's own key is used to ask");
      return Response.json({
        server: { name: "study hall", nowPlaying: "Lecture 3", playing: true, url: "https://study.example/view/l1st3n" },
        channels: [{ id: "algebra", name: "Algebra", kind: "video", listeners: 2 }],
      });
    }
    throw new Error("down");
  };
  const servers = await streamsFor("nxa_t", "https://nixamp.test", "https://nixamp.test", fetcher);
  assert.equal(servers.length, 2);
  const [study, down] = servers;
  assert.equal(study!.reachable, true);
  assert.equal(study!.name, "study hall");
  assert.equal(study!.live, "https://nixamp.test/?url=https%3A%2F%2Fstudy.example%2Fview%2Fl1st3n&play=live");
  assert.equal(study!.channels[0]!.link, "https://nixamp.test/?url=https%3A%2F%2Fstudy.example%2Fview%2Fl1st3n&play=channel%3Aalgebra");
  assert.equal(study!.channels[0]!.listeners, 2);
  assert.equal(down!.reachable, false);
  assert.equal(down!.name, "https://down.example");
  assert.deepEqual(down!.channels, []);
});

test("connect, consent, callback and streams, end to end over one server that is both sides", {
  skip: !process.env["NIXAMP_TEST_DATABASE_URL"],
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env["NIXAMP_TEST_DATABASE_URL"] });
  const adapter = new PostgresAdapter({ pool }) as unknown as AdapterLike;
  const accounts = new Accounts({ connectionString: "", secret: "test-secret", adapter });
  const email = `link-${randomUUID()}@example.com`;
  const signed = await accounts.signUp(email, "Some-password9");
  assert.equal(signed.ok, true);
  const account = signed.account!;

  // A nixamp somewhere, with one channel on it.
  const machine = createHttp((request, response) => {
    if (request.url?.startsWith("/api/streams")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ server: { name: "study", playing: false, url: "" }, channels: [{ id: "algebra", name: "Algebra", kind: "audio", listeners: 0 }] }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => machine.listen(0, "127.0.0.1", resolve));
  const machineUrl = `http://127.0.0.1:${(machine.address() as AddressInfo).port}`;

  let base = "";
  const authServer = new AuthorizationServer({ db: pool, tokens: accounts.tokens!, clients: clientsFrom({}), issuer: "http://placeholder.test" });
  const viaBase: typeof fetch = (input, init) => fetch(String(input).replace("http://placeholder.test", base), init);
  const links = new NixampLinks(pool, nixampExchange("http://placeholder.test", BACKTOSCHOOL_CLIENT.id, viaBase), BACKTOSCHOOL_CLIENT.id, undefined, viaBase);
  const server = createServer(new EmptyEngine(), {
    web: null, media: false, version: "test", load: async () => [], accounts,
    handles: new Handles(pool), servers: new Servers(pool), authServer, links, site: "http://placeholder.test",
    webSites: new Map([["backtoschool.help", { site: "https://backtoschool.help", web: "/unused" }]]),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const school = { authorization: `Bearer ${signed.token}`, host: "backtoschool.help" };
  const at = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { ...school, ...(init.headers ?? {}) } });
  try {
    const handle = `h${randomUUID().slice(0, 8)}`;
    const claimed = await new Handles(pool).claim(account.id, handle);
    assert.equal(claimed.error, "");
    // Remember the machine on the nixamp side (the same account, the same table).
    const kept = await fetch(`${base}/api/v1/servers`, { method: "POST", headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "study", url: machineUrl }) });
    assert.equal(kept.status, 201);

    const before = await (await at("/api/v1/nixamp/connection")).json() as { connected: boolean; available: boolean };
    assert.deepEqual(before, { connected: false, handle: "", nixampUserId: "", scope: "", since: null, available: true });
    assert.equal((await at("/api/v1/nixamp/streams")).status, 409, "no streams before a connection");
    assert.equal((await fetch(`${base}/api/v1/nixamp/connect`, { redirect: "manual", headers: { host: "backtoschool.help" } })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/nixamp/connect`, { redirect: "manual", headers: { authorization: school.authorization, host: "elsewhere.example" } })).status, 400, "only a registered site may connect");

    // Leg one: sent to nixamp.com with PKCE, the secrets in a short cookie.
    const go = await at("/api/v1/nixamp/connect");
    assert.equal(go.status, 302, await go.text());
    const consent = new URL(go.headers.get("location")!);
    assert.equal(consent.pathname, "/api/v1/oauth/authorize");
    assert.equal(consent.searchParams.get("redirect_uri"), "https://backtoschool.help/api/v1/nixamp/callback");
    const cookie = go.headers.get("set-cookie")!;
    assert.match(cookie, /^nixamp_connect=.+; Path=\/api\/v1\/nixamp\/callback; Max-Age=600; SameSite=Lax; HttpOnly$/);
    const legCookie = cookie.split(";")[0]!;

    // The person, on nixamp.com, says yes.
    const form = new URLSearchParams(consent.search);
    form.set("decision", "allow");
    const allowed = await fetch(`${base}/api/v1/oauth/authorize`, { method: "POST", redirect: "manual", headers: { authorization: school.authorization, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    assert.equal(allowed.status, 302);
    const back = new URL(allowed.headers.get("location")!);
    assert.equal(back.origin + back.pathname, "https://backtoschool.help/api/v1/nixamp/callback");
    assert.equal(back.searchParams.get("state"), consent.searchParams.get("state"));

    // A callback with a state this browser never started is refused.
    const forged = await at(`/api/v1/nixamp/callback?code=${back.searchParams.get("code")}&state=forged`, { headers: { cookie: legCookie } });
    assert.equal(forged.status, 302);
    assert.match(forged.headers.get("location")!, /nixamp=failed/);

    // Leg two: the code becomes tokens on the school account.
    const done = await at(`/api/v1/nixamp/callback${back.search}`, { headers: { cookie: legCookie } });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/?nixamp=connected#settings");
    assert.match(done.headers.get("set-cookie")!, /Max-Age=0/);
    const after = await (await at("/api/v1/nixamp/connection")).json() as { connected: boolean; handle: string; nixampUserId: string; scope: string };
    assert.equal(after.connected, true);
    assert.equal(after.handle, handle);
    assert.equal(after.nixampUserId, account.id);
    assert.equal(after.scope, LINK_SCOPE);
    const stored = (await pool.query("SELECT * FROM nixamp_links WHERE user_id=$1", [account.id])).rows[0];
    assert.match(String(stored.access_token), /^nxa_/);
    assert.match(String(stored.refresh_token), /^nxr_/);
    // nixamp.com lists the school among the account's connections.
    const grants = await authServer.grants(account.id);
    assert.ok(grants.some((one) => one.clientId === "backtoschool" && one.scope.includes("streams")));

    // What the connection is for.
    const streamed = await at("/api/v1/nixamp/streams");
    assert.equal(streamed.status, 200, await streamed.clone().text());
    const streams = await streamed.json() as { servers: { name: string; reachable: boolean; channels: { id: string; link: string }[] }[] };
    assert.equal(streams.servers.length, 1);
    assert.equal(streams.servers[0]!.reachable, true);
    assert.equal(streams.servers[0]!.channels[0]!.id, "algebra");
    assert.equal(streams.servers[0]!.channels[0]!.link, `http://placeholder.test/?url=${encodeURIComponent(machineUrl)}&play=channel%3Aalgebra`);

    // Withdrawn here, gone on nixamp.com too.
    const gone = await (await at("/api/v1/nixamp/connection", { method: "DELETE" })).json() as { withdrawn: boolean };
    assert.equal(gone.withdrawn, true);
    assert.equal(((await (await at("/api/v1/nixamp/connection")).json()) as { connected: boolean }).connected, false);
    assert.ok(!(await authServer.grants(account.id)).some((one) => one.clientId === "backtoschool"));
    assert.equal(await accounts.whoIs(String(stored.access_token)), null, "the access token was revoked with the grant");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    machine.closeAllConnections();
    await new Promise<void>((resolve) => machine.close(() => resolve()));
    for (const table of ["nixamp_links", "nixamp_oauth_refresh", "nixamp_oauth_codes", "nixamp_servers", "nixamp_handles", "nixamp_tokens"]) {
      await pool.query(`DELETE FROM ${table} WHERE user_id=$1`, [account.id]).catch(() => undefined);
    }
    await pool.query("DELETE FROM users WHERE id=$1", [account.id]);
    await pool.end();
  }
});

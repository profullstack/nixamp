import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { broadcastHealth, checkClasses, deleteClass, getClass, listClasses, teach } from "../src/school-client.ts";
import { callSchoolTool, SCHOOL_PUBLIC_TOOLS, SCHOOL_TOOLS } from "../src/school-mcp.ts";
import { handleSchoolDiscovery, isSchoolSite, schoolLlmsTxt, schoolOpenapi } from "../src/school-discovery.ts";

const TOKEN = "nxa_test";

/** The events API as live-api.ts answers it: owner by token, start/end want the version read. */
function school(): { listen: () => Promise<string>; close: () => void; events: Map<string, Record<string, unknown>> } {
  const events = new Map<string, Record<string, unknown>>();
  let n = 0;
  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const read = (request: IncomingMessage): Promise<Record<string, unknown>> => new Promise((done) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => done(body ? JSON.parse(body) as Record<string, unknown> : {}));
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const signed = request.headers.authorization === `Bearer ${TOKEN}`;
    const find = (ref: string) => [...events.values()].find((one) => one["id"] === ref || one["slug"] === ref);
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      if (url.searchParams.get("mine") === "true" && !signed) return json(response, 401, { error: "sign in to see your events" });
      const status = url.searchParams.get("status");
      return json(response, 200, { events: [...events.values()].filter((one) => !status || one["status"] === status) });
    }
    if (request.method !== "GET" && !signed) return json(response, 401, { error: "sign in" });
    if (url.pathname === "/api/v1/events" && request.method === "POST") {
      const input = await read(request);
      n += 1;
      const made = { ...input, id: `id-${n}`, slug: String(input["title"]).toLowerCase().replace(/[^a-z0-9]+/g, "-"), status: "draft", version: 1, ownerId: "me" };
      events.set(String(made.id), made);
      return json(response, 200, { event: made });
    }
    const match = /^\/api\/v1\/events\/([^/]+)(?:\/(start|end))?$/.exec(url.pathname);
    const event = match ? find(decodeURIComponent(match[1]!)) : undefined;
    if (!event) return json(response, 404, { error: "event not found" });
    if (request.method === "GET") return json(response, 200, { event });
    if (request.method === "DELETE") { events.delete(String(event["id"])); return json(response, 200, { ok: true }); }
    const input = await read(request);
    if (input["version"] !== event["version"]) return json(response, 409, { error: "version is required" });
    if (match![2]) event["status"] = match![2] === "start" ? "live" : "ended";
    else Object.assign(event, input);
    event["version"] = Number(event["version"]) + 1;
    return json(response, 200, { event });
  });
  return {
    events,
    listen: () => new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => server.close(),
  };
}

/** A station server's /state and a daemon's /api/streams, by what the public link carries. */
const broadcasts: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/v1/stations/abcdefghij/state") return Response.json({ state: url.searchParams.get("t") === "good" ? "live" : "stopped" });
  if (url.pathname === "/api/streams" && url.searchParams.get("k") === "LISTEN") return Response.json({ server: { live: false }, channels: [{ id: "folder-on" }] });
  if (url.hostname === "cdn.example") return new Response(null, { status: url.pathname.includes("gone") ? 404 : 206 });
  return new Response(null, { status: 404 });
};

const STATION = "https://server2.chovy.nixamp.com:4321/station/abcdefghij?t=good";
const viewOf = (channel: string): string => `https://nixamp.com/?url=${encodeURIComponent("https://server1.chovy.nixamp.com:4321/view/LISTEN")}&play=channel:${channel}`;

test("a broadcast is asked with only what its public link carries", async () => {
  assert.deepEqual(await broadcastHealth(STATION, broadcasts), { ok: true, reason: "station abcdefghij is live" });
  assert.equal((await broadcastHealth(STATION.replace("good", "old"), broadcasts)).ok, false);
  assert.equal((await broadcastHealth(viewOf("folder-on"), broadcasts)).ok, true);
  assert.deepEqual(await broadcastHealth(viewOf("folder-gone"), broadcasts), { ok: false, reason: "channel folder-gone is no longer on server1.chovy.nixamp.com" });
  assert.equal((await broadcastHealth("https://cdn.example/hls/live.m3u8", broadcasts)).ok, true);
  assert.equal((await broadcastHealth("https://cdn.example/gone/chunklist.m3u8", broadcasts)).ok, false);
  // A Pairux room cannot be asked from here, so a prune must leave it alone.
  assert.equal((await broadcastHealth("https://pairux.com/l/abc", broadcasts)).ok, null);
  assert.equal((await broadcastHealth(null, broadcasts)).ok, false);
});

test("teach makes a class and starts it with the version it read; check finds the dead ones", async () => {
  const fake = school();
  const site = await fake.listen();
  const send: typeof fetch = (input, init) => String(input).startsWith(site) ? fetch(input, init) : broadcasts(input, init);
  const options = { site, token: TOKEN, fetcher: send };
  try {
    const live = await teach({ title: "MIT 6.858", broadcastUrl: STATION }, options);
    assert.equal(live.status, "live");
    assert.equal(live.kind, "class");
    assert.equal(live.visibility, "public");
    await teach({ title: "Gone channel", broadcastUrl: viewOf("folder-gone") }, options);
    const checked = await checkClasses(options);
    assert.deepEqual(checked.map(({ item, health }) => [item.slug, health.ok]), [["mit-6-858", true], ["gone-channel", false]]);
    await deleteClass("gone-channel", options);
    assert.deepEqual((await listClasses({ status: "live" }, options)).map((one) => one.slug), ["mit-6-858"]);
    assert.equal((await getClass(`${site}/live/mit-6-858`, options)).title, "MIT 6.858");
    await assert.rejects(teach({ title: "x", broadcastUrl: STATION }, { ...options, token: null }), /nixamp login/);
  } finally {
    fake.close();
  }
});

test("the MCP tools teach, end and refuse without a class", async () => {
  const fake = school();
  const site = await fake.listen();
  const options = { site, token: TOKEN, fetcher: fetch };
  try {
    const taught = await callSchoolTool("class_teach", { title: "Security", broadcastUrl: STATION }, options);
    assert.equal(taught.isError, undefined, taught.content[0]!.text);
    assert.equal(taught.content[0]!.text, `On the air: ${site}/live/security`);
    const ended = await callSchoolTool("class_end", { slug: "security" }, options);
    assert.match(ended.content[0]!.text, /^ended/);
    assert.equal((await callSchoolTool("class_start", {}, options)).isError, true);
    const refused = await callSchoolTool("class_delete", { slug: "security" }, { ...options, token: null });
    assert.equal(refused.isError, true);
    assert.equal(fake.events.size, 1);
  } finally {
    fake.close();
  }
});

test("the school's host has its own llms.txt, OpenAPI and MCP; nixamp.com keeps its own", async () => {
  assert.equal(isSchoolSite("https://backtoschool.help"), true);
  assert.equal(isSchoolSite("https://www.backtoschool.help"), true);
  assert.equal(isSchoolSite("https://nixamp.com"), false);
  assert.equal(isSchoolSite(undefined), false);
  const text = schoolLlmsTxt("https://backtoschool.help", "https://nixamp.com");
  assert.match(text, /^# BackToSchool\.help$/m);
  assert.match(text, /https:\/\/backtoschool\.help\/mcp\/public/);
  assert.match(text, /nixamp school teach/);
  const paths = Object.keys(schoolOpenapi("https://backtoschool.help", "https://nixamp.com", "1")["paths"] as object);
  assert.ok(paths.includes("/api/v1/events/{slug}/start"));

  const fake = school();
  const site = await fake.listen();
  const front = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    void handleSchoolDiscovery(request, response, url.pathname, {
      site, accountSite: "https://nixamp.com", version: "1",
      whoIs: async (token) => token === TOKEN ? { id: "me" } : null,
      token: String(request.headers.authorization ?? "").replace(/^Bearer /, ""),
      readBody: (incoming) => new Promise((done) => { let body = ""; incoming.on("data", (c) => { body += c; }); incoming.on("end", () => done(body)); }),
      json: (out, status, body) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(body)); },
    }).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  const rpc = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.match(await (await fetch(`${base}/llms.txt`)).text(), /BackToSchool/);
    const listed = await (await rpc("/mcp/public", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listed.result.tools.map((one) => one.name), SCHOOL_PUBLIC_TOOLS.map((one) => one.name));
    const shut = await rpc("/mcp/public", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "class_teach", arguments: {} } });
    assert.equal(((await shut.json()) as { error: { code: number } }).error.code, -32001);
    const anonymous = await rpc("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
    const all = await (await rpc("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/list" }, TOKEN)).json() as { result: { tools: unknown[] } };
    assert.equal(all.result.tools.length, SCHOOL_TOOLS.length);
    const taught = await (await rpc("/mcp", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "class_create", arguments: { title: "Draft one" } } }, TOKEN)).json() as { result: { content: Array<{ text: string }> } };
    assert.match(taught.result.content[0]!.text, /Made \(draft\)/);
    assert.equal(fake.events.size, 1);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  } finally {
    front.close();
    fake.close();
  }
});

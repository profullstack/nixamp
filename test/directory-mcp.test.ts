import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { callPublicTool } from "../src/directory-mcp.ts";
import { renderGuide } from "../src/station-guide.ts";

const guide = async () => [
  { id: "24uy7gidfu", name: "DSA: Data Structures and Algorithms", kind: "video", group: "tv", state: "live", page: "https://server2.example/station/24uy7gidfu?t=a", nowPlaying: { title: "Binary Search", artist: "" } },
  { id: "fvnx6rwyzt", name: "AI Lo-Fi Beats", kind: "audio", group: "ai", state: "live", page: "https://server1.example/station/fvnx6rwyzt?t=b", nowPlaying: null },
];

test("anybody finds a station by its words, and lists them by kind", async () => {
  const found = await callPublicTool("station_find", { query: "data structures" }, { guide });
  assert.match(found.content[0]!.text, /DSA: Data Structures/);
  assert.match(found.content[0]!.text, /https:\/\/server2\.example\/station\/24uy7gidfu/);
  assert.doesNotMatch(found.content[0]!.text, /Lo-Fi/);
  const radio = await callPublicTool("stations_list", { kind: "audio" }, { guide });
  assert.match(radio.content[0]!.text, /AI Lo-Fi Beats \[radio, ai\] LIVE/);
  assert.doesNotMatch(radio.content[0]!.text, /DSA/);
  const none = await callPublicTool("station_find", { query: "polka" }, { guide });
  assert.match(none.content[0]!.text, /No public station matches/);
});

test("station_share sends the declaration to the station's own server", async () => {
  let got: Record<string, unknown> | null = null;
  const server = createHttp((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      got = { path: request.url, ...JSON.parse(body) };
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "/api/v1/share/abcdefabcdef?t=x" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const local = async () => [{ id: "ge8zcscgnp", name: "Shared: Classical", kind: "audio", group: "shared", state: "live", page: `${origin}/station/ge8zcscgnp?t=c`, nowPlaying: null }];
    const answer = await callPublicTool("station_share", { station: "ge8zcscgnp", url: "https://example.org/a.mp3", basis: "creative-commons", agree: true }, { guide: local });
    assert.equal(answer.isError, undefined, answer.content[0]!.text);
    assert.deepEqual(got, { path: "/api/v1/share", url: "https://example.org/a.mp3", basis: "creative-commons", note: "", by: "", agree: true });
    assert.match(answer.content[0]!.text, new RegExp(`${origin}/api/v1/share/abcdefabcdef`));
  } finally {
    server.close();
  }
});

test("the guide page knows its server's address, so a gateway does not swallow its requests", () => {
  const page = renderGuide([], "https://server1.example:4321");
  assert.match(page, /<body data-api="https:\/\/server1\.example:4321">/);
  assert.match(renderGuide([], "javascript:alert(1)"), /<body>/, "only an https address");
  assert.doesNotMatch(page, /confirm\("/, "a sandboxed page cannot open confirm()");
});

test("/mcp/public answers anybody with the station tools, even on a server with a key", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Channels } = await import("../src/channels.ts");
  const { emptySnapshot } = await import("../src/protocol.ts");
  const { createServer } = await import("../src/server.ts");
  const { StationRunner } = await import("../src/station-runner.ts");
  const { StationStore } = await import("../src/stations.ts");
  const top = mkdtempSync(join(tmpdir(), "nixamp-pubmcp-"));
  const store = new StationStore(join(top, "s.json"), { read: () => null, write: () => undefined });
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [top] });
  const shown = store.create({ name: "Data Structures TV" }, ["/x.mp4"], "");
  store.setAccess(shown.id, { visibility: "public", listed: true, rights: { basis: "owned" } }, "acct");
  store.create({ name: "Secret FM" }, ["/y.mp3"], "");
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as never;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, publicBase: () => "https://s1.example:4321" } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = (body: unknown) => fetch(`${base}/mcp/public`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const listed = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listed.result.tools.map((one) => one.name), ["stations_list", "station_find", "station_share"]);
    const found = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "station_find", arguments: { query: "data structures" } } })).json()) as { result: { content: Array<{ text: string }> } };
    assert.match(found.result.content[0]!.text, /Data Structures TV/);
    assert.match(found.result.content[0]!.text, /https:\/\/s1\.example:4321\/station\//);
    const all = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stations_list", arguments: {} } })).json()) as { result: { content: Array<{ text: string }> } };
    assert.doesNotMatch(all.result.content[0]!.text, /Secret FM/, "private stations never");
    const other = (await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "station_create", arguments: {} } })).json()) as { error: { code: number } };
    assert.equal(other.error.code, -32001, "managing stations is not public");
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

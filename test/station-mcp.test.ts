import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { callTool, handleMessage, TOOLS } from "../src/mcp.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

test("station tools: create private, publish asks the basis, list shows the link", async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-mcp-lib-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-mcp-state-"));
  const file = join(root, "a.mp3");
  writeFileSync(file, "not really audio; nothing here is started");
  const engine = {
    snapshot: (withTracks = true) => ({ ...emptySnapshot(), revision: 1, root, trackCount: 1, ...(withTracks ? { tracks: [{ title: "A", artist: "", album: "", duration: 0 }] } : {}) }),
    command: () => undefined,
    subscribe: () => () => undefined,
    trackPath: (index: number) => (index === 0 ? file : undefined),
  } as unknown as Engine;
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const store = new StationStore(StationStore.fileFor(state, 1));
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [root] });
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const options = { session: null, stations: { local: { url, key: "ctl" } } };
  try {
    for (const name of ["station_list", "station_get", "station_create", "station_update", "station_control", "station_publish", "station_unpublish"]) {
      assert.ok(TOOLS.some((tool) => tool.name === name), name);
    }
    const listed = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: { name: string }[] } };
    assert.ok(listed.result.tools.some((tool) => tool.name === "station_publish"));

    const made = await callTool("station_create", { name: "Agent FM", folder: "", idempotencyKey: "agent-1" }, options);
    assert.equal(made.isError, undefined, made.content[0]!.text);
    assert.match(made.content[0]!.text, /private/);
    const id = /\[([a-z0-9]{10})\]/.exec(made.content[0]!.text)![1]!;
    // Asked again: the same station.
    await callTool("station_create", { name: "Agent FM", folder: "", idempotencyKey: "agent-1" }, options);
    assert.equal(store.list().length, 1);

    const noBasis = await callTool("station_publish", { id, visibility: "public" }, options);
    assert.equal(noBasis.isError, true);
    assert.match(noBasis.content[0]!.text, /rights_required/);
    const unlisted = await callTool("station_publish", { id, visibility: "unlisted" }, options);
    assert.match(unlisted.content[0]!.text, /unlisted/);
    const all = await callTool("station_list", {}, options);
    assert.match(all.content[0]!.text, new RegExp(`listen: ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/station/${id}\\?t=`));
    // Starting a station whose file will not play is refused with a reason, not hung.
    const bad = await callTool("station_control", { id: "nope", action: "start" }, options);
    assert.equal(bad.isError, true);
    const other = await callTool("station_list", { server: "https://elsewhere.example" }, { session: null });
    assert.equal(other.isError, true);
    assert.match(other.content[0]!.text, /nixamp login/);
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

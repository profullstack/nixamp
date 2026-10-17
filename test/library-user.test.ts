import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { LibraryError, LibraryIndex, type Probed } from "../src/library-index.ts";
import { ListenerStore } from "../src/library-user.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";
import { libraryTool } from "../src/library-cli.ts";
import { callTool } from "../src/mcp.ts";

const memory = () => ({ read: () => null, write: () => undefined });

test("playlists are their owner's, edits name the revision they saw, and missing items stay", () => {
  const store = new ListenerStore("unused", memory());
  const known = (id: string) => ["a", "b", "c"].includes(id);
  const mine = store.create("alice", { name: " Road trip ", items: ["a", "b"] }, known);
  assert.equal(mine.name, "Road trip");
  assert.equal(mine.revision, 1);
  assert.throws(() => store.playlist("bob", mine.id), (error: LibraryError) => error.status === 404);
  assert.deepEqual(store.playlistsOf("bob"), []);
  assert.throws(() => store.create("alice", { name: "x", items: ["zzz"] }, known), (error: LibraryError) => error.code === "unknown_items");
  const reordered = store.update("alice", mine.id, { items: ["b", "a"], revision: 1 }, known);
  assert.equal(reordered.revision, 2);
  assert.throws(() => store.update("alice", mine.id, { name: "y", revision: 1 }, known), (error: LibraryError) => error.code === "stale_revision" && error.status === 409);
  assert.deepEqual(store.add("alice", mine.id, { items: ["c"], at: 1 }, known).items, ["b", "c", "a"]);
  // An item that goes missing later is not silently dropped.
  assert.deepEqual(store.playlist("alice", mine.id).items, ["b", "c", "a"]);
  store.remove("alice", mine.id);
  assert.deepEqual(store.playlistsOf("alice"), []);

  const queue = store.setQueue("alice", { items: ["a", "b", "c"], device: "laptop" }, known);
  assert.deepEqual([queue.at, queue.position, queue.revision], [0, 0, 1]);
  const moved = store.setQueue("alice", { at: 2, position: 61.27, device: "phone" }, known);
  assert.deepEqual([moved.at, moved.position, moved.device], [2, 61.3, "phone"]);
  assert.throws(() => store.setQueue("alice", { items: ["a"], revision: 1 }, known), (error: LibraryError) => error.code === "stale_revision");
  assert.throws(() => store.setQueue("alice", { at: 9 }, known), (error: LibraryError) => error.code === "invalid_value");
  assert.throws(() => store.setQueue("alice", { repeat: "sometimes" }, known), (error: LibraryError) => error.code === "invalid_value");
  assert.equal(store.queueOf("bob").items.length, 0);
});

test("playlists and the queue over HTTP; a station made from a playlist", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-listener-"));
  const root = join(top, "Music");
  mkdirSync(root, { recursive: true });
  for (const name of ["a.mp3", "b.mp3", "c.mp3"]) writeFileSync(join(root, name), "x");
  const probe = async (path: string): Promise<Probed> => ({
    state: path.endsWith("c.mp3") ? "failed" : "ready", error: "", duration: 60, codec: "mp3", bitrate: 1, sampleRate: 1, channels: 2, video: false, hasArt: false,
    tags: { title: path.split("/").pop()!, artist: "X" },
  });
  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const source = index.addSource(root, "");
  await index.scan(source.id, probe).done;
  const listeners = new ListenerStore(ListenerStore.fileFor(top, 1), memory());
  const engine = { snapshot: () => ({ ...emptySnapshot(), root }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const stations = new StationStore(StationStore.fileFor(top, 1), memory());
  const runner = new StationRunner({ store: stations, channels, pull: async () => false, roots: () => [root] });
  const server = createServer(engine, {
    web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels,
    stations: { store: stations, runner },
    library: { index, probe, retag: () => undefined, listeners },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = (path: string, init: RequestInit = {}) => fetch(`${base}${path}?k=ctl`, init);
  const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const ids = index.search({ state: "all", sort: "path" }).items.map((one) => one.id);
    // Somebody with only the listen link is nobody in particular.
    const anonymous = await fetch(`${base}/api/v1/library/queue?k=lst`);
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { code: string }).code, "sign_in_required");

    const made = await owner("/api/v1/library/playlists", send("POST", { name: "Mix", items: [ids[1], ids[0], ids[2]] }));
    assert.equal(made.status, 201);
    const playlist = ((await made.json()) as { playlist: { id: string; revision: number; items: Array<{ state: string }> } }).playlist;
    assert.deepEqual(playlist.items.map((one) => one.state), ["ready", "ready", "failed"]);
    const stale = await owner(`/api/v1/library/playlists/${playlist.id}`, send("PATCH", { name: "Renamed", revision: 99 }));
    assert.equal(stale.status, 409);
    const renamed = await owner(`/api/v1/library/playlists/${playlist.id}`, send("PATCH", { name: "Renamed", revision: playlist.revision }));
    assert.equal(((await renamed.json()) as { playlist: { name: string } }).playlist.name, "Renamed");

    // The queue, set on one device and picked up on another.
    await owner("/api/v1/library/queue", send("PUT", { items: ids.slice(0, 2), device: "laptop" }));
    await owner("/api/v1/library/queue", send("PATCH", { at: 1, position: 42, device: "laptop" }));
    const resumed = ((await (await owner("/api/v1/library/queue")).json()) as { queue: { at: number; position: number; current: string } }).queue;
    assert.deepEqual([resumed.at, resumed.position, resumed.current], [1, 42, ids[1]]);

    // A station from the playlist: its ready items, in its order; the failed one is left out.
    const station = await owner("/api/v1/stations", send("POST", { name: "From Mix", playlist: playlist.id }));
    assert.equal(station.status, 201, await station.clone().text());
    const items = ((await station.json()) as { station: { items: string[] } }).station.items;
    assert.deepEqual(items, [index.item(ids[1]!)!.path, index.item(ids[0]!)!.path]);
    const missing = await owner("/api/v1/stations", send("POST", { name: "Nope", playlist: "0000000000000000" }));
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code: string }).code, "playlist_not_found");

    // The same through an agent and the CLI.
    const agent = { session: null, stations: { local: { url: base, key: "ctl" } } };
    const created = await callTool("playlist_create", { name: "Agent mix", items: [ids[0]] }, agent);
    assert.match(created.content[0]!.text, /Agent mix: 1 items, revision 1/);
    const agentId = created.content[0]!.text.split(" ")[0]!;
    assert.match((await callTool("playlist_add", { id: agentId, items: [ids[1]] }, agent)).content[0]!.text, /2 items, revision 2/);
    assert.match((await callTool("playlist_list", {}, agent)).content[0]!.text, /Agent mix \(2\)/);
    const log = console.log;
    const printed: string[] = [];
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    try {
      assert.equal(await libraryTool(["playlists", "--url", base, "--key", "ctl"]), 0);
      assert.equal(await libraryTool(["playlist", "nonsense", "--url", base, "--key", "ctl"]), 2);
    } finally {
      console.log = log;
    }
    assert.match(printed.join("\n"), /Agent mix \(2\)/);

    assert.equal((await owner(`/api/v1/library/playlists/${playlist.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await owner(`/api/v1/library/playlists/${playlist.id}`)).status, 404);
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

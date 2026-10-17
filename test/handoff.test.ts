import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { Importer } from "../src/handoff.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore, insideRoots } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });

test("a BitTorrented handoff: copied, checked, indexed, a private draft; retried once; expired links; only copies deleted", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-handoff-"));
  // A stand-in for BitTorrented's grant route: one file per path.
  const bodies: Record<string, Buffer> = { "/g/a": Buffer.alloc(3000, 1), "/g/b": Buffer.alloc(2000, 2), "/g/short": Buffer.alloc(100, 3), "/g/new-c": Buffer.alloc(1500, 4) };
  let hits = 0;
  const bt = createHttp((request, response) => {
    hits++;
    if (request.url === "/g/expired") { response.writeHead(403); response.end(); return; }
    if (request.url === "/g/hop") { response.writeHead(302, { location: "/g/b" }); response.end(); return; }
    const body = bodies[request.url ?? ""];
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "audio/mpeg" });
    response.end(body);
  });
  await new Promise<void>((done) => bt.listen(0, "127.0.0.1", done));
  const btBase = `http://127.0.0.1:${(bt.address() as AddressInfo).port}`;

  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const stations = new StationStore(StationStore.fileFor(top, 1), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store: stations, channels, pull: async () => false, roots: () => index.roots() });
  const probe = async (): Promise<Probed> => ({ state: "ready", error: "", duration: 30, codec: "mp3", bitrate: 128, sampleRate: 44100, channels: 2, video: false, hasArt: false, tags: {} });
  const importer = new Importer(join(top, "handoffs.json"), {
    index, stations, root: join(top, "state", "imports", "bittorrented"), probe,
    guard: async (url) => (url.startsWith(btBase) ? "" : "not BitTorrented"), allowHttp: true,
  });
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store: stations, runner }, importer });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (key: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}?k=${key}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const file = (fileId: string, path: string, size: number, extra: Record<string, unknown> = {}) => ({ fileId, name: `${fileId}.mp3`, size, mediaType: "audio/mpeg", complete: true, url: `${btBase}${path}`, expiresAt: Date.now() + 3_600_000, metadata: { title: `Song ${fileId}`, artist: "Band" }, ...extra });
  const settle = async (id: string) => {
    for (let tries = 0; tries < 100; tries++) {
      const view = (await (await send("ctl", "GET", `/api/v1/integrations/bittorrented/handoffs/${id}`)).json()) as { handoff: { status: string } };
      if (view.handoff.status !== "importing") return view.handoff as unknown as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("never settled");
  };
  try {
    const request = {
      version: 1, idempotencyKey: "bt-user1-abc", name: "Late Night", source: { torrentId: "t1", infohash: "ab".repeat(20) },
      files: [file("a", "/g/a", 3000), file("b", "/g/hop", 2000), file("c", "/g/expired", 1500), file("d", "/g/short", 999)],
    };
    // Only the owner hands music over.
    assert.equal((await send("lst", "POST", "/api/v1/integrations/bittorrented/handoffs", request)).status, 403);
    const made = await send("ctl", "POST", "/api/v1/integrations/bittorrented/handoffs", request);
    assert.equal(made.status, 201, await made.clone().text());
    const { handoff } = (await made.json()) as { handoff: { id: string; stationId: string } };
    // A retry is the same handoff and the same station.
    const again = await send("ctl", "POST", "/api/v1/integrations/bittorrented/handoffs", request);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { handoff: { id: string } }).handoff.id, handoff.id);
    assert.equal(stations.list().length, 1);

    const done = await settle(handoff.id);
    const byId = Object.fromEntries((done["files"] as Array<{ fileId: string; state: string; sha256: string; error: string }>).map((one) => [one.fileId, one]));
    assert.equal(byId["a"]!.state, "ready");
    assert.equal(byId["a"]!.sha256, createHash("sha256").update(bodies["/g/a"]!).digest("hex"));
    assert.equal(byId["b"]!.state, "ready", "followed a redirect the guard allowed");
    assert.equal(byId["c"]!.state, "expired");
    assert.equal(byId["d"]!.state, "failed");
    assert.match(byId["d"]!.error, /incomplete|not the 999/);
    assert.equal(done["status"], "partial");
    assert.equal(JSON.stringify(done).includes(btBase), false, "grant links are never shown back");

    // The draft: private, stopped, and only the copied files are playable.
    const station = stations.get(handoff.stationId)!;
    assert.deepEqual([station.visibility, station.desired], ["private", "stopped"]);
    assert.equal(runner.playable(station).length, 2);
    assert.ok(station.items.every((one) => insideRoots(one, index.roots()) || !existsSync(one)));
    // BitTorrented's tags fill in where the file says nothing.
    assert.deepEqual(index.search({ artist: "Band", sort: "title" }).items.map((one) => one.override.title), ["Song a", "Song b"]);

    // A new link for the expired file.
    const retried = await send("ctl", "POST", `/api/v1/integrations/bittorrented/handoffs/${handoff.id}/retry`, { files: [{ fileId: "c", url: `${btBase}/g/new-c`, expiresAt: Date.now() + 60_000 }] });
    assert.equal(retried.status, 200);
    const after = await settle(handoff.id);
    assert.equal((after["files"] as Array<{ fileId: string; state: string }>).find((one) => one.fileId === "c")!.state, "ready");
    assert.equal(runner.playable(stations.get(handoff.stationId)!).length, 3);
    assert.equal(readdirSync(join(top, "state", "imports", "bittorrented", handoff.id)).some((one) => one.endsWith(".part")), false);

    // Refusals.
    const bad = await send("ctl", "POST", "/api/v1/integrations/bittorrented/handoffs", { ...request, idempotencyKey: "x2", files: [file("z", "/g/a", 3000, { name: "notes.txt", mediaType: "text/plain" })] });
    assert.equal(((await bad.json()) as { code: string }).code, "not_audio");
    const noKey = await send("ctl", "POST", "/api/v1/integrations/bittorrented/handoffs", { ...request, idempotencyKey: "" });
    assert.equal(((await noKey.json()) as { code: string }).code, "idempotency_key_required");

    // Deleting the handoff removes its copies, nothing else.
    const removed = await (await send("ctl", "DELETE", `/api/v1/integrations/bittorrented/handoffs/${handoff.id}`)).json() as { copiesRemoved: number };
    assert.equal(removed.copiesRemoved, 3);
    assert.equal(existsSync(join(top, "state", "imports", "bittorrented", handoff.id)), false);
    assert.ok(hits > 0);
  } finally {
    for (const one of [server, bt]) {
      const closing = new Promise<void>((done) => one.close(() => done()));
      (one as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closing;
    }
    rmSync(top, { recursive: true, force: true });
  }
});

test("only https grant links, unless told otherwise for a test", () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-handoff-https-"));
  try {
    const importer = new Importer(join(top, "h.json"), {
      index: new LibraryIndex(join(top, "l.json"), memory()), stations: new StationStore(join(top, "s.json"), memory()),
      root: join(top, "imports"), probe: async () => { throw new Error("unused"); }, guard: async () => "",
    });
    assert.throws(() => importer.create({ version: 1, idempotencyKey: "k", files: [{ fileId: "a", name: "a.mp3", size: 1, mediaType: "audio/mpeg", url: "http://bt.example/g/a" }] }, "owner"), /https only/);
    assert.throws(() => importer.create({ version: 2, idempotencyKey: "k", files: [] }, "owner"), /version 1/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { ListenerShares } from "../src/listener-shares.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });

test("listener shares: declared, fetched, checked by AI, aired by genre, reported off the air", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-shares-"));
  // Somebody's website with music on it, and a page that is not music.
  const files: Record<string, Buffer> = { "/my-song.mp3": Buffer.alloc(5000, 1), "/hit.mp3": Buffer.alloc(6000, 2), "/third.mp3": Buffer.alloc(7000, 3) };
  const site = createHttp((request, response) => {
    if (request.url === "/page") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html></html>"); return; }
    const body = files[request.url ?? ""];
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "audio/mpeg" });
    response.end(body);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const store = new StationStore(StationStore.fileFor(top, 1), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const skipped: string[] = [];
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => index.roots() });
  (runner as unknown as { skip: (id: string) => void }).skip = (id) => { skipped.push(id); };
  const probe = async (path: string): Promise<Probed> => ({
    state: "ready", error: "", duration: 180, codec: "mp3", bitrate: 128, sampleRate: 44100, channels: 2, video: false, hasArt: false,
    tags: path.includes("hit") ? { title: "Famous Hit", artist: "Big Label Star" } : { title: "", artist: "" },
  });
  let playing = "";
  const shares = new ListenerShares(join(top, "shares.json"), {
    index, store, runner, probe, root: join(top, "shares"), owner: "chovy",
    guard: async (url) => (url.startsWith(siteBase) ? "" : "not that site"),
    mayStart: () => false,
    nowPlaying: () => playing,
    canAsk: () => true,
    ask: async (options) => {
      const said = JSON.parse(options.prompt) as { title: string; file: string };
      return said.title === "Famous Hit"
        ? { model: "test-model", value: { verdict: "doubt", reason: "looks like a major-label single", genre: "Pop" } }
        : { model: "test-model", value: { verdict: "clear", reason: "independent", genre: "Electronic", title: said.file.replace(".mp3", "") } };
    },
  });
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, shares } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const owner = (method: string, path: string, body?: unknown) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}k=ctl`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const settle = async (status: string): Promise<{ state: string; genre: string; reason: string }> => {
    for (let tries = 0; tries < 200; tries++) {
      const view = (await (await fetch(`${base}${status}`)).json()) as { share: { state: string; genre: string; reason: string } };
      if (view.share.state !== "fetching" && view.share.state !== "checking") return view.share;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("never settled");
  };
  const declared = { basis: "owned", agree: true };
  try {
    // Closed until the owner opens it; no key needed to ask.
    assert.equal(((await (await fetch(`${base}/api/v1/share`)).json()) as { open: boolean }).open, false);
    assert.equal((await post("/api/v1/share", { ...declared, url: `${siteBase}/my-song.mp3` })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/stations/shares?k=lst`)).status, 403, "the listen key does not moderate");
    assert.equal((await owner("POST", "/api/v1/stations/shares", { open: true, perHour: 4 })).status, 200);

    // Saying why it may be broadcast, and meaning it, come first.
    assert.equal(((await (await post("/api/v1/share", { url: `${siteBase}/my-song.mp3`, agree: true })).json()) as { code: string }).code, "rights_required");
    assert.equal(((await (await post("/api/v1/share", { url: `${siteBase}/my-song.mp3`, basis: "owned" })).json()) as { code: string }).code, "agreement_required");

    // A clear verdict airs on its genre's shared station, public on the guide.
    const one = await post("/api/v1/share", { ...declared, url: `${siteBase}/my-song.mp3`, by: "dj" });
    assert.equal(one.status, 202);
    const first = (await one.json()) as { share: { id: string }; token: string; status: string };
    const aired = await settle(first.status);
    assert.equal(aired.state, "approved");
    assert.equal(aired.genre, "Electronic");
    const station = store.byAuto("share:Electronic")!;
    assert.equal(station.name, "Shared: Electronic");
    assert.equal(station.visibility, "public");
    assert.equal(station.rights?.basis, "permission");
    const guide = (await (await fetch(`${base}/api/v1/stations/guide`)).json()) as { stations: Array<{ name: string; group: string }> };
    assert.deepEqual(guide.stations.map((s) => [s.name, s.group]), [["Shared: Electronic", "shared"]]);
    // Another sharer's token does not open it.
    assert.equal((await fetch(`${base}/api/v1/share/${first.share.id}?t=nope`)).status, 404);

    // The same link twice is one share.
    assert.equal((await post("/api/v1/share", { ...declared, url: `${siteBase}/my-song.mp3` })).status, 409);
    // A web page is not a music file.
    const page = (await (await post("/api/v1/share", { ...declared, url: `${siteBase}/page` })).json()) as { status: string };
    assert.match((await settle(page.status)).reason, /web page/);

    // Doubt waits for the owner, who may put it on.
    const hit = (await (await post("/api/v1/share", { ...declared, url: `${siteBase}/hit.mp3` })).json()) as { share: { id: string }; status: string };
    const held = await settle(hit.status);
    assert.equal(held.state, "held");
    assert.match(held.reason, /major-label/);
    assert.equal(store.byAuto("share:Pop"), undefined, "nothing airs while it waits");
    const waiting = (await (await owner("GET", "/api/v1/stations/shares?state=held")).json()) as { shares: Array<{ id: string; token?: string }> };
    assert.deepEqual(waiting.shares.map((s) => s.id), [hit.share.id]);
    assert.equal(waiting.shares[0]!.token, undefined, "the sharer's token is theirs alone");
    assert.equal((await owner("POST", `/api/v1/stations/shares/${hit.share.id}/approve`, {})).status, 200);
    for (let tries = 0; tries < 50 && !store.byAuto("share:Pop"); tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.byAuto("share:Pop")!.items.length, 1);

    // An upload, as the body: the hourly limit (4) is reached with it.
    const up = await fetch(`${base}/api/v1/share/upload?basis=creative-commons&agree=1&name=${encodeURIComponent("upload song.mp3")}`, { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: Buffer.alloc(9000, 9) });
    assert.equal(up.status, 202, await up.clone().text());
    assert.equal((await settle(((await up.json()) as { status: string }).status)).state, "approved");
    assert.equal(store.byAuto("share:Electronic")!.items.length, 2);
    assert.equal(((await (await post("/api/v1/share", { ...declared, url: `${siteBase}/third.mp3` })).json()) as { code: string }).code, "rate_limited");

    // A listener reports what is playing: off the rotation at once, and skipped.
    playing = shares.get(first.share.id)!.file;
    const report = (await (await post("/api/v1/share/report", { station: station.id, reason: "not theirs" })).json()) as { reported: boolean };
    assert.equal(report.reported, true);
    for (let tries = 0; tries < 50 && store.byAuto("share:Electronic")!.items.length !== 1; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.byAuto("share:Electronic")!.items.length, 1);
    assert.ok(!store.byAuto("share:Electronic")!.items.includes(playing));
    for (let tries = 0; tries < 50 && skipped.length === 0; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(skipped, [station.id]);
    assert.equal(shares.get(first.share.id)!.state, "reported");

    // The sharer withdraws the Pop track: its copy goes and its station leaves the guide.
    const popFile = shares.get(hit.share.id)!.file;
    const token = shares.get(hit.share.id)!.token;
    assert.equal((await fetch(`${base}/api/v1/share/${hit.share.id}?t=${token}`, { method: "DELETE" })).status, 200);
    for (let tries = 0; tries < 50 && store.byAuto("share:Pop")!.listed; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.byAuto("share:Pop")!.listed, false);
    assert.equal(existsSync(popFile), false);
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    site.close();
    rmSync(top, { recursive: true, force: true });
  }
});

test("without a model every share waits for the owner; refuse is turned away", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-shares2-"));
  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const store = new StationStore(StationStore.fileFor(top, 1), memory());
  const runner = new StationRunner({ store, channels: new Channels({ ffmpeg: ["ffmpeg"] }), pull: async () => false, roots: () => index.roots() });
  const probe = async (): Promise<Probed> => ({ state: "ready", error: "", duration: 90, codec: "mp3", bitrate: 128, sampleRate: 44100, channels: 2, video: false, hasArt: false, tags: { genre: "Punk Rock" } });
  let model = false;
  const shares = new ListenerShares(join(top, "shares.json"), {
    index, store, runner, probe, root: join(top, "shares"), owner: "", guard: async () => "", mayStart: () => false, nowPlaying: () => "",
    canAsk: () => model,
    ask: async () => ({ model: "m", value: { verdict: "refuse", reason: "it is an advert", genre: "Pop" } }),
  });
  shares.configure({ open: true });
  const { Readable } = await import("node:stream");
  const upload = (bytes: number) => Object.assign(Readable.from([Buffer.alloc(bytes, bytes % 251)]), { headers: { "content-type": "audio/mpeg" } }) as never;
  try {
    const waiting = await shares.fromUpload(upload(3000), { basis: "owned", agree: "1", name: "a.mp3" }, "1.2.3.4");
    for (let tries = 0; tries < 100 && shares.get(waiting.id)!.state === "checking"; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(shares.get(waiting.id)!.state, "held");
    assert.equal(shares.get(waiting.id)!.genre, "Punk", "the file's own genre tag files it");
    model = true;
    const refused = await shares.fromUpload(upload(4000), { basis: "owned", agree: "1", name: "b.mp3" }, "1.2.3.4");
    for (let tries = 0; tries < 100 && shares.get(refused.id)!.state === "checking"; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(shares.get(refused.id)!.state, "rejected");
    assert.equal(existsSync(shares.get(refused.id)!.file), false, "a refused copy is not kept");
    shares.configure({ maxMb: 1 });
    await assert.rejects(shares.fromUpload(upload(2 * 1024 * 1024), { basis: "owned", agree: "1", name: "c.mp3" }, "1.2.3.4"), (error: Error & { code?: string }) => error.code === "too_big");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

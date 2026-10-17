import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Track } from "../src/audio.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { libraryTool } from "../src/library-cli.ts";
import { callTool } from "../src/mcp.ts";

const CONTROL = "ctl-key";
const LISTEN = "lst-key";

test("library over HTTP: the owner manages, the listen link reads without paths", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-libhttp-"));
  const root = join(top, "Music");
  mkdirSync(join(root, "Band", "LP"), { recursive: true });
  writeFileSync(join(root, "Band", "LP", "01 Song.mp3"), Buffer.alloc(10_000, 7));
  writeFileSync(join(root, "Band", "LP", "02 Other.mp3"), Buffer.alloc(5_000, 9));
  const probe = async (path: string): Promise<Probed> => ({
    state: "ready", error: "", duration: 60, codec: "mp3", bitrate: 128, sampleRate: 44100, channels: 2, video: false, hasArt: false,
    tags: { title: path.includes("01") ? "Song" : "Other", artist: "Band", album: "LP", track: path.includes("01") ? 1 : 2, genre: "Pop" },
  });
  const retagged: Track[] = [];
  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1));
  const engine = { snapshot: () => ({ ...emptySnapshot(), root }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: CONTROL, listenKey: LISTEN, library: { index, probe, retag: (tracks) => retagged.push(...tracks) } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (key: string) => (path: string, init: RequestInit = {}) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}k=${key}`, init);
  const owner = as(CONTROL), listener = as(LISTEN);
  const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/v1/library`)).status, 401);
    // Only the owner adds a source; a forbidden one is refused by name.
    assert.equal((await listener("/api/v1/library/sources", send("POST", { root }))).status, 403);
    const bad = await owner("/api/v1/library/sources", send("POST", { root: "/" }));
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, "forbidden_root");
    const added = await owner("/api/v1/library/sources", send("POST", { root }));
    assert.equal(added.status, 201);
    const { source, job } = await added.json() as { source: { id: string }; job: { jobId: string } };
    let state = "running";
    for (let tries = 0; state === "running" && tries < 100; tries++) {
      state = ((await (await owner(`/api/v1/library/jobs/${job.jobId}`)).json()) as { job: { status: string } }).job.status;
      if (state === "running") await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(state, "done");
    assert.equal(retagged.length, 2, "the player was told the tags");

    // Search, as the listener: places inside the library, never paths.
    const found = await (await listener("/api/v1/library/items?q=band&sort=album")).json() as { items: Array<Record<string, unknown>>; total: number };
    assert.equal(found.total, 2);
    assert.deepEqual(found.items.map((one) => one["title"]), ["Song", "Other"]);
    assert.equal(found.items[0]!["rel"], "Band/LP/01 Song.mp3");
    assert.equal(JSON.stringify(found).includes(top), false);
    assert.equal(found.items[0]!["override"], undefined);
    const mine = await (await owner("/api/v1/library/items?q=song")).json() as { items: Array<{ path: string; id: string }> };
    assert.equal(mine.items[0]!.path, join(root, "Band", "LP", "01 Song.mp3"));
    const albums = await (await listener("/api/v1/library/browse/albums")).json() as { groups: unknown[] };
    assert.deepEqual(albums.groups, [{ name: "LP", count: 2, artist: "Band" }]);
    assert.equal((await listener("/api/v1/library/browse/planets")).status, 404);
    const listed = await (await listener("/api/v1/library/sources")).json() as { sources: Array<Record<string, unknown>> };
    assert.equal(listed.sources[0]!["root"], undefined);

    // Corrections are the owner's, and reach the player.
    const id = mine.items[0]!.id;
    assert.equal((await listener(`/api/v1/library/items/${id}`, send("PATCH", { title: "x" }))).status, 403);
    const corrected = await owner(`/api/v1/library/items/${id}`, send("PATCH", { title: "Song (Remastered)" }));
    assert.equal(((await corrected.json()) as { item: { title: string } }).item.title, "Song (Remastered)");
    assert.equal(retagged.at(-1)?.title, "Song (Remastered)");

    // The file itself, in ranges, never in a shared cache.
    const part = await listener(`/api/v1/library/items/${id}/stream`, { headers: { range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.match(part.headers.get("cache-control") ?? "", /^private/);

    // The same through the CLI and an agent.
    const printed: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { printed.push(args.join(" ")); };
    try {
      assert.equal(await libraryTool(["search", "other", "--json", "--url", base, "--key", CONTROL]), 0);
      assert.equal((JSON.parse(printed.join("\n")) as { total: number }).total, 1);
      printed.length = 0;
      assert.equal(await libraryTool(["fix", id, "--url", base, "--key", LISTEN, "--title", "nope"]), 1);
      assert.equal(await libraryTool(["fix", id, "--url", base, "--key", CONTROL]), 2);
      assert.equal(await libraryTool(["status", "--url", "http://127.0.0.1:9", "--key", CONTROL]), 3);
    } finally {
      console.log = log;
      console.error = error;
    }
    const agent = await callTool("library_search", { q: "song" }, { session: null, stations: { local: { url: base, key: CONTROL } } });
    assert.match(agent.content[0]!.text, /Band — Song \(Remastered\)/);
    const groups = await callTool("library_browse", { kind: "artists" }, { session: null, stations: { local: { url: base, key: CONTROL } } });
    assert.match(groups.content[0]!.text, /^Band \(2\)$/);

    // Removing the source forgets it; the files stay.
    assert.equal((await listener(`/api/v1/library/sources/${source.id}`, { method: "DELETE" })).status, 403);
    const removed = await (await owner(`/api/v1/library/sources/${source.id}`, { method: "DELETE" })).json() as { forgotten: number; filesTouched: number };
    assert.deepEqual([removed.forgotten, removed.filesTouched], [2, 0]);
    assert.ok(existsSync(join(root, "Band", "LP", "01 Song.mp3")));
    assert.equal((await owner(`/api/v1/library/items/${id}`)).status, 404);
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

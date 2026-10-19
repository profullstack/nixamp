import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, pullChannel, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { station as stationCli } from "../src/station-cli.ts";
import { StationError, StationStore, channelOf, insideRoots, shuffled } from "../src/stations.ts";
import { StationUsage } from "../src/station-metering.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const CONTROL = "control-key-for-tests";
const LISTEN = "listen-key-for-tests";

function tone(file: string, seconds: number, frequency: number, title: string): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    "-metadata", `title=${title}`, "-metadata", "artist=Test Artist", "-c:a", "libmp3lame", "-b:a", "64k", file]);
}

/** A library of files on disk, as the engine reports it. */
function libraryEngine(root: string, files: string[]): Engine {
  const tracks = files.map((file, at) => ({ title: `Song ${at + 1}`, artist: "Test Artist", album: "Test Album", duration: 0 }));
  const engine = {
    snapshot: (withTracks = true) => ({ ...emptySnapshot(), revision: 1, root, trackCount: files.length, ...(withTracks ? { tracks } : { tracks: undefined }) }),
    command: () => undefined,
    subscribe: () => () => undefined,
    trackPath: (index: number) => files[index],
  };
  return engine as unknown as Engine;
}

test("a new station is private, stopped and unlisted; public asks on what basis", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-stations-"));
  try {
    const file = StationStore.fileFor(dir, 4321);
    const store = new StationStore(file);
    const station = store.create({ name: "  Late Night  " }, ["/music/a.mp3"], "acct", 1000, "key-1");
    assert.equal(station.name, "Late Night");
    assert.equal(station.visibility, "private");
    assert.equal(station.listed, false);
    assert.equal(station.desired, "stopped");
    assert.equal(station.bitrate, 128);
    assert.match(station.id, /^[a-z0-9]{10}$/);
    // The same key finds the same station: asking twice makes it once.
    assert.equal(store.byIdempotencyKey("key-1")?.id, station.id);

    assert.throws(() => store.create({ name: "" }, ["/x"], ""), (error: StationError) => error.code === "name_required");
    assert.throws(() => store.create({ name: "x" }, [], ""), (error: StationError) => error.code === "empty_station");
    assert.throws(() => store.setAccess(station.id, { visibility: "public" }, "acct"), (error: StationError) => error.code === "rights_required" && error.status === 409);

    // Listed needs public: an unlisted station is never in the directory.
    const unlisted = store.setAccess(station.id, { visibility: "unlisted", listed: true }, "acct").station;
    assert.equal(unlisted.listed, false);
    const tokenBefore = unlisted.listenToken;
    const published = store.setAccess(station.id, { visibility: "public", listed: true, rights: { basis: "owned", note: "my own recordings" } }, "acct").station;
    assert.equal(published.listed, true);
    assert.equal(published.rights?.basis, "owned");
    assert.equal(published.listenToken, tokenBefore, "unlisted to public keeps the link working");

    // Private again: the old link stops working.
    const { station: hidden, revoked } = store.setAccess(station.id, { visibility: "private" }, "acct");
    assert.equal(revoked, true);
    assert.equal(hidden.listed, false);
    assert.notEqual(hidden.listenToken, tokenBefore);

    // Written down, and read back the same.
    store.setDesired(station.id, "running");
    const again = new StationStore(file);
    assert.equal(again.get(station.id)?.desired, "running");
    assert.equal(again.get(station.id)?.visibility, "private");
    assert.equal((readFileSync(file, "utf8").match(/"id":/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a station's files have to be inside the library, after symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-roots-"));
  try {
    const library = join(dir, "library");
    const outside = join(dir, "secret.mp3");
    execFileSync("mkdir", ["-p", library]);
    writeFileSync(join(library, "in.mp3"), "x");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(library, "link.mp3"));
    assert.equal(insideRoots(join(library, "in.mp3"), [library]), true);
    assert.equal(insideRoots(join(library, "link.mp3"), [library]), false);
    assert.equal(insideRoots(join(library, "..", "secret.mp3"), [library]), false);
    assert.equal(insideRoots(join(library, "missing.mp3"), [library]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shuffle is one order, a permutation", () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const order = shuffled(50, random);
  assert.deepEqual([...order].sort((a, b) => a - b), [...Array(50).keys()]);
  assert.notDeepEqual(order, [...Array(50).keys()]);
});

test("stations over HTTP: owner manages, a link only listens, private means private", { skip: !available, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-station-http-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-station-state-"));
  const files = [join(root, "one.mp3"), join(root, "two.mp3")];
  tone(files[0]!, 20, 440, "First Song");
  tone(files[1]!, 20, 660, "Second Song");
  const engine = libraryEngine(root, files);
  const channels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: (info) => runner.onChannelEnd(info) });
  const store = new StationStore(StationStore.fileFor(state, 1));
  const runner: StationRunner = new StationRunner({
    store,
    channels,
    pull: async (id, name, list, known) => Boolean(await pullChannel(channels, ["ffprobe"], id, name, list[0]!, [], "", { playlist: list, live: true, ...known })),
    roots: () => [root],
  });
  const usage = new StationUsage(StationUsage.fileFor(state, 1));
  const limits = { stationListeners: 2, totalListeners: 10, runningStations: 1, monthlyBytes: 0 };
  const server = createServer(engine, { web: null, media: true, version: "test", key: CONTROL, listenKey: LISTEN, channels, stations: { store, runner, usage, limits } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const asOwner = (path: string, init: RequestInit = {}) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}k=${CONTROL}`, init);
  const asListener = (path: string, init: RequestInit = {}) => fetch(`${base}${path}${path.includes("?") ? "&" : "?"}k=${LISTEN}`, init);
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // Made by the owner, from the library by folder.
    const made = await asOwner("/api/v1/stations", { ...post({ name: "Test FM", folder: "", repeat: true }), headers: { "content-type": "application/json", "idempotency-key": "make-once" } });
    assert.equal(made.status, 201);
    const { station } = await made.json() as { station: { id: string; visibility: string; state: string; listenToken: string; links: { stream: string; state: string; m3u: string } } };
    assert.equal(station.visibility, "private");
    assert.equal(station.state, "stopped");
    // Asked again with the same key: the same station, not a second one.
    const twice = await asOwner("/api/v1/stations", { ...post({ name: "Test FM", folder: "" }), headers: { "content-type": "application/json", "idempotency-key": "make-once" } });
    assert.equal(twice.status, 200);
    assert.equal(((await twice.json()) as { station: { id: string } }).station.id, station.id);
    assert.equal(store.list().length, 1);

    // The server's listen link cannot manage stations, or see them.
    assert.equal((await asListener("/api/v1/stations")).status, 403);
    assert.equal((await asListener(`/api/v1/stations/${station.id}/start`, post({}))).status, 403);
    assert.equal((await fetch(`${base}/api/v1/stations`)).status, 401);

    // Private: the station's own link does not open it yet.
    const stateUrl = `${base}/api/v1/stations/${station.id}/state?t=${encodeURIComponent(station.listenToken)}`;
    assert.equal((await fetch(stateUrl)).status, 404);

    // Start it, and make it unlisted.
    const started = await asOwner(`/api/v1/stations/${station.id}/start`, post({}));
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await asOwner(`/api/v1/stations/${station.id}/access`, post({ visibility: "unlisted" }))).status, 200);
    const shown = await fetch(stateUrl);
    assert.equal(shown.status, 200);
    const publicState = await shown.json() as Record<string, unknown>;
    assert.equal(publicState["name"], "Test FM");
    // Nothing of the machine: no paths, no tokens, no library.
    const text = JSON.stringify(publicState);
    assert.doesNotMatch(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /listenToken|items|\.mp3/);
    // A wrong token is the same answer as no station.
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/state?t=wrong`)).status, 404);

    // Two listeners hear the same program.
    const streamUrl = `${base}/api/v1/stations/${station.id}/stream?t=${encodeURIComponent(station.listenToken)}`;
    const deadline = Date.now() + 20_000;
    while (!channels.has(channelOf(station.id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const first = await fetch(streamUrl);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /audio\/mpeg/);
    const second = await fetch(streamUrl);
    const readSome = async (response: Response, bytes: number) => {
      const reader = response.body!.getReader();
      let got = 0;
      while (got < bytes) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
      }
      return { reader, got };
    };
    const a = await readSome(first, 4096);
    const b = await readSome(second, 4096);
    assert.ok(a.got >= 4096 && b.got >= 4096, `heard ${a.got} and ${b.got} bytes`);
    // A third is over this station's limit of two, and is told so.
    const third = await fetch(streamUrl);
    assert.equal(third.status, 503);
    assert.equal(((await third.json()) as { code: string }).code, "station_full");
    assert.equal(third.headers.get("retry-after"), "60");
    // Delivery is counted, and the owner sees it.
    const metrics = await (await asOwner(`/api/v1/stations/${station.id}/metrics`)).json() as { listeners: number; month: { bytes: number; peakListeners: number } };
    assert.equal(metrics.listeners, 2);
    assert.ok(metrics.month.bytes >= 8192, `counted ${metrics.month.bytes} bytes`);
    assert.equal(metrics.month.peakListeners, 2);
    // One station running is this server's limit: a second is refused by name.
    const other = await (await asOwner("/api/v1/stations", post({ name: "Second FM", folder: "" }))).json() as { station: { id: string } };
    const tooMany = await asOwner(`/api/v1/stations/${other.station.id}/start`, post({}));
    assert.equal(tooMany.status, 409);
    assert.equal(((await tooMany.json()) as { code: string }).code, "too_many_running");
    await asOwner(`/api/v1/stations/${other.station.id}`, { method: "DELETE" });
    await b.reader.cancel();

    // Now playing is the tags, not the file name.
    const live = await (await fetch(stateUrl)).json() as { state: string; nowPlaying: { title: string } | null; format: { bitrateKbps: number } };
    assert.equal(live.state, "live");
    assert.equal(live.format.bitrateKbps, 128);
    // From the file's own tags, read as it went on: not the library's guess, not a file name.
    assert.match(live.nowPlaying?.title ?? "", /^(First|Second) Song$/);

    // Skip is the owner's: a station's link does not even reach it.
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/skip?t=${encodeURIComponent(station.listenToken)}`, post({}))).status, 401);
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/stream?t=${encodeURIComponent(station.listenToken)}`, post({}))).status, 405);
    // Now playing as it changes, over the station's own link.
    const events = await fetch(`${base}/api/v1/stations/${station.id}/events?t=${encodeURIComponent(station.listenToken)}`);
    assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
    const eventReader = events.body!.getReader();
    let eventText = "";
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    const nextEvent = async (name: string, ms: number): Promise<Record<string, unknown> | null> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const match = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`).exec(eventText);
        if (match) {
          eventText = eventText.slice(match.index + match[0].length);
          return JSON.parse(match[1]!) as Record<string, unknown>;
        }
        // One read at a time: a read that loses the race still lands later.
        pending ??= eventReader.read();
        const raced = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 250))]);
        if (raced === null) continue;
        pending = null;
        if (raced.done) return null;
        if (raced.value) eventText += new TextDecoder().decode(raced.value);
      }
      return null;
    };
    const hello = await nextEvent("hello", 5000);
    assert.equal(hello?.["station"], station.id);
    assert.equal((await asOwner(`/api/v1/stations/${station.id}/skip`, post({}))).status, 200);
    const moved = await nextEvent("now", 10_000);
    assert.ok(moved, "a now event after the skip");
    assert.match(String((moved!["nowPlaying"] as { title?: string } | null)?.title ?? ""), /^(First|Second) Song$/);
    await eventReader.cancel();

    // An m3u for another player, naming the stream.
    const m3u = await fetch(`${base}/api/v1/stations/${station.id}/listen.m3u?t=${encodeURIComponent(station.listenToken)}`);
    assert.match(await m3u.text(), new RegExp(`^#EXTM3U\\n#EXTINF:-1,Test FM\\n${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/v1/stations/${station.id}/stream\\?t=`));

    // The station is not a channel the server's listen link can reach.
    const listed = await (await asListener("/api/channels")).json() as { channels: Array<{ id: string }> };
    assert.equal(listed.channels.some((one) => one.id === channelOf(station.id)), false);
    assert.equal((await asListener(`/api/channels/${channelOf(station.id)}`)).status, 404);

    // Private again: the listener still connected is let go, and the old link is dead.
    const hidden = await asOwner(`/api/v1/stations/${station.id}/access`, post({ visibility: "private" }));
    assert.equal(((await hidden.json()) as { dropped: number }).dropped, 1);
    const ended = await a.reader.read().then(async (one) => {
      for (let tries = 0; !one.done && tries < 200; tries++) one = await a.reader.read();
      return one.done;
    }).catch(() => true);
    assert.equal(ended, true);
    assert.equal((await fetch(stateUrl)).status, 404);
    assert.equal((await fetch(streamUrl)).status, 404);

    // The page a link opens: served without the server's key, locked down.
    const page = await fetch(`${base}/station/${station.id}?t=x`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'; script-src 'sha256-/);
    const inline = await page.text();
    assert.match(inline, /id="play"/);
    // No media element of its own: in-page playback is @profullstack/player, in the built page.
    assert.doesNotMatch(inline, /<audio|<video|new Audio/);
    assert.equal((await fetch(`${base}/station/../api/state`)).status, 401);

    // The CLI: made private, and publish refuses without a basis.
    const printed: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...args: unknown[]) => { printed.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { printed.push(args.join(" ")); };
    try {
      assert.equal(await stationCli(["create", "--name", "CLI FM", "--items", "0", "--json", "--url", base, "--key", CONTROL]), 0);
      const made = JSON.parse(printed.join("\n")) as { station: { id: string; visibility: string } };
      assert.equal(made.station.visibility, "private");
      printed.length = 0;
      assert.equal(await stationCli(["publish", made.station.id, "--url", base, "--key", CONTROL]), 1);
      assert.match(printed.join("\n"), /rights_required/);
      assert.equal(await stationCli(["publish", made.station.id, "--basis", "owned", "--json", "--url", base, "--key", CONTROL]), 0);
      assert.equal(await stationCli(["start", "--url", base, "--key", CONTROL]), 2);
      assert.equal(await stationCli(["list", "--url", "http://127.0.0.1:9", "--key", CONTROL]), 3);
      assert.equal(await stationCli(["delete", made.station.id, "--url", base, "--key", CONTROL]), 0);
    } finally {
      console.log = log;
      console.error = error;
    }

    // Stopped by its owner, and stays stopped across a restart.
    assert.equal((await asOwner(`/api/v1/stations/${station.id}/stop`, post({}))).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(channels.has(channelOf(station.id)), false);
    const reloaded = new StationStore(StationStore.fileFor(state, 1));
    assert.equal(reloaded.get(station.id)?.desired, "stopped");
    const restoredChannels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"] });
    const restored = new StationRunner({ store: reloaded, channels: restoredChannels, pull: async () => { throw new Error("must not start"); }, roots: () => [root] });
    restored.restore();
    assert.equal(restored.observed(station.id), "stopped");
  } finally {
    channels.stopAll();
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("a station whose renderer dies comes back under the same id", { skip: !available, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-station-recover-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-station-state-"));
  try {
    const file = join(root, "one.mp3");
    tone(file, 30, 440, "Only Song");
    const store = new StationStore(StationStore.fileFor(state, 2));
    let pulls = 0;
    const channels: Channels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: (info) => runner.onChannelEnd(info) });
    const runner: StationRunner = new StationRunner({
      store,
      channels,
      pull: async (id, name, list, known) => {
        pulls++;
        return Boolean(await pullChannel(channels, ["ffprobe"], id, name, list[0]!, [], "", { playlist: list, live: true, ...known }));
      },
      roots: () => [root],
    });
    const station = store.create({ name: "Recover FM" }, [file], "");
    await runner.start(station.id);
    assert.equal(runner.observed(station.id), "live");
    // Killed from outside, the way a crash would: not a stop the owner asked for.
    (channels as unknown as { open: Map<string, { close(): void }> }).open.get(channelOf(station.id))!.close();
    assert.equal(store.get(station.id)?.desired, "running");
    const deadline = Date.now() + 15_000;
    while (pulls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(pulls, 2, "brought back after the first backoff");
    while (!channels.has(channelOf(station.id)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(channels.has(channelOf(station.id)), true);
    runner.stop(station.id);
    assert.equal(runner.observed(station.id), "stopped");
    channels.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("a station says it is video when its channel carries video, and PATCH can set it", async () => {
  const { publicView } = await import("../src/station-routes.ts");
  const dir = mkdtempSync(join(tmpdir(), "nixamp-stations-"));
  try {
    const store = new StationStore(StationStore.fileFor(dir, 4321));
    const made = store.create({ name: "Lessons" }, ["/media/lesson1.mp4"], "");
    assert.equal(made.video, false);
    let kind: "audio" | "video" | undefined = "video";
    const ctx = {
      store,
      runner: { observed: () => "live", listeners: () => 0 },
      channels: { info: () => undefined, tagsOf: () => undefined, kindOf: () => kind },
      trackFor: () => null,
    } as unknown as Parameters<typeof publicView>[0];
    // Made by hand without the flag, but the channel is moving picture.
    assert.equal(publicView(ctx, made).kind, "video");
    assert.equal(publicView(ctx, made).format?.codec, "h264+aac");
    kind = "audio";
    assert.equal(publicView(ctx, made).kind, "audio");
    assert.equal(store.update(made.id, { video: true }, null).video, true);
    assert.equal(publicView(ctx, store.get(made.id)!).kind, "video");
    assert.equal(new StationStore(StationStore.fileFor(dir, 4321)).get(made.id)?.video, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a station's link opens the built page, with the player, when the server has the web build", async () => {
  const web = mkdtempSync(join(tmpdir(), "nixamp-station-web-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-station-state-"));
  writeFileSync(join(web, "station.html"), "<!doctype html><div id=\"stage\"></div>");
  const channels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"] });
  const store = new StationStore(StationStore.fileFor(state, 1));
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [web] });
  const server = createServer(libraryEngine(web, []), { web, media: true, version: "test", key: CONTROL, listenKey: LISTEN, channels, stations: { store, runner } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/station/abcdefghij?t=x`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="stage"/);
    const policy = page.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /media-src 'self' blob:/);
    assert.match(policy, /frame-ancestors 'none'/);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(web, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("the server going down is not a station restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-stations-close-"));
  try {
    const store = new StationStore(StationStore.fileFor(dir, 4321));
    const station = store.create({ name: "Steady FM" }, ["/media/a.mp3"], "");
    store.setDesired(station.id, "running", Date.now());
    const restarts: string[] = [];
    const runner = new StationRunner({
      store,
      channels: new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"] }),
      pull: async () => false,
      roots: () => ["/media"],
      onRestart: (id) => restarts.push(id),
    });
    const ended = { id: channelOf(station.id), error: "" } as unknown as Parameters<StationRunner["onChannelEnd"]>[0];
    runner.onChannelEnd(ended);
    assert.deepEqual(restarts, [station.id], "an end nobody asked for is a restart");
    runner.close();
    runner.onChannelEnd(ended);
    assert.deepEqual(restarts, [station.id], "ends while the server shuts down are not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

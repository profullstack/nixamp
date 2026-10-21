import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { PlaylistInputStream } from "../src/playlist-input.ts";
import { createServer, pullChannel, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore, channelOf } from "../src/stations.ts";
import { stationIdleSeconds } from "../src/library.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const CONTROL = "control-key-for-tests";

function tone(file: string, seconds: number, frequency: number, title = ""): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    ...(title ? ["-metadata", `title=${title}`] : []), "-c:a", "libmp3lame", "-b:a", "64k", file]);
}

function libraryEngine(root: string, files: string[]): Engine {
  const tracks = files.map((_file, at) => ({ title: `Song ${at + 1}`, artist: "Test Artist", album: "Test Album", duration: 0 }));
  return {
    snapshot: (withTracks = true) => ({ ...emptySnapshot(), revision: 1, root, trackCount: files.length, ...(withTracks ? { tracks } : { tracks: undefined }) }),
    command: () => undefined,
    subscribe: () => () => undefined,
    trackPath: (index: number) => files[index],
  } as unknown as Engine;
}

const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!what() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return what();
};

test("how long a station waits with nobody listening: env, then config, then a minute", () => {
  assert.equal(stationIdleSeconds({}, {}), 60);
  assert.equal(stationIdleSeconds({}, { stationIdleSeconds: 0 }), 0);
  assert.equal(stationIdleSeconds({}, { stationIdleSeconds: 300 }), 300);
  assert.equal(stationIdleSeconds({ NIXAMP_STATION_IDLE: "5" }, { stationIdleSeconds: 300 }), 5);
  assert.equal(stationIdleSeconds({ NIXAMP_STATION_IDLE: "nope" }, {}), 60);
});

test("a break clock carried in from a sleep brings the next break forward", { skip: !available, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-sleep-breaks-"));
  try {
    const [a, b, c, spot] = ["a", "b", "c", "spot"].map((one) => join(root, `${one}.mp3`)) as [string, string, string, string];
    tone(a, 1, 440); tone(b, 1, 550); tone(c, 1, 660); tone(spot, 1, 990);
    const play = async (sinceBreak?: number): Promise<PlaylistInputStream> => {
      const list = new PlaylistInputStream({
        ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], files: [a, b, c], at: 0, position: 0, video: false, passOver: true,
        breaks: { everySeconds: 2, next: async () => spot, ...(sinceBreak === undefined ? {} : { sinceBreak: () => sinceBreak }) },
      });
      for await (const _chunk of list.open(new AbortController().signal)) { /* drain */ }
      return list;
    };
    const fresh = await play();
    assert.deepEqual(fresh.history.map((one) => one.at), [0, 1, -1, 2], "a fresh clock: a break after two seconds of music");
    const carried = await play(1.5);
    assert.deepEqual(carried.history.map((one) => one.at), [0, -1, 1, 2], "a second and a half already gone: the break comes after the first");
    // Where it would pick up from, half way into the first entry.
    const point = carried.resumePoint(0.5);
    assert.equal(point?.file, a);
    assert.deepEqual(point?.upcoming, [b, c]);
    assert.ok(Math.abs((point?.sinceBreak ?? 0) - 2) < 0.01, `since break ${point?.sinceBreak}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a station nobody listens to sleeps, wakes for a listener at the next track, keeps its break clock, and is never a failure", { skip: !available, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-sleep-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-sleep-state-"));
  const files = [join(root, "one.mp3"), join(root, "two.mp3"), join(root, "three.mp3")];
  tone(files[0]!, 6, 440, "First Song");
  tone(files[1]!, 6, 550, "Second Song");
  tone(files[2]!, 6, 660, "Third Song");
  let clock = 1_000_000;
  const restarts: string[] = [];
  const clocks: number[] = [];
  const channels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: (info) => runner.onChannelEnd(info) });
  const store = new StationStore(StationStore.fileFor(state, 1));
  const runner: StationRunner = new StationRunner({
    store,
    channels,
    now: () => clock,
    idleSeconds: () => 1,
    breaks: async () => null,
    onRestart: (id) => restarts.push(id),
    pull: async (id, name, list, known) => {
      const breaks = known.rotation.breaks;
      const inner = breaks?.sinceBreak;
      if (breaks && inner) breaks.sinceBreak = () => { const was = inner(); clocks.push(was); return was; };
      return Boolean(await pullChannel(channels, ["ffprobe"], id, name, list[0]!, [], "", { playlist: list, live: true, ...known }));
    },
    roots: () => [root],
  });
  const server = createServer(libraryEngine(root, files), { web: null, media: true, version: "test", key: CONTROL, channels, stations: { store, runner } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const station = store.create({ name: "Sleepy FM", repeat: true }, files, "");
    const channelId = channelOf(station.id);
    await runner.start(station.id);
    assert.ok(await until(() => channels.flowing(channelId) && (channels.info(channelId)?.position ?? 0) > 1, 20_000), "on the air");
    assert.equal(channels.info(channelId)?.playlistAt, 0);

    // Nobody on it: the first sweep notes it, one after the idle time sleeps it.
    runner.sweep();
    assert.equal(runner.isSleeping(station.id), false);
    clock += 1_500;
    runner.sweep();
    assert.equal(runner.isSleeping(station.id), true);
    assert.equal(channels.has(channelId), false, "its encoder is stopped");
    assert.equal(store.get(station.id)?.desired, "running", "still wanted on");
    assert.equal(runner.observed(station.id), "live", "and on the air to anyone asking");
    assert.equal(runner.nextUp(station.id), files[1]);
    assert.equal(store.get(station.id)?.resume?.after, files[0]);
    const slept = store.get(station.id)?.resume?.sinceBreak ?? -1;
    assert.ok(slept >= 1, `the break clock is kept: ${slept}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(restarts, [], "a sleep is not a restart");
    assert.equal(runner.error(station.id), "");

    // What a listener asks about it while it sleeps answers sensibly.
    const view = await (await fetch(`${base}/api/v1/stations/${station.id}/state?k=${CONTROL}`)).json() as { state: string; nowPlaying: { title: string } | null };
    assert.equal(view.state, "live");
    assert.equal(view.nowPlaying?.title, "Song 2", "what it will wake on");
    assert.equal(runner.isSleeping(station.id), true, "asking what is on does not wake it");

    // A listener wakes it, and is held until it sends: sound within ten seconds.
    const abort = new AbortController();
    const asked = Date.now();
    const response = await fetch(`${base}/api/v1/stations/${station.id}/stream?k=${CONTROL}`, { signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.ok(first.value && first.value.byteLength > 0, "bytes");
    assert.ok(Date.now() - asked < 10_000, "within ten seconds");
    assert.equal(runner.isSleeping(station.id), false);
    // It carries on at the next track, not the first, with the clock it had.
    assert.ok(await until(() => (channels.info(channelId)?.position ?? 0) > 0.3, 5_000), "progress after the wake");
    assert.equal(channels.info(channelId)?.playlist?.[channels.info(channelId)?.playlistAt ?? 0], files[1]);
    assert.ok(clocks.length >= 2 && Math.abs(clocks[clocks.length - 1]! - slept) < 0.01, `clock carried: ${clocks.join(",")} vs ${slept}`);

    // Still listened to: the sweep leaves it alone.
    clock += 5_000;
    runner.sweep();
    clock += 5_000;
    runner.sweep();
    assert.equal(runner.isSleeping(station.id), false);

    // Gone again: back to sleep after the idle time.
    abort.abort();
    await reader.cancel().catch(() => undefined);
    assert.ok(await until(() => channels.listenersOf(channelId) === 0, 5_000));
    runner.sweep();
    clock += 1_500;
    runner.sweep();
    assert.equal(runner.isSleeping(station.id), true);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(restarts, []);

    // Stopped while asleep: stopped, and nothing wakes it.
    runner.stop(station.id);
    assert.equal(runner.isSleeping(station.id), false);
    assert.equal(runner.observed(station.id), "stopped");
  } finally {
    runner.close();
    channels.stopAll();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("restored with sleeping on, a running station waits asleep for its first listener", () => {
  const state = mkdtempSync(join(tmpdir(), "nixamp-sleep-restore-"));
  try {
    const store = new StationStore(StationStore.fileFor(state, 1));
    const station = store.create({ name: "Night FM" }, ["/media/a.mp3", "/media/b.mp3"], "");
    store.setDesired(station.id, "running");
    store.setResume(station.id, { after: "/media/a.mp3", sinceBreak: 120 });
    let pulls = 0;
    const runner = new StationRunner({
      store: new StationStore(StationStore.fileFor(state, 1)),
      channels: new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"] }),
      pull: async () => { pulls += 1; return false; },
      roots: () => ["/media"],
      idleSeconds: () => 60,
    });
    runner.restore();
    assert.equal(pulls, 0, "no encoder for nobody");
    assert.equal(runner.isSleeping(station.id), true);
    assert.equal(runner.observed(station.id), "live");
    assert.equal(runner.nextUp(station.id), "/media/b.mp3", "after a restart it still knows where it was");
    runner.close();
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

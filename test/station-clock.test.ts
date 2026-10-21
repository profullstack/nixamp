import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, pullChannel, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const CONTROL = "control-key-for-tests";

function tone(file: string, seconds: number, frequency: number, title: string): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    "-metadata", `title=${title}`, "-metadata", "artist=Test Artist", "-c:a", "libmp3lame", "-b:a", "64k", file]);
}

function libraryEngine(root: string, files: string[]): Engine {
  const tracks = files.map((_, at) => ({ title: `Song ${at + 1}`, artist: "Test Artist", album: "Test Album", duration: 0 }));
  return {
    snapshot: (withTracks = true) => ({ ...emptySnapshot(), revision: 1, root, trackCount: files.length, ...(withTracks ? { tracks } : { tracks: undefined }) }),
    command: () => undefined,
    subscribe: () => () => undefined,
    trackPath: (index: number) => files[index],
  } as unknown as Engine;
}

test("a listener's clock: the second being heard at a player's currentTime, whatever it has buffered", { skip: !available, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-clock-"));
  const state = mkdtempSync(join(tmpdir(), "nixamp-clock-state-"));
  const files = [join(root, "one.mp3"), join(root, "two.mp3")];
  tone(files[0]!, 30, 440, "First Song");
  tone(files[1]!, 30, 660, "Second Song");
  const channels = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: (info) => runner.onChannelEnd(info) });
  const store = new StationStore(StationStore.fileFor(state, 1));
  const runner: StationRunner = new StationRunner({
    store,
    channels,
    pull: async (id, name, list, known) => Boolean(await pullChannel(channels, ["ffprobe"], id, name, list[0]!, [], "", { playlist: list, live: true, ...known })),
    roots: () => [root],
  });
  const server = createServer(libraryEngine(root, files), { web: null, media: true, version: "test", key: CONTROL, channels, stations: { store, runner } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const stop = new AbortController();
  try {
    const made = await fetch(`${base}/api/v1/stations?k=${CONTROL}`, post({ name: "Clock FM", folder: "", repeat: true }));
    const { station } = await made.json() as { station: { id: string; listenToken: string } };
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/start?k=${CONTROL}`, post({}))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/access?k=${CONTROL}`, post({ visibility: "unlisted" }))).status, 200);
    const t = `t=${encodeURIComponent(station.listenToken)}`;
    // On the air a few seconds first, so a newcomer is handed a backlog of the past.
    await new Promise((done) => setTimeout(done, 4000));

    const stream = await fetch(`${base}/api/v1/stations/${station.id}/stream?${t}&n=abc123`, { signal: stop.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    let received = 0;
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
    const clock = async (ct: number) => {
      const r = await fetch(`${base}/api/v1/stations/${station.id}/clock?${t}&n=abc123&ct=${ct}`);
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<{ position: number; duration: number; break: boolean; nowPlaying: { title: string } | null }>;
    };
    // The station's own bitrate (128k): a second of what it was sent is 16000 bytes.
    const sentSeconds = received / 16_000;
    const first = await clock(0);
    const later = await clock(2);
    assert.equal(first.nowPlaying?.title, "First Song");
    assert.equal(later.nowPlaying?.title, "First Song");
    // Two seconds of its player are two seconds of the song, to the frame.
    assert.ok(Math.abs(later.position - first.position - 2) < 0.05, `${first.position} -> ${later.position}`);
    // The first byte it was sent was the backlog: seconds before the live edge, not the live edge.
    const edge = await clock(sentSeconds);
    assert.ok(edge.position - first.position > 2.5, `backlog start ${first.position}, edge ${edge.position}, sent ${sentSeconds}s`);
    assert.ok(Math.abs(edge.position - first.position - sentSeconds) < 0.05);
    // Another stream's name is nobody's clock.
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/clock?${t}&n=nope&ct=1`)).status, 404);
    // Without the station's link, no clock either.
    assert.equal((await fetch(`${base}/api/v1/stations/${station.id}/clock?t=wrong&n=abc123&ct=1`)).status, 404);
  } finally {
    stop.abort();
    channels.stopAll();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

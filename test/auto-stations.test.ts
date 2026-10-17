import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adultTitle, filmGenre, genreBuckets, syncAutoStations, DEFAULT_AUTO } from "../src/auto-stations.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { PlaylistInputStream } from "../src/playlist-input.ts";
import { StationBreaks } from "../src/station-breaks.ts";
import type { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });
const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("server1's genre tags fold into genres a listener knows", () => {
  assert.deepEqual(genreBuckets("Punk Rock"), ["Punk"]);
  assert.deepEqual(genreBuckets("Pop, Rock"), ["Pop", "Rock"]);
  assert.deepEqual(genreBuckets("Rap/Hip-Hop"), ["Hip-Hop"]);
  assert.deepEqual(genreBuckets("Gangsta"), ["Hip-Hop"]);
  assert.deepEqual(genreBuckets("Pop-Punk"), ["Punk"]);
  assert.deepEqual(genreBuckets("Rock / Hard Rock / Metal"), ["Rock", "Metal"]);
  assert.deepEqual(genreBuckets("Pop, Rock, Alternatif et Indé"), ["Pop", "Rock", "Alternative"]);
  assert.deepEqual(genreBuckets("Neue Deutsche Harte"), ["Metal"]);
  assert.deepEqual(genreBuckets("Industrial/Heavy Metal/Hard Rock"), ["Industrial", "Metal", "Rock"]);
  assert.deepEqual(genreBuckets("MIT Faculty Lecture"), []);
  assert.deepEqual(genreBuckets(""), []);
});

test("film genres are one name whatever the spelling", () => {
  assert.equal(filmGenre("action"), "Action");
  assert.equal(filmGenre("Action"), "Action");
  assert.equal(filmGenre("Science-Fiction"), "Sci-Fi");
  assert.equal(filmGenre("Science Fiction"), "Sci-Fi");
  assert.equal(filmGenre("science_fiction"), "Sci-Fi");
  assert.equal(filmGenre("drama"), "Drama");
});

test("adult titles are recognised by name or by nichedb's genres", () => {
  assert.equal(adultTitle("Peta Jensen - Hot And Steamy! The Best Of Shower Sex Compilation_1080p.mp4"), true);
  assert.equal(adultTitle("Some Film (2019)", ["Adult"]), true);
  assert.equal(adultTitle("The Matrix (1999)", ["Action", "Sci-Fi"]), false);
  assert.equal(adultTitle("Middlesex Story"), false);
});

test("a station per genre, unlisted, kept in step with the library; TV from film genres, capped", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-auto-"));
  try {
    const root = join(top, "Music");
    mkdirSync(root, { recursive: true });
    const tag: Record<string, { genre: string; video?: boolean; duration?: number }> = {};
    const add = (name: string, genre: string, video = false) => { writeFileSync(join(root, name), "x"); tag[name] = { genre, video, duration: video ? 5400 : 180 }; };
    for (let i = 0; i < 12; i++) add(`punk${i}.mp3`, "Punk Rock");
    for (let i = 0; i < 11; i++) add(`rap${i}.mp3`, i % 2 ? "Rap" : "Hip Hop");
    for (let i = 0; i < 3; i++) add(`jazz${i}.mp3`, "Jazz");
    for (let i = 0; i < 4; i++) add(`lecture${i}.mp3`, "MIT Faculty Lecture");
    for (let i = 0; i < 4; i++) add(`film-comedy${i}.mp4`, "", true);
    for (let i = 0; i < 3; i++) add(`film-drama${i}.mp4`, "", true);
    add("film-comedy-XXX Hot Compilation.mp4", "", true);
    const probe = async (path: string): Promise<Probed> => {
      const one = tag[path.split("/").pop()!]!;
      return { state: "ready", error: "", duration: one.duration!, codec: one.video ? "aac" : "mp3", bitrate: 1, sampleRate: 1, channels: 2, video: one.video ?? false, hasArt: false, tags: { title: path.split("/").pop()!, artist: "A", genre: one.genre } };
    };
    const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
    await index.scan(index.addSource(root, "").id, probe).done;
    const store = new StationStore(StationStore.fileFor(top, 1), memory());
    const started: string[] = [];
    const runner = { start: async (id: string) => { started.push(id); store.setDesired(id, "running"); return store.get(id)!; } } as unknown as StationRunner;
    const deps = {
      index, store, runner, owner: "acct", mayStart: () => true,
      filmGenres: async (title: string) => (title.includes("comedy") ? ["Comedy", "romance"] : title.includes("drama1") ? ["drama"] : ["Drama"]),
    };
    const first = await syncAutoStations(deps, { ...DEFAULT_AUTO, maxVideoRunning: 1 });
    assert.deepEqual(first.radio.map((one) => [one.genre, one.files, one.made, one.running]), [["Punk", 12, true, true], ["Hip-Hop", 11, true, true]]);
    assert.ok(first.skipped.includes("Jazz radio (3 files)"));
    assert.ok(!JSON.stringify(first).includes("Lecture"), "lectures are not radio");
    assert.deepEqual(first.tv.map((one) => [one.genre, one.films, one.running]), [["Comedy", 4, true], ["Romance", 4, false], ["Drama", 3, false]]);
    assert.ok(!store.list().some((one) => one.items.some((path) => /XXX/.test(path))), "adult films never reach a genre station");
    for (const station of store.list()) {
      assert.equal(station.visibility, "unlisted");
      assert.equal(station.listed, false);
      assert.equal(station.rights, null, "nothing declared on the owner's behalf");
      assert.equal(station.breaksEvery, 600);
      assert.equal(station.shuffle, true);
    }
    assert.equal(store.list().find((one) => one.name === "Comedy TV")?.video, true);

    // New music: the same stations, more files, no duplicates.
    for (let i = 12; i < 15; i++) add(`punk${i}.mp3`, "Punk");
    await index.scan(index.sources()[0]!.id, probe).done;
    const second = await syncAutoStations(deps, { ...DEFAULT_AUTO, maxVideoRunning: 1 });
    assert.equal(second.radio[0]!.id, first.radio[0]!.id);
    assert.equal(second.radio[0]!.files, 15);
    assert.equal(second.radio[0]!.made, false);
    assert.equal(store.list().length, 5);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a break plays between entries, never inside one", { skip: !available, timeout: 60_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-break-"));
  try {
    const tone = (file: string, seconds: number, hz: number) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, "-c:a", "libmp3lame", file]);
    const a = join(top, "a.mp3"), b = join(top, "b.mp3"), spot = join(top, "spot.mp3");
    tone(a, 2, 440); tone(b, 2, 660); tone(spot, 1, 880);
    let asked = 0;
    const list = new PlaylistInputStream({
      ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], files: [a, b], at: 0, position: 0, video: false, repeat: true, passOver: true,
      breaks: { everySeconds: 1, next: async () => { asked++; return spot; } },
    });
    const abort = new AbortController();
    for await (const _chunk of list.open(abort.signal)) if (list.history.length >= 5) { abort.abort(); break; }
    assert.deepEqual(list.history.slice(0, 5).map((one) => one.file), [a, spot, b, spot, a]);
    assert.equal(list.history[1]!.at, -1, "a break is outside the rotation");
    assert.ok(asked >= 2);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("breaks switched on mid-stream land at the next boundary", { skip: !available, timeout: 60_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-break-live-"));
  try {
    const tone = (file: string, seconds: number, hz: number) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, "-c:a", "libmp3lame", file]);
    const a = join(top, "a.mp3"), b = join(top, "b.mp3"), spot = join(top, "spot.mp3");
    tone(a, 2, 440); tone(b, 2, 660); tone(spot, 1, 880);
    let every = 0;
    const list = new PlaylistInputStream({
      ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], files: [a, b], at: 0, position: 0, video: false, repeat: true, passOver: true,
      breaks: { everySeconds: () => every, next: async () => spot },
    });
    const abort = new AbortController();
    for await (const _chunk of list.open(abort.signal)) {
      if (list.history.length >= 2) every = 1;
      if (list.history.length >= 4) { abort.abort(); break; }
    }
    assert.deepEqual(list.history.slice(0, 4).map((one) => one.file), [a, b, spot, a]);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a break comes from the network, else the house spot, else none", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-spot-"));
  try {
    let fetched = 0;
    const fetcher = (async () => { fetched++; return new Response(Buffer.alloc(2000, 1), { status: 200 }); }) as unknown as typeof fetch;
    const network = new StationBreaks({ dir: top, site: "https://nixamp.com", hasSlot: true, guard: async () => "", fetcher, ask: async () => ({ url: "https://cdn.example/spot.mp4", kind: "video" }) });
    const first = await network.next("video");
    assert.ok(first?.startsWith(join(top, "cache")));
    assert.equal(await network.next("video"), first, "cached by URL");
    assert.equal(fetched, 1);
    const plain = new StationBreaks({ dir: top, site: "", hasSlot: true, guard: async () => "", fetcher, ask: async () => ({ url: "http://cdn.example/x.mp4", kind: "video" }) });
    assert.equal(await plain.next("audio"), null, "https only, and no house spot yet");
    writeFileSync(join(top, "spot.mp3"), "x");
    assert.equal(await plain.next("audio"), join(top, "spot.mp3"));
    const none = new StationBreaks({ dir: join(top, "nothing"), site: "", hasSlot: true, guard: async () => "", ask: async () => ({ url: null }) });
    assert.equal(await none.next("video"), null);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

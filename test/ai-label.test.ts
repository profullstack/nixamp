import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AiLabel, cleanLyrics, fileName, genreSlug, renderStoryVideo, renderVideo, retagVideo, ROSTER, songBase, syncLines } from "../src/ai-label.ts";
import { elevenLabsComposer, OutOfCredit, type Composer } from "../src/ai-radio.ts";
import type { askJson } from "../src/ai-text.ts";
import { Channels } from "../src/channels.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });
const probe = async (): Promise<Probed> => ({ state: "ready", error: "", duration: 150, codec: "mp3", bitrate: 192, sampleRate: 44100, channels: 2, video: false, hasArt: false, tags: {} });

/** A writer that plans albums of `songs` songs and writes a verse and a chorus for each. */
function fakeWriter(asked: string[] = []): typeof askJson {
  let albums = 0;
  return async (options) => {
    asked.push(options.system.includes("Plan one album") ? "plan" : "lyrics");
    if (options.system.includes("Plan one album")) {
      albums += 1;
      const count = Number(/exactly (\d+) songs/.exec(options.prompt)?.[1] ?? 3);
      return { model: "test-writer", value: { title: `Record ${albums}`, concept: "A record about trying again.", songs: Array.from({ length: count }, (_, i) => ({ title: `Song ${albums}-${i + 1}`, style: "mid-tempo, 120 BPM, big chorus" })) } };
    }
    return { model: "test-writer", value: { lyrics: "[Verse 1]\nWe drove all night to find the morning light\n\n[Chorus]\nHold on, hold on, we are almost home tonight" } };
  };
}

const fakeComposer = (calls: Array<{ prompt: string; seconds: number; lyrics?: string }>): Composer => ({
  name: "fake/music",
  async compose(input) {
    calls.push({ prompt: input.prompt, seconds: input.seconds, ...(input.lyrics ? { lyrics: input.lyrics } : {}) });
    writeFileSync(input.out, Buffer.alloc(4096, calls.length));
  },
});

/** Until `done` holds and the label has finished what it was doing (its station kept in step). */
async function idle(label: AiLabel, done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500 && !(done() && !(label.status() as { busy: string }).busy); tries++) await new Promise((r) => setTimeout(r, 10));
}

function setup(composer: Composer | null, ask: typeof askJson = fakeWriter(), extra: { now?: () => number; random?: () => number } = {}) {
  const top = mkdtempSync(join(tmpdir(), "nixamp-label-"));
  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const store = new StationStore(StationStore.fileFor(top, 1), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => index.roots() });
  const tagged: Array<{ to: string; tags: Record<string, string>; cover: string }> = [];
  const label = new AiLabel(join(top, "ai-label.json"), {
    index, store, runner, probe, ffmpeg: ["ffmpeg"], root: join(top, "done", "ai"), owner: "chovy",
    mayStart: () => false,
    composer: () => composer,
    ask,
    canAsk: () => true,
    cover: async () => Buffer.alloc(2048, 7),
    tag: async (from, to, tags, cover) => { tagged.push({ to, tags, cover }); copyFileSync(from, to); },
    video: async (audio, _cover, out) => { copyFileSync(audio, out); },
    align: null,
    ...extra,
  });
  return { top, index, store, runner, channels, label, tagged };
}

test("a music video is 720p H.264 with the song's audio, cover or not", { timeout: 120_000 }, async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-video-"));
  try {
    const run = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    try { run(["-f", "lavfi", "-i", "sine=d=6", "-c:a", "libmp3lame", "-metadata", "title=Song", "-metadata", "artist=Band", "-metadata", "lyrics-eng=[Verse] la la", "-id3v2_version", "3", join(top, "a.mp3")]); } catch { return; } // no ffmpeg here
    run(["-f", "lavfi", "-i", "color=c=red:s=512x512:d=1", "-frames:v", "1", join(top, "c.jpg")]);
    // A storyboard: scenes that move and cross-fade, as long as the song.
    const scenes = [0, 1, 2].map((i) => {
      const file = join(top, `s${i}.jpg`);
      run(["-f", "lavfi", "-i", `color=c=0x${["2040a0", "a04020", "20a040"][i]}:s=1024x1024:d=1`, "-frames:v", "1", file]);
      return file;
    });
    await renderStoryVideo(["ffmpeg"], { audio: join(top, "a.mp3"), images: scenes, seconds: 6, artist: "Band", title: "Song", out: join(top, "story.mp4") });
    const story = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height:format_tags=title,artist", "-of", "json", join(top, "story.mp4")], { encoding: "utf8" });
    assert.match(story, /"width": 1280/);
    assert.match(story, /"title": "Song"/);
    assert.ok(Math.abs(Number(/"duration": "([\d.]+)"/.exec(story)![1]) - 6) < 0.5, "as long as the song");
    for (const cover of [join(top, "c.jpg"), ""]) {
      const out = join(top, `v${cover ? 1 : 0}.mp4`);
      await renderVideo(["ffmpeg"], join(top, "a.mp3"), cover, out);
      const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", out], { encoding: "utf8" });
      assert.match(probe, /h264,1280,720/);
      assert.match(probe, /mp3/);
      const tags = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", out], { encoding: "utf8" });
      assert.match(tags, /"title": "Song"/);
      assert.match(tags, /"artist": "Band"/);
      assert.match(tags, /lyrics-eng/);
    }
    // One made before videos carried tags gets them without re-encoding.
    run(["-i", join(top, "v1.mp4"), "-map_metadata", "-1", "-c", "copy", join(top, "bare.mp4")]);
    await retagVideo(["ffmpeg"], join(top, "bare.mp4"), join(top, "a.mp3"), join(top, "tagged.mp4"));
    assert.match(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", join(top, "tagged.mp4")], { encoding: "utf8" }), /"artist": "Band"/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a song's video is a storyboard of drawn scenes; a cover-only video is made again as one", async () => {
  const writer = fakeWriter();
  const asked: string[] = [];
  const ask: typeof askJson = async (options) => {
    if (options.system.includes("You storyboard music videos")) {
      asked.push(options.prompt);
      return { model: "test-writer", value: { scenes: ["a neon street at night", "a guitarist on a rooftop", "headlights in the rain", "dawn over the city"] } };
    }
    return writer(options);
  };
  const filmed: Array<{ images: number; seconds: number; title: string }> = [];
  const { top, label } = setup(fakeComposer([]), ask, {});
  // Reach the deps the setup made, to add an image model and a storyboard renderer.
  const deps = (label as unknown as { deps: Record<string, unknown> }).deps;
  deps["image"] = async () => Buffer.alloc(2048, 3);
  deps["storyVideo"] = async (input: { images: string[]; seconds: number; title: string; audio: string; out: string }) => {
    filmed.push({ images: input.images.length, seconds: input.seconds, title: input.title });
    copyFileSync(input.audio, input.out);
  };
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, enabled: false });
    const artist = label.sign({ preset: "no-refunds" });
    label.configure({ enabled: true });
    await idle(label, () => Boolean(label.get(artist.key)!.albums[0]?.doneAt));
    await label.videos();
    const songs = label.get(artist.key)!.albums[0]!.songs;
    assert.ok(songs.every((song) => song.video && song.videoVersion === 2), "every song has a storyboard video");
    assert.equal(filmed.length, 3);
    assert.deepEqual([filmed[0]!.images, filmed[0]!.seconds], [4, 150], "four scenes, as long as the probed song");
    assert.match(asked[0]!, /Hold on, hold on/, "the storyboard follows the words");
    assert.equal(readdirSync(dirname(songs[0]!.file)).filter((name) => name.startsWith(".scenes")).length, 0, "scene pictures are cleared away");
    // An old cover-and-waveform video is made again as a storyboard.
    songs[0]!.videoVersion = 1;
    await label.videos();
    assert.equal(filmed.length, 4);
    assert.equal(songs[0]!.videoVersion, 2);
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("words timed to the recording become an enhanced .lrc the station page follows", async () => {
  const { formatLrc, parseLrc, LyricsFinder } = await import("../src/lyrics.ts");
  const lyrics = "[Verse 1]\nWe drove all night\n\n[Chorus]\nHold on tight";
  const timed = [["We", 1], ["drove", 1.4], ["all", 1.9], ["night", 2.2], ["Hold", 10], ["on", 10.5], ["tight", 11]].map(([text, start]) => ({ text: String(text), start: Number(start), end: Number(start) + 0.3 }));
  const lines = syncLines(lyrics, timed);
  assert.deepEqual(lines.map((line) => [line.text, line.start]), [["We drove all night", 1], ["Hold on tight", 10]]);
  assert.deepEqual(lines[1]!.words.map((word) => word.text), ["Hold", "on", "tight"]);
  const lrc = formatLrc(lines, { title: "T", artist: "A" });
  assert.match(lrc, /^\[ar:A\]\n\[ti:T\]\n\[00:01\.00\] <00:01\.00>We <00:01\.40>drove/);
  const back = parseLrc(lrc);
  assert.deepEqual(back.map((line) => [line.text, line.start, line.end]), [["We drove all night", 1, 10], ["Hold on tight", 10, 14]]);
  assert.equal(back[0]!.words[1]!.end, 1.9, "a word lasts until the next");
  // A song gets its .lrc, and the lyrics beside the file come back synced.
  const { top, label } = setup(fakeComposer([]), fakeWriter(), {});
  (label as unknown as { deps: Record<string, unknown> }).deps["align"] = async () => [["We", 1], ["drove", 2], ["all", 3], ["night", 4], ["to", 5], ["find", 6], ["the", 7], ["morning", 8], ["light", 9], ["Hold", 20], ["on", 21]].map(([text, start]) => ({ text: String(text), start: Number(start), end: Number(start) + 0.5 }));
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, enabled: false });
    const artist = label.sign({ preset: "delta-ruby" });
    label.configure({ enabled: true });
    await idle(label, () => Boolean(label.get(artist.key)!.albums[0]?.doneAt));
    await label.videos();
    const song = label.get(artist.key)!.albums[0]!.songs[0]!;
    assert.match(song.lrc ?? "", /001\. Song 1-1\.lrc$/);
    const finder = new LyricsFinder({ tags: async () => ({ title: "Song 1-1", artist: "Delta Ruby", "lyrics-eng": song.lyrics }), base: "" });
    const found = await finder.find(song.file);
    assert.equal(found?.synced?.[0]?.text, "We drove all night to find the morning light");
    assert.equal(found?.synced?.[1]?.words[0]?.start, 20);
    assert.ok(label.zipFor({ kind: "song", artist: artist.key, album: label.get(artist.key)!.albums[0]!.key, n: 1 })!.entries.some((one) => one.name.endsWith(".lrc")));
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("a model's JSON with real line breaks inside the lyrics still reads", async () => {
  const { firstObject } = await import("../src/ai-text.ts");
  assert.deepEqual(firstObject('{"lyrics": "[Verse]\nline one\nline \\"two\\""}'), { lyrics: "[Verse]\nline one\nline \"two\"" });
  assert.deepEqual(firstObject('Sure!\n{"title": "A",\n "songs": [{"title": "B\tC"}]}'), { title: "A", songs: [{ title: "B\tC" }] });
});

test("a paused artist's unfinished album does not hold a recording slot", async () => {
  const calls: Array<{ prompt: string; seconds: number }> = [];
  const { top, label } = setup(fakeComposer(calls));
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, parallel: 1, enabled: false });
    const paused = label.sign({ preset: "velvet-ruckus" });
    await label.plan(paused.key);
    label.update(paused.key, { enabled: false });
    const other = label.sign({ preset: "delta-ruby" });
    label.configure({ enabled: true });
    await idle(label, () => Boolean(label.get(other.key)!.albums[0]?.doneAt));
    assert.ok(label.get(other.key)!.albums[0]!.doneAt > 0, "the enabled artist recorded");
    assert.equal(label.get(paused.key)!.albums[0]!.doneAt, 0, "the paused one waits");
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("names make safe folders and file names", () => {
  assert.equal(fileName('AC/DC: "Live"?'), "ACDC Live");
  assert.equal(fileName("..."), "Untitled");
  assert.equal(genreSlug("Hip-Hop"), "hip-hop");
  assert.equal(genreSlug("R&B"), "rnb");
  assert.equal(songBase({ n: 7, title: "Neon / Rain" }), "007. Neon Rain");
  assert.equal(cleanLyrics("```\n[Verse]\nline one\n\n\n\nline two\n```"), "[Verse]\nline one\n\nline two");
});

test("the roster has three artists in each of the owner's genres, two or more elsewhere, each name once", () => {
  const byGenre = new Map<string, number>();
  for (const one of Object.values(ROSTER)) byGenre.set(one.genre, (byGenre.get(one.genre) ?? 0) + 1);
  for (const genre of ["Punk", "Blues", "Country", "Jazz", "Classic Rock", "Metal", "Hip-Hop"]) assert.equal(byGenre.get(genre), 3, genre);
  for (const [genre, count] of byGenre) assert.ok(count >= 2, genre);
  assert.equal(new Set(Object.values(ROSTER).map((one) => one.name.toLowerCase())).size, Object.keys(ROSTER).length);
});

test("after the first sweep, one album a day: an artist at random, or a new one invented in the owner's genres", async () => {
  let clock = Date.UTC(2026, 9, 21, 12);
  let roll = 0.9; // > newArtistChance: an artist already signed
  const writer = fakeWriter();
  const ask: typeof askJson = async (options) => {
    if (options.system.includes("You invent original recording artists")) return { model: "test-writer", value: { name: "Brand New Band", sound: "loud fast punk, 190 BPM", voice: "shouted", bio: "new", themes: "now" } };
    return writer(options);
  };
  const { top, label } = setup(fakeComposer([]), ask, { now: () => clock, random: () => roll });
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, albumsPerDay: 1, newArtistChance: 0.5, genreOrder: ["Punk"], enabled: false });
    const one = label.sign({ preset: "the-bent-spokes" });
    const two = label.sign({ preset: "gutter-velvet" });
    label.configure({ enabled: true });
    const albums = (): number => label.list().reduce((sum, artist) => sum + artist.albums.filter((album) => album.doneAt).length, 0);
    await idle(label, () => albums() === 2);
    assert.equal(albums(), 2, "the sweep: one each");
    await label.tick();
    assert.equal(albums(), 2, "nothing more the same day");
    clock += 86_400_000;
    await label.tick();
    await idle(label, () => albums() === 3);
    assert.equal(albums(), 3, "a day later, the day's album");
    assert.equal(label.list().length, 2, "by an artist already signed");
    clock += 86_400_000;
    roll = 0.1; // < newArtistChance: somebody new
    await label.tick();
    await idle(label, () => albums() === 4);
    const invented = label.list().find((artist) => artist.name === "Brand New Band");
    assert.ok(invented, "a new artist was signed");
    assert.equal(invented!.genre, "Punk");
    assert.equal(invented!.albums.length, 1);
    assert.ok([one, two].every((artist) => label.get(artist.key)!.enabled));
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("several songs at once, never the same one twice, albums in the owner's genre order", async () => {
  const calls: Array<{ prompt: string; seconds: number; lyrics?: string }> = [];
  let live = 0;
  let most = 0;
  const slow: Composer = {
    name: "slow/music",
    async compose(input) {
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 20));
      calls.push({ prompt: input.prompt, seconds: input.seconds });
      writeFileSync(input.out, Buffer.alloc(4096, calls.length));
      live -= 1;
    },
  };
  const { top, label, tagged } = setup(slow);
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, parallel: 3, enabled: false });
    const pop = label.sign({ preset: "lumi-kestrel" });
    const punk = label.sign({ preset: "the-bent-spokes" });
    const blues = label.sign({ preset: "muddy-ledger" });
    label.configure({ enabled: true });
    await idle(label, () => [pop, punk, blues].every((one) => label.get(one.key)!.albums[0]?.doneAt));
    assert.equal(calls.length, 9);
    assert.ok(most >= 2, `songs were made side by side (at most ${most} at once)`);
    assert.equal(new Set(tagged.map((one) => one.to)).size, 9, "no song made twice");
    assert.ok(tagged.every((one) => one.cover), "every song carries its album's cover");
    const planned = [punk, blues, pop].map((one) => label.get(one.key)!.albums[0]!.plannedAt);
    assert.ok(planned[0]! <= planned[1]! && planned[1]! <= planned[2]!, "Punk, then Blues, then Pop");
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("a ℗ copyright tag reads as its holder, with no doubled mark", async () => {
  const { factsFor } = await import("../src/track-facts.ts");
  const facts = factsFor({ station: { id: "abcdefghij", auto: "", rights: null } as never, file: "/x.mp3", tags: { copyright: "℗ 2026 Profullstack, Inc." }, holders: [] });
  assert.equal(facts.rights.holder, "2026 Profullstack, Inc.");
});

test("an artist's albums are planned, written, sung and filed as genre/artist/year-album/001. title", async () => {
  const calls: Array<{ prompt: string; seconds: number; lyrics?: string }> = [];
  const { top, store, label, tagged } = setup(fakeComposer(calls));
  try {
    label.configure({ seedAlbums: 2, songsPerAlbum: 3, songSeconds: 60, monthlySeconds: 0, albumsPerDay: 0, enabled: false });
    const artist = label.sign({ preset: "velvet-ruckus" });
    label.configure({ enabled: true });
    await idle(label, () => label.get(artist.key)!.albums.filter((one) => one.doneAt).length >= 2);
    const albums = label.get(artist.key)!.albums;
    assert.equal(albums.length, 2, "the seed albums, and no more until a month has gone by");
    assert.ok(albums.every((one) => one.doneAt > 0));
    assert.equal(calls.length, 6);
    const year = new Date().getUTCFullYear();
    const folder = join(top, "done", "ai", "rock", "Velvet Ruckus", `${year}-Record 1`);
    assert.equal(albums[0]!.folder, folder);
    assert.ok(existsSync(join(folder, "001. Song 1-1.mp3")));
    assert.match(readFileSync(join(folder, "001. Song 1-1.lyrics.txt"), "utf8"), /\[Chorus\]\nHold on/);
    assert.ok(existsSync(join(folder, "cover.jpg")));
    const about = JSON.parse(readFileSync(join(folder, "album.json"), "utf8")) as { label: string; songs: Array<{ file: string }> };
    assert.equal(about.label, "Profullstack, Inc.");
    assert.equal(about.songs[2]!.file, "003. Song 1-3.mp3");
    // The words are sung, and written into the file with the rights holder.
    assert.match(calls[0]!.lyrics ?? "", /Hold on/);
    assert.match(calls[0]!.prompt, /gritty alternative rock.*Lead vocal: raspy/);
    const first = tagged[0]!;
    assert.equal(first.tags["artist"], "Velvet Ruckus");
    assert.equal(first.tags["track"], "1/3");
    assert.equal(first.tags["publisher"], "Profullstack, Inc.");
    assert.equal(first.tags["copyright"], `℗ ${year} Profullstack, Inc.`);
    assert.match(first.tags["lyrics-eng"] ?? "", /\[Verse 1\]/);
    assert.match(first.tags["comment"] ?? "", /fake\/music/);
    assert.equal(first.cover, join(folder, "cover.jpg"));
    // One station for the genre, on the guide as owned.
    const station = store.list().find((one) => one.auto === "ai:label:rock")!;
    assert.ok(station, "the genre has its station");
    assert.equal(station.items.length, 6);
    assert.deepEqual([station.visibility, station.listed, station.rights?.basis], ["public", true, "owned"]);
    assert.match(station.rights?.note ?? "", /Profullstack, Inc\./);
    // A music video for every song, and a TV station of them on the guide.
    await label.videos();
    assert.ok(existsSync(join(folder, "001. Song 1-1.mp4")));
    assert.ok(label.get(artist.key)!.albums.every((album) => album.songs.every((song) => song.video)));
    const tv = store.list().find((one) => one.auto === "ai:label:videos");
    assert.ok(tv, "the music videos have a TV station");
    assert.deepEqual([tv!.items.length, tv!.visibility, tv!.listed], [6, "public", true]);
    assert.ok(label.zipFor({ kind: "album", artist: artist.key, album: albums[0]!.key, n: 0 })!.entries.some((one) => one.name.endsWith("001. Song 1-1.mp4")), "bought albums carry the videos");
    // The next album is due a month after the last.
    assert.ok(label.dueAt(label.get(artist.key)!) >= albums[1]!.plannedAt + 30 * 86_400_000);
    // What anybody may see.
    const view = label.publicView();
    assert.equal(view.genres[0]!.genre, "Rock");
    assert.equal(view.genres[0]!.artists[0]!.albums[0]!.title, "Record 2", "newest first");
    assert.equal(label.publicFile(artist.key, albums[0]!.key, "2.txt")?.path, join(folder, "002. Song 1-2.lyrics.txt"));
    assert.equal(label.publicFile(artist.key, albums[0]!.key, "9.mp3"), null);
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("the month's cap stops composing mid-album, and credit running out pauses the label", async () => {
  const calls: Array<{ prompt: string; seconds: number }> = [];
  const { top, label } = setup(fakeComposer(calls));
  try {
    label.configure({ seedAlbums: 1, songsPerAlbum: 4, songSeconds: 60, monthlySeconds: 120, enabled: false });
    const artist = label.sign({ preset: "juno-kincaid" });
    label.configure({ enabled: true });
    await idle(label, () => calls.length >= 2);
    assert.equal(calls.length, 2, "two 60 s songs fit in 120 s");
    const album = label.get(artist.key)!.albums[0]!;
    assert.equal(album.doneAt, 0);
    assert.equal(album.songs.filter((one) => one.file).length, 2);
    assert.match(String((label.status() as { waiting: string }).waiting), /used/);
  } finally {
    label.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }

  const broke: Composer = { name: "broke/music", async compose() { throw new OutOfCredit("elevenlabs answered HTTP 402"); } };
  const second = setup(broke);
  try {
    second.label.configure({ seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, enabled: false });
    const artist = second.label.sign({ preset: "delta-wren" });
    second.label.configure({ enabled: true });
    for (let tries = 0; tries < 200 && !(second.label.status() as { settings: { pausedReason: string } }).settings.pausedReason; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.match((second.label.status() as { settings: { pausedReason: string } }).settings.pausedReason, /402/);
    assert.equal(second.label.get(artist.key)!.albums.length, 1, "the plan is kept for when there is credit");
  } finally {
    second.label.stopSchedule();
    rmSync(second.top, { recursive: true, force: true });
  }
});

test("ElevenLabs is asked to sing the words with the newest model", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(Buffer.alloc(4096, 1), { status: 200 });
  }) as typeof fetch;
  const top = mkdtempSync(join(tmpdir(), "nixamp-el-"));
  try {
    const composer = elevenLabsComposer("key", fetcher);
    assert.equal(composer.name, "elevenlabs/music_v2_5");
    await composer.compose({ prompt: "rock", seconds: 90, vocals: true, out: join(top, "a.mp3"), lyrics: "[Verse]\nhello" });
    await composer.compose({ prompt: "lofi", seconds: 30, vocals: false, out: join(top, "b.mp3") });
    assert.deepEqual([sent[0]!["model_id"], sent[0]!["lyrics_text"], sent[0]!["force_instrumental"], sent[0]!["music_length_ms"]], ["music_v2_5", "[Verse]\nhello", undefined, 90_000]);
    assert.deepEqual([sent[1]!["lyrics_text"], sent[1]!["force_instrumental"]], [undefined, true]);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("the label over HTTP: the catalogue is public, running it is the owner's", async () => {
  const calls: Array<{ prompt: string; seconds: number }> = [];
  const { top, store, runner, channels, label } = setup(fakeComposer(calls));
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  // A stand-in nixamp.com that vouches for the grants in `vouched`.
  const vouched = new Map<string, Record<string, unknown>>();
  const site = createHttpServer((request, response) => {
    const grant = new URL(request.url ?? "/", "http://x").searchParams.get("g") ?? "";
    const scope = vouched.get(grant);
    response.writeHead(scope ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify(scope ? { ok: true, scope } : { ok: false }));
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const before = process.env["NIXAMP_SITE"];
  process.env["NIXAMP_SITE"] = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, label } });
  if (before === undefined) delete process.env["NIXAMP_SITE"]; else process.env["NIXAMP_SITE"] = before;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (key: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}?k=${key}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await send("lst", "GET", "/api/v1/stations/label")).status, 403);
    assert.equal((await send("ctl", "POST", "/api/v1/stations/label", { seedAlbums: 1, songsPerAlbum: 3, songSeconds: 60, enabled: false })).status, 200);
    const roster = await send("ctl", "POST", "/api/v1/stations/label/artists", { roster: true });
    assert.equal(roster.status, 201);
    assert.equal(((await roster.json()) as { artists: unknown[] }).artists.length, Object.keys(ROSTER).length);
    const again = await send("ctl", "POST", "/api/v1/stations/label/artists", { roster: true });
    assert.equal(((await again.json()) as { artists: unknown[] }).artists.length, 0, "nobody is signed twice");
    const status = (await (await send("ctl", "GET", "/api/v1/stations/label")).json()) as { artists: Array<{ key: string; name: string }> };
    const lumi = status.artists.find((one) => one.name === "Lumi Kestrel")!;
    for (const one of status.artists) if (one.key !== lumi.key) await send("ctl", "PATCH", `/api/v1/stations/label/artists/${one.key}`, { enabled: false });
    const planned = await send("ctl", "POST", `/api/v1/stations/label/artists/${lumi.key}/album`);
    assert.equal(planned.status, 201, await planned.clone().text());
    const album = ((await planned.json()) as { album: { key: string } }).album;
    await send("ctl", "POST", "/api/v1/stations/label", { enabled: true });
    await idle(label, () => label.get(lumi.key)!.albums[0]!.doneAt > 0);
    // Anybody: the page, the JSON, a song (by range) and its words.
    const page = await fetch(`${base}/label`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Profullstack AI Label/);
    assert.match(html, /Lumi Kestrel/);
    assert.match(html, /Listen live, free/);
    assert.doesNotMatch(html, /\.mp3/, "the songs as files are sold, not linked");
    assert.match(html, /Hold on, hold on/);
    const json = (await (await fetch(`${base}/api/v1/label`)).json()) as { holder: string; genres: Array<{ genre: string }> };
    assert.deepEqual([json.holder, json.genres.map((one) => one.genre)], ["Profullstack, Inc.", ["Pop"]]);
    assert.notEqual((await fetch(`${base}/api/v1/label/${lumi.key}/${album.key}/1.mp3`)).status, 200);
    const part = await fetch(`${base}/api/v1/label/${lumi.key}/${album.key}/2.txt`, { headers: { range: "bytes=0-8" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "[Verse 1]");
    assert.equal((await fetch(`${base}/api/v1/label/${lumi.key}/${album.key}/2.txt`, { method: "DELETE" })).status, 405);
    // The guide points at the catalogue.
    const guide = await (await fetch(`${base}/guide`)).text();
    assert.match(guide, /href="\/label"/);
    // Bought: a grant nixamp.com vouches for opens the MP3 and the zip, and only what it covers.
    assert.equal((await fetch(`${base}/api/v1/label/${lumi.key}/${album.key}/1.mp3?grant=g1.bogus.grant.that.nobody.signed.at.all`)).status, 403);
    const good = `g1.${"x".repeat(30)}`;
    vouched.set(good, { server: base, kind: "album", artist: lumi.key, album: album.key, n: 0, exp: Date.now() + 60_000 });
    const song = await fetch(`${base}/api/v1/label/${lumi.key}/${album.key}/1.mp3?grant=${good}`);
    assert.equal(song.status, 200);
    assert.equal(song.headers.get("content-type"), "audio/mpeg");
    const zip = await fetch(`${base}/api/v1/label/zip?grant=${good}`);
    assert.equal(zip.status, 200, await zip.clone().text());
    assert.match(zip.headers.get("content-disposition") ?? "", /Lumi%20Kestrel%20-%20Record%201\.zip/);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(bytes.length, Number(zip.headers.get("content-length")));
    const file = join(top, "bought.zip");
    writeFileSync(file, bytes);
    const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
    assert.match(listing, /Lumi Kestrel\/\d{4}-Record 1\/001\. Song 1-1\.mp3/);
    assert.match(listing, /003\. Song 1-3\.lyrics\.txt/);
    assert.match(listing, /album\.json/);
    assert.equal((await fetch(`${base}/api/v1/label/zip?grant=g1.${"y".repeat(30)}`)).status, 403);
  } finally {
    label.stopSchedule();
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    await new Promise<void>((done) => site.close(() => done()));
    rmSync(top, { recursive: true, force: true });
  }
});

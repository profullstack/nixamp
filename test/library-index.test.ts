import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryError, LibraryIndex, readProbe, shown, tagsFrom, walkSource, type Probed } from "../src/library-index.ts";

function library() {
  const top = mkdtempSync(join(tmpdir(), "nixamp-index-"));
  const root = join(top, "Music");
  mkdirSync(join(root, "Artist A", "First Album"), { recursive: true });
  mkdirSync(join(root, "Artist B"), { recursive: true });
  const write = (rel: string, body = "x") => { const full = join(root, rel); writeFileSync(full, body); return full; };
  write("Artist A/First Album/01 Opening.mp3");
  write("Artist A/First Album/02 Second.flac");
  write("Artist B/broken.mp3", "not audio");
  write("Artist B/notes.txt", "not even listed");
  writeFileSync(join(top, "secret.mp3"), "outside");
  return { top, root };
}

/** A probe that knows what each file "contains" by its name. */
function fakeProbe(calls: string[]) {
  return async (path: string): Promise<Probed> => {
    calls.push(path);
    const blank = { duration: 0, codec: "", bitrate: 0, sampleRate: 0, channels: 0, video: false, hasArt: false };
    if (path.endsWith("broken.mp3")) return { ...blank, state: "failed", error: "Invalid data found when processing input", tags: {} };
    const name = path.split("/").pop()!;
    return {
      ...blank, state: "ready", error: "", duration: 180, codec: "mp3", bitrate: 256, sampleRate: 44100, channels: 2,
      tags: { title: name.replace(/^\d+ |\.\w+$/g, ""), artist: path.includes("Artist A") ? "Artist A" : "Artist B", album: "First Album", track: Number(name.slice(0, 2)) || 0, genre: "Rock" },
    };
  };
}

test("a rescan of an unchanged library asks ffprobe nothing; a changed file is asked again", async () => {
  const { top, root } = library();
  try {
    const file = LibraryIndex.fileFor(top, 1);
    const index = new LibraryIndex(file);
    const source = index.addSource(root, "acct");
    const calls: string[] = [];
    const first = await index.scan(source.id, fakeProbe(calls)).done;
    assert.equal(first.status, "done");
    assert.equal(first.found, 3);
    assert.equal(first.probed, 3);
    assert.equal(first.ready, 2);
    assert.equal(first.failed, 1);
    index.flush();

    // Read back from disk, as after a restart, and scanned again: nothing to ask.
    const again = new LibraryIndex(file);
    calls.length = 0;
    const second = await again.scan(source.id, fakeProbe(calls)).done;
    assert.equal(second.unchanged, 3);
    assert.deepEqual(calls, []);

    // One file changes: only it is asked about.
    const changed = join(root, "Artist A/First Album/01 Opening.mp3");
    writeFileSync(changed, "different now");
    utimesSync(changed, new Date(), new Date(Date.now() + 5000));
    const third = await again.scan(source.id, fakeProbe(calls)).done;
    assert.deepEqual(calls, [changed]);
    assert.equal(third.unchanged, 2);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("ids stay put, corrections survive rescans, and a missing file is unavailable, not forgotten", async () => {
  const { top, root } = library();
  try {
    const index = new LibraryIndex(LibraryIndex.fileFor(top, 1));
    const source = index.addSource(root, "acct");
    await index.scan(source.id, fakeProbe([])).done;
    const opening = index.itemAt(join(root, "Artist A/First Album/01 Opening.mp3"))!;
    assert.equal(opening.state, "ready");
    assert.equal(opening.track, 1);
    index.correct(opening.id, { title: "The Opening", year: 1999 });
    assert.equal(shown(opening).title, "The Opening");
    assert.throws(() => index.correct(opening.id, { path: "/etc/passwd" }), (error: LibraryError) => error.code === "invalid_field");
    assert.throws(() => index.correct(opening.id, { track: "seven" }), (error: LibraryError) => error.code === "invalid_value");

    await index.scan(source.id, fakeProbe([]), { force: true }).done;
    assert.equal(index.item(opening.id)?.override.title, "The Opening", "a forced rescan keeps the correction");

    rmSync(opening.path);
    const report = await index.scan(source.id, fakeProbe([])).done;
    assert.equal(report.missing, 1);
    assert.equal(index.item(opening.id)?.state, "unavailable");
    assert.equal(index.item(opening.id)?.override.title, "The Opening");
    // Clearing a correction with an empty value.
    index.correct(opening.id, { title: "" });
    assert.equal(index.item(opening.id)?.override.title, undefined);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("a symlink out of the source is left out, and a link back to a parent is not a loop", async () => {
  const { top, root } = library();
  try {
    symlinkSync(join(top, "secret.mp3"), join(root, "Artist B", "link.mp3"));
    symlinkSync(root, join(root, "Artist B", "loop"));
    symlinkSync(join(root, "Artist A"), join(root, "Also A"));
    const { files, outside } = await walkSource(root);
    assert.equal(outside, 1);
    assert.ok(!files.some((one) => one.includes("link.mp3")));
    // The inside link to Artist A is followed once; the loop is not followed at all.
    assert.equal(files.filter((one) => one.endsWith("01 Opening.mp3")).length, 2);
    assert.ok(!files.some((one) => one.includes("/loop/")));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("search, browse and the sources that are refused", async () => {
  const { top, root } = library();
  try {
    const index = new LibraryIndex(LibraryIndex.fileFor(top, 1));
    const source = index.addSource(root, "acct");
    await index.scan(source.id, fakeProbe([])).done;
    assert.equal(index.search({ q: "open" }).total, 1);
    assert.equal(index.search({ q: "artist a second" }).total, 1);
    assert.equal(index.search({ artist: "artist b" }).total, 0, "the broken file is not ready");
    assert.equal(index.search({ state: "failed" }).total, 1);
    assert.equal(index.search({ folder: "Artist A" }).total, 2);
    assert.deepEqual(index.search({ sort: "album" }).items.map((one) => one.track), [1, 2]);
    assert.equal(index.search({ limit: 1 }).items.length, 1);
    assert.deepEqual(index.browse("artists").groups, [{ name: "Artist A", count: 2 }]);
    assert.deepEqual(index.browse("albums").groups, [{ name: "First Album", count: 2, artist: "Artist A" }]);
    assert.deepEqual(index.browse("folders").groups.map((one) => one.name), ["Artist A"]);
    assert.deepEqual(index.counts(), { pending: 0, ready: 2, unsupported: 0, failed: 1, unavailable: 0 });

    assert.throws(() => index.addSource("/", "acct"), (error: LibraryError) => error.code === "forbidden_root");
    assert.throws(() => index.addSource(join(root, "Artist A"), "acct"), (error: LibraryError) => error.code === "overlapping_source");
    assert.equal(index.addSource(root, "acct").id, source.id, "adding the same folder again is the same source");

    // Removing the source forgets the items and touches no file.
    assert.equal(index.removeSource(source.id), 3);
    assert.equal(index.size, 0);
    assert.ok(existsSync(join(root, "Artist A/First Album/01 Opening.mp3")));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("ffprobe's answer is read as a library needs it", () => {
  const ready = readProbe(JSON.stringify({
    format: { duration: "201.5", tags: { TITLE: "Song", ARTIST: "Band", ALBUM: "LP", track: "3/12", disc: "1/2", GENRE: "Ska", date: "1979-05-01", album_artist: "The Band" } },
    streams: [{ codec_type: "audio", codec_name: "flac", sample_rate: "44100", channels: 2 }, { codec_type: "video", disposition: { attached_pic: 1 } }],
  }));
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.tags, { title: "Song", artist: "Band", album: "LP", albumArtist: "The Band", track: 3, disc: 1, genre: "Ska", year: 1979 });
  assert.equal(ready.hasArt, true);
  assert.equal(ready.video, false, "cover art is not a film");
  assert.equal(ready.duration, 201.5);
  assert.equal(readProbe(JSON.stringify({ format: {}, streams: [{ codec_type: "data" }] })).state, "unsupported");
  assert.equal(readProbe("garbage").state, "failed");
  assert.deepEqual(tagsFrom({}), { title: "", artist: "", album: "", albumArtist: "", track: 0, disc: 0, genre: "", year: 0 });
});

test("search over ten thousand items stays well inside the PRD's 500 ms", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-index-big-"));
  try {
    const root = join(top, "Music");
    for (let artist = 0; artist < 100; artist++) {
      mkdirSync(join(root, `Artist ${artist}`), { recursive: true });
      for (let song = 0; song < 100; song++) writeFileSync(join(root, `Artist ${artist}`, `${String(song).padStart(3, "0")} Song ${artist}-${song}.mp3`), "");
    }
    const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), { read: () => null, write: () => undefined });
    const source = index.addSource(root, "");
    const report = await index.scan(source.id, async (path) => ({
      state: "ready", error: "", duration: 1, codec: "mp3", bitrate: 1, sampleRate: 1, channels: 2, video: false, hasArt: false,
      tags: { title: path.split("/").pop()!, artist: path.split("/").at(-2)!, album: "A", genre: "G" },
    }), { concurrency: 4 }).done;
    assert.equal(report.ready, 10_000);
    const times: number[] = [];
    for (const q of ["song 42-7", "artist 99", "nothing like this", "song", "7"]) {
      for (let again = 0; again < 4; again++) {
        const start = performance.now();
        index.search({ q, sort: "artist", limit: 50 });
        times.push(performance.now() - start);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    assert.ok(p95 < 500, `p95 ${p95.toFixed(1)} ms`);
    console.log(`library search over 10,000 items: p95 ${p95.toFixed(1)} ms`);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

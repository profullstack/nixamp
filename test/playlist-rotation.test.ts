import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaylistInputStream } from "../src/playlist-input.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function tone(file: string, seconds: number, frequency = 440): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "64k", file]);
}

function stream(files: string[], extra: Partial<ConstructorParameters<typeof PlaylistInputStream>[0]> = {}) {
  return new PlaylistInputStream({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], files, at: 0, position: 0, video: false, passOver: true, ...extra });
}

/** Read until the stream ends, or until `stopAfter` entries have started. */
async function drain(list: PlaylistInputStream, stopAfter = Infinity, onChunk?: () => void): Promise<{ bytes: number; error: Error | null }> {
  const abort = new AbortController();
  let bytes = 0;
  try {
    for await (const chunk of list.open(abort.signal)) {
      bytes += chunk.length;
      onChunk?.();
      if (list.history.length > stopAfter) { abort.abort(); break; }
    }
    return { bytes, error: null };
  } catch (error) {
    return { bytes, error: error as Error };
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nixamp-rotation-"));
  const a = join(root, "a.mp3"), b = join(root, "b.mp3"), c = join(root, "c.mp3"), bad = join(root, "bad.mp3");
  tone(a, 1, 440); tone(b, 1, 660); tone(c, 1, 880);
  writeFileSync(bad, Buffer.from("this is not audio at all, just text pretending to be an mp3"));
  return { root, a, b, c, bad };
}

test("a corrupt entry is passed over once, and the list plays on", { skip: !available, timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    const failures: string[] = [];
    const list = stream([f.a, f.bad, f.b], { onFailure: (one) => failures.push(one.file) });
    const { error } = await drain(list);
    assert.equal(error, null);
    assert.deepEqual(failures, [f.bad]);
    assert.deepEqual(list.history.map((one) => one.at), [0, 2]);
    assert.equal(list.complete, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a list where nothing plays is an error, said once, not a loop", { skip: !available, timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    let failures = 0;
    const list = stream([f.bad, f.bad], { repeat: true, onFailure: () => { failures++; } });
    const { error } = await drain(list);
    assert.match(String(error?.message), /Nothing in this playlist would play/);
    assert.ok(failures <= 2, `tried ${failures} times`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a repeating list goes round again, in the order it is given each pass", { skip: !available, timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    let passes = 0;
    const list = stream([f.a, f.b, f.c], { repeat: true, order: (n) => { passes++; return [...Array(n).keys()].reverse(); } });
    await drain(list, 4);
    assert.deepEqual(list.history.slice(0, 5).map((one) => one.at), [2, 1, 0, 2, 1]);
    assert.ok(passes >= 2);
    // One timeline across passes: every entry starts after the one before.
    const starts = list.history.map((one) => one.start);
    assert.deepEqual([...starts].sort((x, y) => x - y), starts);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an edit lands on the next entry, and excluded entries are never tried", { skip: !available, timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    let files = [f.a, f.b];
    const tried: string[] = [];
    const list = stream(files, {
      repeat: true,
      current: () => files,
      excluded: (one) => one === f.bad,
      onFailure: (one) => tried.push(one.file),
    });
    let edited = false;
    await drain(list, 3, () => {
      // While a plays, b is taken out and bad and c put after a.
      if (!edited && list.history.length === 1) { files = [f.a, f.bad, f.c]; edited = true; }
    });
    // The very next track is the new list's, after a; bad is never tried.
    assert.deepEqual(list.history.slice(0, 3).map((one) => one.file), [f.a, f.c, f.a]);
    assert.deepEqual(tried, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("without passOver a broken entry still fails the stream, for the channel to redial", { skip: !available, timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    const list = stream([f.a, f.bad], { passOver: false });
    const { error } = await drain(list);
    assert.match(String(error?.message), /entry 2/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("skip ends the entry that is on, and the next starts where it stopped", { skip: !available, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-rotation-"));
  try {
    const long = join(root, "long.mp3"), next = join(root, "next.mp3");
    tone(long, 30, 440); tone(next, 1, 660);
    const list = stream([long, next]);
    let skipped = false;
    const { error } = await drain(list, Infinity, () => {
      if (!skipped && list.history.length === 1) { skipped = list.skip(); }
    });
    assert.equal(error, null);
    assert.equal(skipped, true);
    assert.deepEqual(list.history.map((one) => one.at), [0, 1]);
    // Not 30: the second entry starts where the first was cut, so there is no gap.
    assert.ok(list.history[1]!.start < 29, `second entry started at ${list.history[1]!.start}`);
    assert.equal(list.skip(), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

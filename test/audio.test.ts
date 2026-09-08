import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectTools, formatTime, peaks, probe, RATE, Stream, toMono } from "../src/audio.ts";
import { Analyser, bandEdges, bands } from "../src/fft.ts";
import { findAudio, isAudio, displayName } from "../src/playlist.ts";

const tools = detectTools();
const haveFfmpeg = spawnSync(tools.ffmpeg[0] as string,
  [...tools.ffmpeg.slice(1), "-version"], { timeout: 10_000 }).status === 0;

test("audio extensions are recognised case-insensitively", () => {
  assert.equal(isAudio("a.mp3"), true);
  assert.equal(isAudio("a.FLAC"), true);
  assert.equal(isAudio("a.txt"), false);
  assert.equal(isAudio("noextension"), false);
  assert.equal(isAudio(".hidden"), false);
});

test("findAudio walks a tree, skips dotfiles, and takes a single file", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-"));
  try {
    writeFileSync(join(dir, "b.mp3"), "");
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, ".hidden.mp3"), "");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "c.flac"), "");

    const found = findAudio(dir).map((p) => p.slice(dir.length + 1));
    assert.deepEqual(found, ["b.mp3", "sub/c.flac"]);
    assert.deepEqual(findAudio(join(dir, "b.mp3")), [join(dir, "b.mp3")]);
    assert.deepEqual(findAudio(join(dir, "a.txt")), []);
    assert.deepEqual(findAudio("/nope/not/here"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("display name falls back to the title when there is no artist", () => {
  assert.equal(displayName({ path: "", title: "T", artist: "A", album: "", duration: 0 }), "A — T");
  assert.equal(displayName({ path: "", title: "T", artist: "", album: "", duration: 0 }), "T");
});

test("times format, and an unknown duration is not rendered as 00:00", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(61), "01:01");
  assert.equal(formatTime(3599), "59:59");
  assert.equal(formatTime(NaN), "--:--");
  assert.equal(formatTime(-1), "--:--");
});

test("stereo peaks are per channel", () => {
  // Interleaved L,R: left quiet, right loud. Compared approximately because a
  // Float32Array cannot hold 0.1 or 0.9 exactly and deepEqual is exact.
  const [left, right] = peaks(new Float32Array([0.1, 0.9, -0.2, -0.8]));
  assert.ok(Math.abs(left - 0.2) < 1e-6, `left ${left}`);
  assert.ok(Math.abs(right - 0.9) < 1e-6, `right ${right}`);
  assert.deepEqual(peaks(new Float32Array(0)), [0, 0]);
});

test("mono downmix averages the pair and halves the length", () => {
  const mono = toMono(new Float32Array([1, -1, 0.5, 0.5]));
  assert.equal(mono.length, 2);
  assert.equal(mono[0], 0);
  assert.equal(mono[1], 0.5);
});

// ------------------------------------------------------- against real ffmpeg

test("decodes a real file and the analyser finds the tone that is in it",
  { skip: haveFfmpeg ? false : "ffmpeg not available" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "nixamp-"));
    const file = join(dir, "tone.wav");
    try {
      const [cmd, ...rest] = tools.ffmpeg;
      const made = spawnSync(cmd as string, [
        ...rest, "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
        // ffmpeg's sine source sits near -21 dBFS. Without this the assertion
        // below would be measuring ffmpeg's default gain, not our analyser.
        "-af", "volume=10",
        "-ac", "2", "-ar", String(RATE), file,
      ], { timeout: 60_000 });
      assert.equal(made.status, 0, "ffmpeg produced the fixture");

      const track = probe(tools, file);
      assert.ok(Math.abs(track.duration - 2) < 0.2, `duration ${track.duration}`);

      // Decode through the same path the player uses, minus the output process.
      const silent = { ...tools, play: null };
      const chunks: Float32Array[] = [];
      await new Promise<void>((done, fail) => {
        const stream = new Stream(silent, {
          onSamples: (pcm) => chunks.push(pcm),
          onEnd: (error) => (error ? fail(new Error(error)) : done()),
        });
        stream.start(track);
      });

      const total = chunks.reduce((n, c) => n + c.length, 0);
      // Interleaved stereo, so two values per frame.
      assert.ok(total / 2 > RATE * 1.5, `decoded ${total / 2} frames`);

      const joined = new Float32Array(total);
      let at = 0;
      for (const c of chunks) { joined.set(c, at); at += c.length; }
      const mono = toMono(joined);

      const analyser = new Analyser(2048, RATE);
      analyser.run(mono.subarray(RATE / 2, RATE / 2 + 2048));
      const found = analyser.frequencyOf(analyser.peakBin());
      assert.ok(Math.abs(found - 1000) < 30, `found ${found.toFixed(1)} Hz, expected 1000`);

      const loud = bands(analyser.magnitudes, bandEdges(24, RATE, 2048));
      assert.ok(Math.max(...loud) > 0.7, "the tone reaches the top of its band");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("a missing file ends the stream with an error rather than hanging",
  { skip: haveFfmpeg ? false : "ffmpeg not available" },
  async () => {
    const error = await new Promise<string | undefined>((done) => {
      const stream = new Stream({ ...tools, play: null }, {
        onSamples: () => {},
        onEnd: (e) => done(e),
      });
      stream.start({ path: "/nope/not/here.mp3", title: "x", artist: "", album: "", duration: 0 });
    });
    assert.ok(error, "an error was reported");
  });

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { videoArgs, detectTools, formatTime, peaks, probe, RATE, Stream, toMono } from "../src/audio.ts";
import { Analyser, bandEdges, bands } from "../src/fft.ts";
import { findJingle, playJingle } from "../src/jingle.ts";
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

  // A film is a long track. ffmpeg decodes the container and -vn drops the
  // picture, so the only thing that ever stopped a library of these from
  // playing was the extension not being on the list.
  assert.equal(isAudio("Sneakers 1992 Remastered.mkv"), true);
  assert.equal(isAudio("a.MKV"), true);
  assert.equal(isAudio("a.avi"), true);
  assert.equal(isAudio("a.mov"), true);
  // Not a container: a source tree is somebody's music folder often enough.
  assert.equal(isAudio("server.ts"), false);
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

test("skipping a track does not report the killed decoder as a failure", async () => {
  // A decoder that outlives the skip, so the kill is what ends it. No ffmpeg
  // is needed: the bug was in how a late `close` is attributed, not in decoding.
  const slow = { ffmpeg: ["sh", "-c", "sleep 5"], ffprobe: ["true"], play: null };
  const track = { path: "/one.mp3", title: "one", artist: "", album: "", duration: 0 };
  const ends: (string | undefined)[] = [];
  const stream = new Stream(slow, { onSamples: () => {}, onEnd: (e) => ends.push(e) });

  stream.start(track);
  await new Promise((done) => setTimeout(done, 120));
  // The skip: the first decoder is killed and a second takes its place.
  stream.start({ ...track, path: "/two.mp3", title: "two" });
  await new Promise((done) => setTimeout(done, 250));
  stream.stop();

  assert.deepEqual(ends, [], `a killed decoder reported: ${ends.join(", ")}`);
});

test("what ffprobe found decides how much work the film is", () => {
  // Already H.264 with AAC: the container is the only thing wrong, so both
  // streams are copied and it costs nothing but the rewrap.
  const remux = videoArgs({ video: "h264", audio: "aac", container: "matroska,webm" });
  assert.deepEqual(remux.slice(0, 4), ["-c:v", "copy", "-c:a", "copy"]);

  // H.264 with DTS, which no browser decodes: keep the picture, redo the sound.
  const halfway = videoArgs({ video: "h264", audio: "dts", container: "matroska,webm" });
  assert.deepEqual(halfway.slice(0, 2), ["-c:v", "copy"]);
  assert.ok(halfway.includes("aac"));
  assert.ok(!halfway.includes("libx264"), "re-encoding a picture nobody asked to change");

  // H.265, the case that actually costs something.
  const full = videoArgs({ video: "hevc", audio: "ac3", container: "matroska,webm" });
  assert.deepEqual(full.slice(0, 2), ["-c:v", "libx264"]);
  assert.ok(full.includes("veryfast"), "a film has to arrive at about the speed it plays");
  assert.ok(full.includes("yuv420p"), "10-bit is a picture most browsers refuse");

  // Every path writes a fragmented MP4, because this is a pipe: an ordinary
  // MP4 puts its index at the end, which never arrives on a stream.
  for (const args of [remux, halfway, full]) {
    assert.deepEqual(args.slice(-4), ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
  }
});

test("nothing known about a file means transcode, not a guess", () => {
  // An empty probe is what a missing ffprobe answers, and copying streams we
  // have not identified is how a browser gets a file it cannot open.
  const unknown = videoArgs({ video: "", audio: "", container: "" });
  assert.deepEqual(unknown.slice(0, 2), ["-c:v", "libx264"]);
  assert.ok(unknown.includes("aac"));
});

test("a transport stream never has its audio copied", () => {
  // Every IPTV channel is one of these. Its AAC is ADTS-framed, and copying
  // that into MP4 makes ffmpeg say "Malformed AAC bitstream detected" and then
  // write nothing at all -- a channel that loaded, said video/mp4, and handed
  // over zero bytes. The filter that would fix the framing is refused by the
  // AC-3 track the same URL offers a minute later, so the audio is re-encoded
  // rather than argued with. Re-encoding audio is cheap; this failing is total.
  const live = videoArgs({ video: "h264", audio: "aac", container: "mpegts" });
  assert.deepEqual(live.slice(0, 2), ["-c:v", "copy"], "the picture is still copied");
  assert.ok(!live.includes("copy") || live.indexOf("copy") === 1, "only the video is copied");
  assert.deepEqual(live.slice(2, 4), ["-c:a", "aac"]);
  assert.ok(live.includes("160k"));

  // The same streams in a file are copied as before: this is about the framing
  // a transport stream uses, not about AAC.
  const file = videoArgs({ video: "h264", audio: "aac", container: "mov,mp4,m4a" });
  assert.deepEqual(file.slice(0, 4), ["-c:v", "copy", "-c:a", "copy"]);
});

test("your own jingle wins, and there is one when you have none", () => {
  const shipped = "/pkg/web/dist/nixamp.mp3";

  // Yours, dropped in your home directory. Loosely matched on purpose: the
  // point is that a file you put there is picked up, not that you named it
  // exactly right.
  assert.equal(
    findJingle("/home/me", shipped, () => ["notes.txt", "NixAmp Whips the D-M-C-As.mp3"], () => true),
    "/home/me/NixAmp Whips the D-M-C-As.mp3",
  );
  assert.equal(
    findJingle("/home/me", shipped, () => ["nixamp-mine.MP3"], () => true),
    "/home/me/nixamp-mine.MP3",
  );

  // Nothing of yours: the one that ships, so it works on a machine that has
  // never heard of any of this.
  assert.equal(findJingle("/home/me", shipped, () => ["holiday.jpg"], () => true), shipped);

  // Not an mp3, and not something that merely mentions the name.
  assert.equal(findJingle("/home/me", shipped, () => ["nixamp.txt", "my-nixamp.mp3"], () => true), shipped);

  // No jingle anywhere is silence rather than a crash.
  assert.equal(findJingle("/home/me", shipped, () => [], () => false), null);
  assert.equal(findJingle("/home/me", null, () => [], () => false), null);

  // A home directory that cannot be read is not a reason to fail.
  assert.equal(findJingle("/home/me", shipped, () => { throw new Error("nope"); }, () => true), shipped);
});

test("a machine that cannot make a sound plays no jingle", () => {
  const never = (): never => {
    throw new Error("should not have been spawned");
  };
  // A headless server has no ffplay, and there is nothing to say about that.
  assert.equal(playJingle({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null }, "/tmp/x.mp3", never), false);
  // And nothing to play is nothing to play.
  assert.equal(playJingle({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: ["ffplay"] }, null, never), false);
  // Turned off on purpose stays off.
  assert.equal(
    playJingle({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: ["ffplay"] }, "/tmp/x.mp3", never,
      { NIXAMP_NO_JINGLE: "1" }),
    false,
  );
});

test("the jingle is played once, without a window, and gets out of the way", () => {
  // Asserted on the command rather than on the sound, because the machine this
  // runs on has no speakers and neither does any build server.
  const runs: { command: string; args: string[] }[] = [];
  const fake = (command: string, args: string[]) => {
    runs.push({ command, args });
    return { on: () => undefined, unref: () => undefined };
  };

  assert.equal(
    playJingle(
      { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: ["mise", "exec", "ffmpeg@latest", "--", "ffplay"] },
      "/home/me/NixAmp Whips the D-M-C-As.mp3",
      fake,
      {},
    ),
    true,
  );

  assert.equal(runs.length, 1);
  // The player as it was found, whatever shape that took.
  assert.equal(runs[0]?.command, "mise");
  assert.deepEqual(runs[0]?.args.slice(0, 4), ["exec", "ffmpeg@latest", "--", "ffplay"]);
  // No window, and it exits when the sound does rather than lingering as a
  // process somebody has to notice and kill.
  assert.ok(runs[0]?.args.includes("-nodisp"));
  assert.ok(runs[0]?.args.includes("-autoexit"));
  // The file last, and unmangled: the name has spaces and dashes in it.
  assert.equal(runs[0]?.args.at(-1), "/home/me/NixAmp Whips the D-M-C-As.mp3");
});

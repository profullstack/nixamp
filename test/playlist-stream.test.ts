import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels, BACKLOG_SECONDS, rememberedNow } from "../src/channels.ts";
import { firstBox, FragmentClock } from "../src/fragments.ts";
import { pullChannel } from "../src/server.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
function boxes(bytes: Buffer) {
  const out = [];
  for (;;) { const next = firstBox(bytes); if (!next) return out; out.push(next.box); bytes = next.rest; }
}
function clip(file: string, color: string, codec = "libx264", size = "160x90", seconds = 2) {
  ff(["-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=10:d=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", codec, "-threads", "1", "-g", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", String(seconds), file]);
}

test("a directory live crosses codecs and subdirectories in one decodable stream, then resumes at the saved entry", { skip: !available, timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-playlist-test-"));
  try {
    mkdirSync(join(root, "02 next", "nested"), { recursive: true });
    const files = [join(root, "first.mp4"), join(root, "02 next", "second.mp4"), join(root, "02 next", "nested", "third.mp4")];
    clip(files[0]!, "red"); clip(files[1]!, "blue", "mpeg4", "320x180"); clip(files[2]!, "lime");
    for (const resume of [false, true]) {
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const set = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: finish });
      try {
        const channel = resume
          ? await pullChannel(set, ["ffprobe"], "show", "Show", files[0]!, [], "", { playlist: files, playlistAt: 1, live: true })
          : set.pull("show", "Show", files[0]!, [], "video", false, 10_000, [], "", { live: true, position: 0, playlist: files }, { video: "h264", audio: "aac", container: "mp4", width: 160, height: 90 });
        assert.ok(channel);
        assert.equal(rememberedNow(set)[0]?.playlistAt, resume ? 1 : 0);
        const chunks: Buffer[] = [];
        let ends = 0;
        set.listen("show", { write(b) { chunks.push(Buffer.from(b)); return true; }, end() { ends++; } });
        await done;
        assert.equal(channel.info.error, undefined);
        assert.equal(channel.info.redials ?? 0, 0);
        assert.equal(channel.info.playlistAt, 2);
        assert.ok((channel.info.position ?? 0) >= 1.9);
        assert.equal(ends, 1, "the audience stays attached until the entire show finishes");
        const bytes = Buffer.concat(chunks);
        assert.equal(boxes(bytes).filter(one => one.type === "moov").length, 1, "one stream header across every file");
        const out = join(root, "out.mp4"); writeFileSync(out, bytes);
        const pixels = ff(["-i", out, "-an", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
        const colors: string[] = [];
        for (let at = 0; at < pixels.length; at += 3) {
          const [r, g, b] = pixels.subarray(at, at + 3);
          const color = r! > 150 ? "red" : b! > 150 ? "blue" : g! > 150 ? "green" : "unknown";
          if (color !== colors.at(-1)) colors.push(color);
        }
        assert.deepEqual(colors, resume ? ["blue", "green"] : ["red", "blue", "green"]);
      } finally { set.stopAll(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("low-bitrate video join buffer contains seconds, not the first minutes of a course", { skip: !available }, () => {
  const stream = ff(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=120", "-an", "-c:v", "libx264", "-threads", "1", "-g", "20", "-bf", "0", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]);
  const set = new Channels({ ffmpeg: ["ffmpeg"] });
  try {
    const channel = set.relayIn("show", "Show", "video", "fixture")!;
    // Arrives in arbitrary chunks, potentially much faster than wall time.
    for (let at = 0; at < stream.length; at += 997) channel.receive(stream.subarray(at, at + 997));
    const opening = boxes(Buffer.concat(channel.opening()));
    const clock = new FragmentClock();
    const times = opening.map(one => clock.read(one.bytes)).filter((time): time is number => time !== null);
    assert.ok(times.length > 1);
    assert.ok(times[0]! >= 110, `joined at ${times[0]} seconds of a 120-second stream`);
    assert.ok(times.at(-1)! - times[0]! <= BACKLOG_SECONDS);
    assert.equal(opening[2]?.type, "moof");
  } finally { set.stopAll(); }
});

test("a failed playlist input retries instead of announcing the end of the show", { skip: !available, timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-recovery-test-"));
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const set = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: finish });
  try {
    const files = [join(root, "first.mp4"), join(root, "missing.mp4")];
    clip(files[0]!, "red");
    const channel = set.pull("show", "Show", files[0]!, [], "video", false, 10_000, [], "", { live: true, position: 0, playlist: files }, { video: "h264", audio: "aac", container: "mp4", width: 160, height: 90 })!;
    const deadline = Date.now() + 8000;
    while (!channel.info.redials && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(channel.info.redials, 1);
    assert.equal(channel.info.ended, undefined);
    assert.equal(set.count, 1, "a partial stream must not be mistaken for EOF");
    assert.match(channel.info.error ?? "", /entry 2/);
    const saved = rememberedNow(set)[0]!;
    assert.equal(saved.playlistAt, 0);
    assert.ok((saved.position ?? 0) >= 1, "live playlists persist progress within the current file");
    clip(files[1]!, "blue");
    await done;
    assert.equal(channel.info.playlistAt, 1);
  } finally { set.stopAll(); rmSync(root, { recursive: true, force: true }); }
});

test("an audio album crosses FLAC and MP3 entries without closing listeners", { skip: !available, timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nixamp-album-test-"));
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const set = new Channels({ ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], onEnd: finish });
  try {
    const files = [join(root, "01.flac"), join(root, "02.mp3")];
    ff(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=2", files[0]!]);
    ff(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2", files[1]!]);
    const channel = set.pull("album", "Album", files[0]!, ["-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"], "audio", false, 10_000, [], "", { live: true, position: 0, playlist: files })!;
    const chunks: Buffer[] = [];
    let ends = 0;
    channel.listen({ write(chunk) { chunks.push(chunk); return true; }, end() { ends++; } });
    await done;
    assert.equal(ends, 1); assert.equal(channel.info.playlistAt, 1); assert.equal(channel.info.error, undefined);
    const out = join(root, "out.mp3"); writeFileSync(out, Buffer.concat(chunks));
    const pcm = ff(["-i", out, "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
    const frequency = (start: number) => {
      let crossings = 0;
      for (let i = start * 8000 * 4; i < (start + 0.5) * 8000 * 4; i += 4) {
        if (pcm.readFloatLE(i) < 0 && pcm.readFloatLE(i + 4) >= 0) crossings++;
      }
      return crossings * 2;
    };
    assert.ok(Math.abs(frequency(0.5) - 220) < 5);
    assert.ok(Math.abs(frequency(2.5) - 880) < 5);
  } finally { set.stopAll(); rmSync(root, { recursive: true, force: true }); }
});

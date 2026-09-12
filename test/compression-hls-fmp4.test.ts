import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { HlsPackagers } from "../src/hls.ts";
import { Channels } from "../src/channels.ts";
import { detectTools } from "../src/audio.ts";

/** A real ffmpeg to package with, found the way the server finds it, or none. */
const FFMPEG = detectTools().ffmpeg;
const ffmpegHere = ((): boolean => {
  const [cmd, ...rest] = FFMPEG;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, "-version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
})();

test("a live channel becomes fMP4 HLS: an init segment named for this run, .m4s media, the key on the map line", { skip: !ffmpegHere }, async () => {
  const channels = new Channels({ ffmpeg: FFMPEG });
  const channel = channels.pull(
    "test", "A test pattern", "testsrc=size=320x240:rate=25",
    [
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "25", "-pix_fmt", "yuv420p", "-an",
      "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000",
    ],
    "video",
    true,
    30_000,
    ["-f", "lavfi", "-re"],
  );
  assert.ok(channel);

  const said: string[] = [];
  const hls = new HlsPackagers({
    ffmpeg: FFMPEG,
    listen: (id, listener) => channels.listen(id, listener),
    onEvent: (m) => said.push(m),
    firstPlaylistMs: 40_000,
    packaging: () => "fmp4",
  });
  try {
    const playlist = await hls.playlist("test");
    assert.ok(playlist, `no playlist: ${said.join(" | ")}`);
    assert.match(playlist ?? "", /#EXT-X-MAP:URI="init-[0-9a-f]{8}\.mp4"/, "an initialisation segment, named for this run");
    const init = /URI="(init-[0-9a-f]{8}\.mp4)"/.exec(playlist ?? "")?.[1] ?? "";
    const media = (playlist ?? "").split("\n").find((line) => /^seg\d{5}\.m4s$/.test(line)) ?? "";
    assert.match(media, /^seg\d{5}\.m4s$/);
    const initPath = hls.segment("test", init);
    assert.ok(existsSync(initPath), "the init segment is a file on disk");
    assert.equal(readFileSync(initPath).toString("latin1", 4, 8), "ftyp", "and it begins with the file type box");
    const mediaPath = hls.segment("test", media);
    assert.ok(existsSync(mediaPath));
    const box = readFileSync(mediaPath);
    // A media segment is styp/moof/mdat boxes: no ftyp, no moov, those live in the init.
    const types = new Set<string>();
    for (let at = 0; at + 8 <= box.length;) {
      const size = box.readUInt32BE(at);
      types.add(box.toString("latin1", at + 4, at + 8));
      if (size < 8) break;
      at += size;
    }
    assert.ok(types.has("moof") && types.has("mdat"), `segment boxes: ${[...types].join(",")}`);
    assert.ok(!types.has("moov"), "the movie header is in the init, not repeated in every segment");
    assert.equal(hls.segment("test", "init-00000000.mp4"), "", "another run's init is not here");
    const report = hls.report("test");
    assert.equal(report?.packaging, "fmp4");
    assert.equal(report?.initialised, true);
    assert.ok(report && report.longestSegmentSeconds > 0);
  } finally {
    hls.stopAll();
    channels.stopAll();
  }
});

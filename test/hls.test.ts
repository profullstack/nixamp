import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { HlsPackagers, packagerArgs, PLAYLIST_SEGMENTS, SEGMENT_SECONDS, segmentName, withKey } from "../src/hls.ts";
import { Channels } from "../src/channels.ts";
import { detectTools } from "../src/audio.ts";

test("a segment is a segment name and never a path", () => {
  assert.equal(segmentName("seg00007.ts"), "seg00007.ts");
  assert.equal(segmentName("../index.m3u8"), "");
  assert.equal(segmentName("seg7.ts"), "");
  assert.equal(segmentName("seg00007.ts/../../etc/passwd"), "");
  assert.equal(segmentName(""), "");
});

test("the key rides on every segment line of the playlist, and on nothing else", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-MEDIA-SEQUENCE:12",
    "#EXTINF:2.000000,",
    "seg00012.ts",
    "#EXTINF:2.000000,",
    "seg00013.ts",
    "",
  ].join("\n");
  const keyed = withKey(playlist, "a b/c");
  assert.ok(keyed.includes("seg00012.ts?k=a%20b%2Fc"));
  assert.ok(keyed.includes("seg00013.ts?k=a%20b%2Fc"));
  assert.ok(keyed.includes("#EXT-X-MEDIA-SEQUENCE:12\n"), "comments are untouched");
  assert.equal(withKey(playlist, ""), playlist, "no key, no change");
});

test("ffmpeg copies, never re-encodes, into a short rolling playlist that never ends", () => {
  const args = packagerArgs("/tmp/x");
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "copy"]);
  assert.ok(args.includes("pipe:0"), "fed the channel's bytes on stdin");
  assert.equal(args[args.indexOf("-hls_list_size") + 1], String(PLAYLIST_SEGMENTS));
  const flags = args[args.indexOf("-hls_flags") + 1] ?? "";
  for (const flag of ["delete_segments", "omit_endlist", "independent_segments", "temp_file"]) {
    assert.ok(flags.includes(flag), flag);
  }
  assert.equal(args[args.length - 1], "/tmp/x/index.m3u8");
});

/** A real ffmpeg to package with, found the way the server finds it, or none. */
const FFMPEG = detectTools().ffmpeg;
const ffmpegHere = ((): boolean => {
  const [cmd, ...rest] = FFMPEG;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, "-version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
})();

test("a live channel becomes a playlist of segments, and stops when nobody asks", { skip: !ffmpegHere }, async () => {
  // A real channel, fed by ffmpeg's test pattern: h264 in fragmented MP4,
  // exactly what a browser is sent. The packager listens to it like one.
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
  });
  try {
    const playlist = await hls.playlist("test");
    assert.ok(playlist, `no playlist: ${said.join(" | ")}`);
    assert.match(playlist ?? "", /#EXTM3U/);
    assert.match(playlist ?? "", /#EXTINF/);
    assert.doesNotMatch(playlist ?? "", /#EXT-X-ENDLIST/, "a live playlist never ends");
    const first = (playlist ?? "").split("\n").find((line) => /^seg\d{5}\.ts$/.test(line)) ?? "";
    assert.match(first, /^seg\d{5}\.ts$/);
    const path = hls.segment("test", first);
    assert.ok(existsSync(path), "the segment is a file on disk");
    assert.equal(hls.segment("test", "../index.m3u8"), "");
    assert.equal(hls.count, 1);

    // A channel that is not there is not packaged.
    assert.equal(await hls.playlist("nothing"), null);

    // Stopping cleans up: the directory goes, and the channel loses its listener.
    hls.stop("test");
    assert.equal(hls.count, 0);
    assert.equal(existsSync(path), false);
  } finally {
    hls.stopAll();
    channels.stopAll();
  }
});

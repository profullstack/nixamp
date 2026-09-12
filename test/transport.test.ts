/**
 * Raw transport streams: a `.ts` file with 1080p or 4K television in it.
 *
 * This is what a capture card, a satellite receiver, an IPTV recorder and
 * `ffmpeg -f mpegts` all write, and it was the one shape of media nixamp
 * could not take: the library walk skipped the extension, the router read it
 * as a song, and what did get through was re-encoded when it did not need to
 * be. The fixtures here are made with ffmpeg at test time rather than
 * committed -- a few seconds of 4K is tens of megabytes -- and every test that
 * needs one skips cleanly on a machine without ffmpeg.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codecsOf,
  detectTools,
  MAX_TRANSCODE_HEIGHT,
  transportInputArgs,
  transportProbeArgs,
  videoArgs,
} from "../src/audio.ts";
import {
  isAmbiguousTransportName,
  isTransportName,
  isTransportStream,
  looksLikeTransportStream,
  sniffTransportStream,
} from "../src/sources.ts";
import { findAudio, isAudio, playable } from "../src/playlist.ts";
import { HlsPackagers, packagerArgs, segmentName, segmentType } from "../src/hls.ts";
import { hasPicture, pullChannel } from "../src/server.ts";
import { Channels } from "../src/channels.ts";

const TOOLS = detectTools();
const works = (argv: string[]): boolean => {
  const [cmd, ...rest] = argv;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, "-version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
};
const ffmpegHere = works(TOOLS.ffmpeg);
const ffprobeHere = works(TOOLS.ffprobe);
const hevcHere = ffmpegHere && ((): boolean => {
  const [cmd, ...rest] = TOOLS.ffmpeg as [string, ...string[]];
  const r = spawnSync(cmd, [...rest, "-hide_banner", "-encoders"], { encoding: "utf8", timeout: 20_000 });
  return (r.stdout ?? "").includes("libx265");
})();

/** Somewhere to put fixtures, cleaned up when the process ends. */
const dir = mkdtempSync(join(tmpdir(), "nixamp-ts-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/**
 * A short synthetic transport stream at a real broadcast size.
 *
 * Small on purpose -- a couple of seconds, crf 34, ultrafast -- because the
 * point is the shape of the file, not what it looks like. A 4K fixture at a
 * sane quality is 25 MB and half a minute of encoding.
 */
function fixture(name: string, width: number, height: number, video: string, audio: string): string {
  const path = join(dir, name);
  const [cmd, ...rest] = TOOLS.ffmpeg as [string, ...string[]];
  const result = spawnSync(cmd, [
    ...rest,
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=25`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2",
    "-c:v", video, "-preset", "ultrafast", "-crf", "34", "-pix_fmt", "yuv420p", "-g", "25",
    ...(video === "libx265" ? ["-x265-params", "log-level=error"] : []),
    "-c:a", audio, "-b:a", "128k",
    "-f", "mpegts", path,
  ], { encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, `ffmpeg could not write ${name}: ${result.stderr}`);
  return path;
}

let made: Record<string, string> | null = null;
/** The fixtures, made once and shared: three encodes is enough to pay for. */
function fixtures(): Record<string, string> {
  if (made) return made;
  made = {
    "1080p": fixture("hd.ts", 1920, 1080, "libx264", "aac"),
    "2160p": fixture("uhd.ts", 3840, 2160, "libx264", "aac"),
    ...(hevcHere ? { hevc: fixture("uhd-hevc.ts", 3840, 2160, "libx265", "ac3") } : {}),
  };
  return made;
}

test("three sync bytes at one packet's spacing, and nothing else, is a transport stream", () => {
  const packets = (stride: number): Buffer => {
    const bytes = Buffer.alloc(stride * 3 + 10, 0x11);
    for (let at = 0; at < 3; at++) bytes[at * stride] = 0x47;
    return bytes;
  };
  for (const stride of [188, 192, 204]) {
    assert.equal(sniffTransportStream(packets(stride)), true, `${stride}-byte packets`);
  }
  // A recording cut mid-packet does not start on a boundary.
  assert.equal(sniffTransportStream(Buffer.concat([Buffer.alloc(57, 0x22), packets(188)])), true);
  // One G in a text file is not a stream, and neither is nothing.
  assert.equal(sniffTransportStream(Buffer.from("export function G() { return 0x47; }\n".repeat(40))), false);
  assert.equal(sniffTransportStream(Buffer.alloc(0)), false);
  assert.equal(sniffTransportStream(Buffer.alloc(2048)), false);
});

test("a .ts is opened rather than guessed at, and .m2ts is taken on its name", () => {
  assert.equal(isAmbiguousTransportName("/films/rec.ts"), true);
  assert.equal(isAmbiguousTransportName("/src/server.mts"), false);
  assert.equal(isTransportName("/films/rec.m2ts"), true);
  assert.equal(isTransportName("/films/rec.ts"), false, "a .ts is never taken on its name");

  const source = join(dir, "server.ts");
  writeFileSync(source, "export const x = 1;\n".repeat(200));
  assert.equal(looksLikeTransportStream(source), false);
  assert.equal(isTransportStream(source), false);
  // The library must not list a checkout, and `isAudio` is what the old list
  // was: an extension that means TypeScript far more often than television.
  assert.equal(isAudio(source), false);
  assert.equal(playable(source), false);
  assert.equal(hasPicture(source), false);
});

test("a real .ts recording is a film, whatever its name suggests", { skip: !ffmpegHere, timeout: 300_000 }, () => {
  const hd = fixtures()["1080p"] as string;
  assert.equal(looksLikeTransportStream(hd), true);
  assert.equal(isTransportStream(hd), true);
  assert.equal(playable(hd), true, "a recording belongs in the library");
  assert.equal(hasPicture(hd), true, "and it is something to watch, not to listen to");

  // The walk finds the recording and leaves the source file where it is.
  const library = mkdtempSync(join(tmpdir(), "nixamp-lib-"));
  try {
    writeFileSync(join(library, "notes.ts"), "export const x = 1;\n".repeat(200));
    writeFileSync(join(library, "film.ts"), readFileSync(hd));
    assert.deepEqual(findAudio(library), [join(library, "film.ts")]);
  } finally {
    rmSync(library, { recursive: true, force: true });
  }
});

test("a transport stream is read further into before anything decides what is in it", () => {
  assert.deepEqual(transportProbeArgs("/films/rec.m2ts").slice(0, 1), ["-probesize"]);
  assert.deepEqual(transportProbeArgs("/films/song.mp3"), [], "a file with an index needs none of this");
  // An IPTV address says nothing in its name; what the probe found says it.
  assert.deepEqual(transportProbeArgs("http://box/tipoff/KEY/301", "mpegts").slice(0, 1), ["-probesize"]);
  const opening = transportInputArgs("/films/rec.m2ts");
  assert.ok(opening.includes("-analyzeduration"));
  // A recording cut mid-stream has no timestamps on its first frames, and a
  // fragmented MP4 built out of those has a seek bar that never moves.
  assert.deepEqual(opening.slice(-2), ["-fflags", "+genpts+discardcorrupt"]);
});

test("ffprobe says what is in a 1080p and a 4K recording", { skip: !ffmpegHere || !ffprobeHere, timeout: 300_000 }, async () => {
  const hd = await codecsOf(TOOLS, fixtures()["1080p"] as string);
  assert.equal(hd.video, "h264");
  assert.equal(hd.audio, "aac");
  assert.ok(hd.container.includes("mpegts"));
  assert.deepEqual([hd.width, hd.height], [1920, 1080]);

  const uhd = await codecsOf(TOOLS, fixtures()["2160p"] as string);
  assert.deepEqual([uhd.width, uhd.height], [3840, 2160]);
  // A recording has an end, which is what tells a film from a live channel.
  assert.ok((uhd.duration ?? 0) > 0);
});

test("4K H.264 is copied, at 4K, and only its ADTS audio is redone", () => {
  const uhd = videoArgs({ video: "h264", audio: "aac", container: "mpegts", width: 3840, height: 2160 });
  assert.deepEqual(uhd.slice(0, 2), ["-c:v", "copy"], "copying does not cost more because the picture is bigger");
  assert.ok(!uhd.includes("-vf"), "a copied stream is never resized");
  assert.ok(!uhd.includes("libx264"));
  // Transport-stream AAC is ADTS-framed and MP4 refuses it outright.
  assert.deepEqual(uhd.slice(2, 4), ["-c:a", "aac"]);
});

test("an H.265 recording is copied when the other end can decode it, and comes down to 1080p when it cannot", () => {
  const uhd = { video: "hevc", audio: "ac3", container: "mpegts", width: 3840, height: 2160 };

  const kept = videoArgs(uhd, 0, { allowHevc: true });
  assert.deepEqual(kept.slice(0, 2), ["-c:v", "copy"]);
  // hev1 is what ffmpeg writes by default and what Safari plays as a black
  // panel; hvc1 is what every player actually wants.
  assert.deepEqual(kept.slice(2, 4), ["-tag:v", "hvc1"]);
  assert.ok(!kept.includes("-vf"));

  const redone = videoArgs(uhd, 0, {});
  assert.deepEqual(redone.slice(0, 2), ["-c:v", "libx264"]);
  const filter = redone[redone.indexOf("-vf") + 1] ?? "";
  assert.match(filter, new RegExp(`min\\(${MAX_TRANSCODE_HEIGHT},ih\\)`), "a 4K encode does not keep up with playing it");

  // 1080p is already at the ceiling, so it is re-encoded at its own size.
  const hd = videoArgs({ video: "hevc", audio: "ac3", container: "mpegts", width: 1920, height: 1080 }, 0, {});
  assert.ok(!hd.includes("-vf"), "nothing is scaled that is already small enough");

  // A source whose size nobody asked about is left alone too: guessing that
  // an unmeasured picture is 4K would shrink every film that was not.
  assert.ok(!videoArgs({ video: "hevc", audio: "ac3", container: "mpegts" }, 0, {}).includes("-vf"));
});

test("what videoArgs asks for actually remuxes a 4K recording", { skip: !ffmpegHere || !ffprobeHere, timeout: 300_000 }, async () => {
  const source = fixtures()["2160p"] as string;
  const codecs = await codecsOf(TOOLS, source);
  const out = join(dir, "copied.mp4");
  const [cmd, ...rest] = TOOLS.ffmpeg as [string, ...string[]];
  const result = spawnSync(cmd, [
    ...rest, "-hide_banner", "-loglevel", "error", "-y",
    ...transportInputArgs(source, codecs.container),
    "-i", source,
    ...videoArgs(codecs),
    out,
  ], { encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, `the remux failed: ${result.stderr}`);

  // A fragmented MP4: it opens with the boxes that describe the tracks, which
  // is what a late joiner is handed before any live bytes.
  const head = readFileSync(out).subarray(0, 4096).toString("latin1");
  assert.ok(head.includes("ftyp"), "no ftyp");
  assert.ok(head.includes("moov"), "no moov");

  // Still 4K, still H.264, and the audio is now something a browser opens.
  const after = await codecsOf(TOOLS, out);
  assert.equal(after.video, "h264");
  assert.deepEqual([after.width, after.height], [3840, 2160]);
  assert.equal(after.audio, "aac");
});

test("an H.265 4K recording survives the copy with the tag a player wants", { skip: !hevcHere || !ffprobeHere, timeout: 300_000 }, async () => {
  const source = fixtures()["hevc"] as string;
  const codecs = await codecsOf(TOOLS, source);
  assert.equal(codecs.video, "hevc");
  const out = join(dir, "hevc.mp4");
  const [cmd, ...rest] = TOOLS.ffmpeg as [string, ...string[]];
  const result = spawnSync(cmd, [
    ...rest, "-hide_banner", "-loglevel", "error", "-y",
    ...transportInputArgs(source, codecs.container),
    "-i", source,
    ...videoArgs(codecs, 0, { allowHevc: true }),
    out,
  ], { encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, `the remux failed: ${result.stderr}`);
  const tags = spawnSync(TOOLS.ffprobe[0] as string, [
    ...TOOLS.ffprobe.slice(1), "-v", "quiet", "-show_entries", "stream=codec_tag_string", "-of", "csv=p=0", out,
  ], { encoding: "utf8", timeout: 60_000 });
  assert.match(tags.stdout, /hvc1/, `written as ${tags.stdout.trim()}`);

  const after = await codecsOf(TOOLS, out);
  assert.deepEqual([after.width, after.height], [3840, 2160], "copied at its own size");
  // AC-3 is not a track any browser plays, so the sound is redone either way.
  assert.equal(after.audio, "aac");
});

test("an H.265 channel is packaged as fMP4, because HLS in transport segments is H.264 only", () => {
  const ts = packagerArgs("/tmp/x");
  assert.equal(ts[ts.indexOf("-hls_segment_type") + 1], "mpegts");
  assert.equal(ts[ts.length - 1], "/tmp/x/index.m3u8");

  // The init segment carries the packager's run token in its name, so a
  // client holding a previous run's init cannot pair it with this run's parts.
  const fmp4 = packagerArgs("/tmp/x", "fmp4", "abcd1234");
  assert.equal(fmp4[fmp4.indexOf("-hls_segment_type") + 1], "fmp4");
  assert.equal(fmp4[fmp4.indexOf("-hls_fmp4_init_filename") + 1], "init-abcd1234.mp4");
  assert.equal(fmp4[fmp4.indexOf("-hls_segment_filename") + 1], "/tmp/x/seg%05d.m4s");
  // Copying either way: packaging is never an encode.
  assert.deepEqual(fmp4.slice(fmp4.indexOf("-c"), fmp4.indexOf("-c") + 2), ["-c", "copy"]);

  // The names those two produce are served, and nothing else is.
  assert.equal(segmentName("seg00003.m4s"), "seg00003.m4s");
  assert.equal(segmentName("init-abcd1234.mp4"), "init-abcd1234.mp4");
  assert.equal(segmentName("../../etc/passwd"), "");
  assert.equal(segmentName("init-abcd1234.mp4/../x"), "");
  assert.equal(segmentType("seg00003.ts"), "video/mp2t");
  assert.equal(segmentType("seg00003.m4s"), "video/iso.segment");
  assert.equal(segmentType("init-abcd1234.mp4"), "video/mp4");
});

test("a 1080p recording goes live as a channel, copied rather than re-encoded", { skip: !ffmpegHere || !ffprobeHere, timeout: 300_000 }, async () => {
  // The whole path: what going live with a file in the library does. The
  // source is probed, the streams decide the encode, and a listener is handed
  // a fragmented MP4 that still has the original picture in it.
  const channels = new Channels({ ffmpeg: TOOLS.ffmpeg });
  const source = fixtures()["1080p"] as string;
  try {
    const channel = await pullChannel(channels, TOOLS.ffprobe, "rec", "A recording", source);
    assert.ok(channel, "the channel did not start");
    assert.equal(channel?.info.kind, "video", "a recording is something to watch");
    assert.equal(channel?.info.codecs?.video, "h264");
    assert.deepEqual([channel?.info.codecs?.width, channel?.info.codecs?.height], [1920, 1080]);
    // A file has an end, so it is a film with a place to go back to rather
    // than a live source that is wherever it is now.
    assert.equal(channel?.info.live, false);
    assert.equal(channels.contentType("rec"), "video/mp4");
    // What comes out of the channel, which is what an HLS packager has to
    // ask: copied H.264 in, copied H.264 out.
    assert.equal(channel?.info.emits, "h264");

    const chunks: Buffer[] = [];
    const detach = channels.listen("rec", { write: (chunk) => { chunks.push(chunk); return true; }, end: () => undefined });
    assert.ok(detach);
    // Paced to real time, as a channel always is, so this waits about as long
    // as the recording lasts.
    await new Promise((done) => setTimeout(done, 3500));
    detach?.();
    const got = Buffer.concat(chunks);
    assert.ok(got.byteLength > 0, "the channel produced nothing");
    const head = got.subarray(0, 4096).toString("latin1");
    assert.ok(head.includes("ftyp") && head.includes("moov"), "a listener joins on the boxes that describe the stream");

    const played = join(dir, "channel.mp4");
    writeFileSync(played, got);
    const after = await codecsOf(TOOLS, played);
    assert.equal(after.video, "h264");
    // The picture came through at its own size: a 1080p recording that arrives
    // as 1080p was copied, not re-encoded.
    assert.deepEqual([after.width, after.height], [1920, 1080]);
  } finally {
    channels.stopAll();
  }
});

test("an H.265 channel packages into fMP4 segments a phone can play", { skip: !hevcHere, timeout: 180_000 }, async () => {
  // The other half of the HEVC story: Safari is the browser that can decode
  // H.265 and the one that needs HLS, and HLS in transport segments is
  // defined for H.264 only. So an HEVC channel is cut into fMP4 -- an init
  // file plus .m4s parts -- which is what `#EXT-X-MAP` in the playlist says.
  const channels = new Channels({ ffmpeg: TOOLS.ffmpeg });
  const hls = new HlsPackagers({
    ffmpeg: TOOLS.ffmpeg,
    listen: (id, listener) => channels.listen(id, listener),
    onEvent: () => undefined,
    firstPlaylistMs: 60_000,
  });
  try {
    // Small and endless: what is being tested is the packaging, not x265.
    const channel = channels.pull(
      "hevc", "An H.265 pattern", "testsrc2=size=320x240:rate=25",
      [
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "34", "-pix_fmt", "yuv420p",
        "-x265-params", "log-level=error:keyint=25:min-keyint=25", "-tag:v", "hvc1", "-an",
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000",
      ],
      "video", true, 60_000, ["-f", "lavfi", "-re"],
    );
    assert.ok(channel);
    const playlist = await hls.playlist("hevc", true);
    assert.ok(playlist, "an H.265 channel could not be packaged");
    const init = /#EXT-X-MAP:URI="(init-[0-9a-f]{8}\.mp4)"/.exec(playlist ?? "")?.[1] ?? "";
    assert.ok(init, "no init segment, so nothing describes the track");
    const part = (playlist ?? "").split("\n").find((line) => line.endsWith(".m4s")) ?? "";
    assert.match(part, /^seg\d{5}\.m4s$/);
    assert.notEqual(hls.segment("hevc", part), "", "the segment named in the playlist is not there");
    assert.notEqual(hls.segment("hevc", init), "", "the init segment is not served");
  } finally {
    hls.stopAll();
    channels.stopAll();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENCODER,
  type Destination,
  buildBroadcastArgs,
  ingestUrl,
  isRtmp,
  redact,
  resolutionOf,
  teeOutput,
} from "../src/broadcast.ts";

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "1",
  name: "YouTube",
  url: "rtmp://a.rtmp.youtube.com/live2",
  key: "abcd-efgh-ijkl-mnop",
  enabled: true,
  ...over,
});

const plan = (over: Partial<Parameters<typeof buildBroadcastArgs>[0]> = {}) => ({
  source: "/music/track.flac",
  destinations: [dest()],
  settings: DEFAULT_ENCODER,
  webAudio: false,
  needsVideo: true,
  ...over,
});

test("the ingest URL is the base and the key, with no double slash", () => {
  assert.equal(ingestUrl(dest()), "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop");
  assert.equal(ingestUrl(dest({ url: "rtmp://a.rtmp.youtube.com/live2/" })), "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop");
});

test("only rtmp and rtmps are somewhere to broadcast", () => {
  assert.equal(isRtmp("rtmp://live.twitch.tv/app"), true);
  assert.equal(isRtmp("rtmps://live-api-s.facebook.com:443/rtmp"), true);
  assert.equal(isRtmp("https://example.com/live"), false);
  assert.equal(isRtmp(""), false);
});

test("a key is never shown in full", () => {
  const shown = redact(dest());
  assert.equal(shown.key, "••••mnop");
  assert.doesNotMatch(JSON.stringify(shown), /abcd-efgh/);
  // Nothing to hide is shown as nothing, not as four bullets.
  assert.equal(redact(dest({ key: "" })).key, "");
});

test("a tee output always ignores its own failure", () => {
  // Without this, one dead destination takes the whole broadcast with it.
  assert.equal(teeOutput("rtmp://a/b"), "[f=flv:onfail=ignore]rtmp://a/b");
  assert.equal(teeOutput("pipe:1", ["select=a", "f=mp3"]), "[select=a:f=mp3:onfail=ignore]pipe:1");
});

test("one destination skips the tee muxer", () => {
  const args = buildBroadcastArgs(plan());
  assert.equal(args.includes("tee"), false);
  assert.deepEqual(args.slice(-3), ["-f", "flv", "rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop"]);
});

test("several destinations are one encode fanned out", () => {
  const args = buildBroadcastArgs(plan({
    destinations: [
      dest({ id: "1", name: "YouTube" }),
      dest({ id: "2", name: "X", url: "rtmp://ingest.x.com:1935/live", key: "xkey" }),
      dest({ id: "3", name: "TikTok", url: "rtmp://push.tiktokcdn.com/live", key: "tkey" }),
    ],
  }));

  const spec = args[args.length - 1] as string;
  assert.equal(args[args.length - 2], "tee");
  const outputs = spec.split("|");
  assert.equal(outputs.length, 3);
  for (const output of outputs) assert.match(output, /onfail=ignore/);
  assert.match(spec, /rtmp:\/\/ingest\.x\.com:1935\/live\/xkey/);
  assert.match(spec, /rtmp:\/\/push\.tiktokcdn\.com\/live\/tkey/);

  // libx264 appears once: the whole point of tee is encoding once.
  assert.equal(args.filter((a) => a === "libx264").length, 1);
});

test("a disabled or non-rtmp destination is left out", () => {
  const args = buildBroadcastArgs(plan({
    destinations: [
      dest({ id: "1", enabled: true }),
      dest({ id: "2", name: "off", key: "offkey", enabled: false }),
      dest({ id: "3", name: "web", url: "https://example.com/live", key: "wkey" }),
    ],
  }));
  const joined = args.join(" ");
  assert.doesNotMatch(joined, /offkey/);
  assert.doesNotMatch(joined, /wkey/);
});

test("nothing enabled is no command at all, rather than an ffmpeg that fails", () => {
  assert.deepEqual(buildBroadcastArgs(plan({ destinations: [] })), []);
  assert.deepEqual(buildBroadcastArgs(plan({ destinations: [dest({ enabled: false })] })), []);
});

test("the web copy rides along on the same encode", () => {
  const args = buildBroadcastArgs(plan({ webAudio: true }));
  const spec = args[args.length - 1] as string;
  assert.equal(args[args.length - 2], "tee");
  assert.match(spec, /\[select=a:f=mp3:onfail=ignore\]pipe:1/);
  // Still one encoder for both.
  assert.equal(args.filter((a) => a === "libx264").length, 1);
});

test("music with no picture gets one invented, because RTMP wants a video track", () => {
  const args = buildBroadcastArgs(plan({ needsVideo: true }));
  const joined = args.join(" ");
  assert.match(joined, /lavfi/);
  assert.match(joined, /color=c=black:s=1920x1080:r=30/);
  // The colour is input 0 and the music is input 1.
  assert.equal(args[args.indexOf("-map") + 1], "0:v");
  assert.equal(args[args.lastIndexOf("-map") + 1], "1:a");
});

test("a source with its own picture is used as it is", () => {
  const args = buildBroadcastArgs(plan({ needsVideo: false }));
  assert.doesNotMatch(args.join(" "), /lavfi/);
  assert.equal(args[args.lastIndexOf("-map") + 1], "0:a");
});

test("the settings YouTube actually needs", () => {
  const args = buildBroadcastArgs(plan());
  const at = (flag: string) => args[args.indexOf(flag) + 1];

  // One second of keyframes, not ffmpeg's default: YouTube stalls on that.
  assert.equal(at("-g"), "30");
  assert.equal(at("-pix_fmt"), "yuv420p");
  // A forced constant frame rate, or YouTube reports a stream falling behind.
  assert.match(at("-vf") as string, /fps=30/);
  assert.equal(at("-preset"), "veryfast");
  assert.equal(at("-tune"), "zerolatency");
  assert.equal(at("-ar"), "44100");
  assert.equal(at("-maxrate"), "4950k");
  assert.equal(at("-bufsize"), "9000k");

  const smaller = buildBroadcastArgs(plan({
    settings: { ...DEFAULT_ENCODER, resolution: "720p", framerate: 24, keyframeInterval: 2 },
  }));
  assert.match(smaller[smaller.indexOf("-vf") + 1] as string, /scale=1280:720,fps=24/);
  assert.equal(smaller[smaller.indexOf("-g") + 1], "48");
});

test("a file is paced, a live source is not", () => {
  // Throttling a source that already arrives in real time drifts further
  // behind with every track.
  assert.equal(buildBroadcastArgs(plan({ source: "/music/a.flac" })).includes("-re"), true);
  assert.equal(buildBroadcastArgs(plan({ source: "pipe:0" })).includes("-re"), false);
  assert.equal(buildBroadcastArgs(plan({ source: "https://stream.example/live" })).includes("-re"), false);
  assert.equal(buildBroadcastArgs(plan({ source: "rtmp://in.example/live" })).includes("-re"), false);
});

test("resolutions are the two everybody streams at", () => {
  assert.deepEqual(resolutionOf("720p"), { width: 1280, height: 720 });
  assert.deepEqual(resolutionOf("1080p"), { width: 1920, height: 1080 });
});

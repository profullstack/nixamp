import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseFormat } from "../src/ingest.ts";
import { parseDestinations } from "../src/server.ts";
import { PRESETS } from "../src/broadcast.ts";

test("a container ffmpeg knows, out of whatever the sender said", () => {
  assert.equal(normaliseFormat("webm"), "webm");
  assert.equal(normaliseFormat("WEBM"), "webm");
  // What MediaRecorder actually sends as a content type.
  assert.equal(normaliseFormat("audio/webm;codecs=opus"), "webm");
  assert.equal(normaliseFormat("video/mp4"), "mp4");
  assert.equal(normaliseFormat("audio/x-matroska"), "matroska");
  assert.equal(normaliseFormat("audio/ogg"), "ogg");
});

test("an unknown container is refused rather than guessed at", () => {
  // ffmpeg takes an unknown -f and dies seconds later with a message nobody
  // is looking at, so it is refused up front.
  assert.equal(normaliseFormat("application/json"), null);
  assert.equal(normaliseFormat("rubbish"), null);
  assert.equal(normaliseFormat(""), null);
  assert.equal(normaliseFormat(undefined), null);
  assert.equal(normaliseFormat(42), null);
  assert.equal(normaliseFormat("audio/aiff"), null);
});

test("a preset destination needs only a key", () => {
  const [youtube] = parseDestinations(["youtube=abcd-1234"]);
  assert.equal(youtube?.url, PRESETS["youtube"]);
  assert.equal(youtube?.key, "abcd-1234");
  assert.equal(youtube?.enabled, true);

  const [tiktok] = parseDestinations(["TikTok=k"]);
  assert.equal(tiktok?.url, PRESETS["tiktok"]);
  assert.equal(tiktok?.name, "TikTok");
});

test("a full URL is split at the last slash", () => {
  const [one] = parseDestinations(["mine=rtmp://live.example.com/app/secret-key"]);
  assert.equal(one?.url, "rtmp://live.example.com/app");
  assert.equal(one?.key, "secret-key");

  const [secure] = parseDestinations(["fb=rtmps://live-api-s.facebook.com:443/rtmp/FB-123"]);
  assert.equal(secure?.url, "rtmps://live-api-s.facebook.com:443/rtmp");
  assert.equal(secure?.key, "FB-123");
});

test("a preset name with a full URL uses the URL, not the preset", () => {
  const [custom] = parseDestinations(["youtube=rtmp://my.own.mirror/live2/key"]);
  assert.equal(custom?.url, "rtmp://my.own.mirror/live2");
  assert.equal(custom?.key, "key");
});

test("nonsense is dropped rather than turned into a broken destination", () => {
  assert.deepEqual(parseDestinations([]), []);
  assert.deepEqual(parseDestinations(["novalue"]), []);
  assert.deepEqual(parseDestinations(["=key"]), []);
  assert.deepEqual(parseDestinations(["name="]), []);
  // Not rtmp, and not a preset name.
  assert.deepEqual(parseDestinations(["name=https://example.com/live"]), []);
  // A URL with no path to take a key from.
  assert.deepEqual(parseDestinations(["name=rtmp://host"]), []);
});

test("several destinations keep distinct ids", () => {
  const parsed = parseDestinations(["youtube=a", "x=b", "twitch=c"]);
  assert.equal(parsed.length, 3);
  assert.equal(new Set(parsed.map((d) => d.id)).size, 3);
});

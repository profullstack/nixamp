import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtCache, coverArtOf, stillFrom } from "../src/art.ts";
import { codecsOf, detectTools, tagsOf } from "../src/audio.ts";
import { EmptyEngine, absoluteArtOf, artOf, createServer, lineupEntry, looksLikeFileName } from "../src/server.ts";
import type { ChannelInfo } from "../src/channels.ts";

const tools = detectTools();
const haveFfmpeg = spawnSync(tools.ffmpeg[0] as string, [...tools.ffmpeg.slice(1), "-version"], { timeout: 10_000 }).status === 0;

/** A podcast episode: one second of tone with a red sleeve and its tags. */
function makePodcast(dir: string): string {
  const out = join(dir, "episode.mp3");
  const [cmd, ...rest] = tools.ffmpeg as [string, ...string[]];
  const made = spawnSync(cmd, [
    ...rest, "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-f", "lavfi", "-i", "color=c=red:s=96x96:d=1",
    "-map", "0:a", "-map", "1:v", "-frames:v", "1",
    "-c:a", "libmp3lame", "-c:v", "mjpeg", "-disposition:v", "attached_pic",
    "-id3v2_version", "3",
    "-metadata", "title=Episode 12: The Founders",
    "-metadata", "artist=Inspiring Founders",
    "-metadata", "album=Season 2",
    out,
  ], { timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr.toString());
  return out;
}

/** A second of moving picture as the fragmented MP4 a channel sends. */
function makeFragmented(dir: string): Buffer {
  const out = join(dir, "channel.mp4");
  const [cmd, ...rest] = tools.ffmpeg as [string, ...string[]];
  const made = spawnSync(cmd, [
    ...rest, "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", out,
  ], { timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr.toString());
  return readFileSync(out);
}

test("a file's tags are read however the container spells them", () => {
  assert.deepEqual(tagsOf({ TITLE: "Ep 1", Artist: "Show", album: "S1", encoder: "x" }), { title: "Ep 1", artist: "Show", album: "S1" });
  assert.equal(tagsOf({ encoder: "x" }), undefined);
  assert.equal(tagsOf(undefined), undefined);
  // Control characters are not part of a title.
  assert.equal(tagsOf({ title: "a[31mb" })?.title, "a [31mb");
});

test("a name that is only a file's is told from one somebody chose", () => {
  assert.equal(looksLikeFileName("episode-12.mp3"), true);
  assert.equal(looksLikeFileName("index.m3u8"), true);
  assert.equal(looksLikeFileName("Inspiring Founders Podcast"), false);
  assert.equal(looksLikeFileName("Ep. 3"), false);
});

test("where a channel's picture is: the site's, this server's route, or nowhere", () => {
  const base = { id: "url-abc", startedAt: 1, bytes: 0, listeners: 0, format: "mp3", via: "pull" as const, name: "x" };
  // A thumbnail from the site is used as it is.
  assert.equal(artOf({ ...base, art: "https://i.example/t.jpg" }), "https://i.example/t.jpg");
  // A sleeve in the file, or a moving picture, is read out by this server.
  assert.equal(artOf({ ...base, kind: "audio", codecs: { video: "", audio: "mp3", container: "mp3", cover: true } }), "/api/channels/url-abc/art");
  assert.equal(artOf({ ...base, kind: "video" }), "/api/channels/url-abc/art");
  // Sound with no sleeve has no picture to be had.
  assert.equal(artOf({ ...base, kind: "audio" }), "");
  // As a crawler reaches it: absolute, with the listen key the listing carries.
  assert.equal(
    absoluteArtOf("https://s1.example:4321/view/LISTEN", { ...base, kind: "video" }),
    "https://s1.example:4321/api/channels/url-abc/art?k=LISTEN",
  );
  assert.equal(absoluteArtOf("https://s1.example:4321/view/LISTEN", { ...base, art: "https://i.example/t.jpg" }), "https://i.example/t.jpg");
  assert.equal(absoluteArtOf("not a url", { ...base, kind: "video" }), "");
  const entry = lineupEntry("https://s1.example/view/K", { ...base, name: "CNN", kind: "video", about: "News" } as ChannelInfo);
  assert.deepEqual(entry, { id: "url-abc", name: "CNN", kind: "video", art: "https://s1.example/api/channels/url-abc/art?k=K", about: "News" });
});

test("the cache takes a picture once, and a still again after a minute", async () => {
  let now = 1_000;
  const cache = new ArtCache(() => now);
  let taken = 0;
  const take = async (): Promise<Buffer | null> => {
    taken += 1;
    return Buffer.from([0xff, 0xd8, taken]);
  };
  // Five crawlers at once cost one ffmpeg.
  const [a, b] = await Promise.all([cache.get("c:still", false, take), cache.get("c:still", false, take)]);
  assert.equal(taken, 1);
  assert.deepEqual(a, b);
  // Within the minute, the same frame.
  now += 30_000;
  assert.deepEqual(await cache.get("c:still", false, take), a);
  assert.equal(taken, 1);
  // After it, a fresh one.
  now += 31_000;
  assert.notDeepEqual(await cache.get("c:still", false, take), a);
  assert.equal(taken, 2);
  // A sleeve is kept for good.
  await cache.get("c:cover", true, take);
  now += 3_600_000;
  await cache.get("c:cover", true, take);
  assert.equal(taken, 3);
  // A channel that went off takes its pictures with it.
  cache.forget("c");
  await cache.get("c:cover", true, take);
  assert.equal(taken, 4);
});

test("nothing to decode is no picture, without ffmpeg being asked", async () => {
  assert.equal(await stillFrom(["definitely-not-ffmpeg"], []), null);
  assert.equal(await stillFrom(["definitely-not-ffmpeg"], [Buffer.alloc(0)]), null);
  assert.equal(await coverArtOf([], "/nowhere.mp3"), null);
});

test(
  "a podcast's sleeve and a channel's frame come out as JPEGs",
  { skip: haveFfmpeg ? false : "ffmpeg not available" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "nixamp-art-"));
    try {
      const episode = makePodcast(dir);
      // The probe says there is a sleeve, and what the file calls itself.
      const codecs = await codecsOf(tools, episode);
      assert.equal(codecs.cover, true);
      assert.equal(codecs.video, "", "the sleeve is not a picture to play");
      assert.deepEqual(codecs.tags, { title: "Episode 12: The Founders", artist: "Inspiring Founders", album: "Season 2" });
      const sleeve = await coverArtOf(tools.ffmpeg, episode);
      assert.ok(sleeve && sleeve[0] === 0xff && sleeve[1] === 0xd8, "a JPEG");

      const fragmented = makeFragmented(dir);
      const still = await stillFrom(tools.ffmpeg, [fragmented]);
      assert.ok(still && still[0] === 0xff && still[1] === 0xd8, "a JPEG frame of the picture");
      // Handed in the pieces a listener would get, the same.
      const pieces = [fragmented.subarray(0, 4096), fragmented.subarray(4096)];
      assert.ok(await stillFrom(tools.ffmpeg, pieces));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("the art route sends a crawler to the site's picture, and says when there is none", async () => {
  const infos: ChannelInfo[] = [
    { id: "url-site", name: "A video", format: "mp4", via: "pull", startedAt: 1, bytes: 0, listeners: 0, kind: "video", art: "https://i.example/thumb.jpg", about: "Someone — a line" },
    { id: "url-sound", name: "A talk", format: "mp3", via: "pull", startedAt: 1, bytes: 0, listeners: 0, kind: "audio" },
  ];
  const channels = {
    list: () => infos,
    info: (id: string) => infos.find((one) => one.id === id),
    opening: () => [],
    listeners: 0,
  } as unknown as NonNullable<Parameters<typeof createServer>[1]["channels"]>;
  const server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", channels, ffmpeg: ["definitely-not-ffmpeg"] });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const sent = await fetch(`${base}/api/channels/url-site/art`, { redirect: "manual" });
    assert.equal(sent.status, 302);
    assert.equal(sent.headers.get("location"), "https://i.example/thumb.jpg");
    const none = await fetch(`${base}/api/channels/url-sound/art`);
    assert.equal(none.status, 404);
    assert.equal((await fetch(`${base}/api/channels/nope/art`)).status, 404);
    // The list says where each picture is, and the line about it.
    const air = (await (await fetch(`${base}/api/streams`)).json()) as { channels: { id: string; art: string; about: string }[] };
    assert.deepEqual(air.channels.map((one) => [one.id, one.art, one.about]), [
      ["url-site", "https://i.example/thumb.jpg", "Someone — a line"],
      ["url-sound", "", ""],
    ]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test(
  "the art route takes a frame of what a channel is sending",
  { skip: haveFfmpeg ? false : "ffmpeg not available" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "nixamp-art-"));
    const fragmented = makeFragmented(dir);
    const info: ChannelInfo = { id: "url-tv", name: "TV", format: "mp4", via: "pull", startedAt: 1, bytes: 0, listeners: 0, kind: "video" };
    const channels = {
      list: () => [info],
      info: (id: string) => (id === info.id ? info : undefined),
      opening: (id: string) => (id === info.id ? [fragmented] : []),
      listeners: 0,
    } as unknown as NonNullable<Parameters<typeof createServer>[1]["channels"]>;
    const server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", channels, ffmpeg: tools.ffmpeg });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/api/channels/url-tv/art`);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("content-type"), "image/jpeg");
      const bytes = Buffer.from(await answer.arrayBuffer());
      assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

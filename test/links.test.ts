import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentTypeFor, directLink, downloadArgs, fileNameFor, inputArgsFor, isDirectMedia, linkChannelId,
  parseResolved, playableLink, reasonFrom, resolveArgs, resolveLink,
} from "../src/links.ts";

/** What yt-dlp said about a SoundCloud track on 2026-09-10, trimmed. */
const SOUNDCLOUD = {
  title: "Flickermood",
  is_live: null,
  duration: 213.886,
  ext: "m4a",
  vcodec: "none",
  acodec: "mp4a.40.2",
  protocol: "m3u8_native",
  extractor: "soundcloud",
  url: "https://playback.media-streaming.soundcloud.cloud/x/aac_160k/playlist.m3u8",
  http_headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    Accept: "text/html,*/*",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
  },
};

test("a bare file or a playlist is played as it is; a page is asked about", () => {
  assert.equal(isDirectMedia("https://x.example/song.mp3"), true);
  assert.equal(isDirectMedia("https://x.example/live/index.m3u8?token=1"), true);
  assert.equal(isDirectMedia("rtmp://x.example/live/key"), true);
  assert.equal(isDirectMedia("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(isDirectMedia("https://soundcloud.com/forss/flickermood"), false);
  assert.equal(isDirectMedia("not a url"), false);
});

test("only a web link is a link this plays", () => {
  assert.equal(playableLink("  https://soundcloud.com/forss/flickermood "), "https://soundcloud.com/forss/flickermood");
  assert.equal(playableLink("rtmp://x.example/live"), "rtmp://x.example/live");
  assert.equal(playableLink("file:///etc/passwd"), "");
  assert.equal(playableLink("javascript:alert(1)"), "");
  assert.equal(playableLink("soundcloud.com/forss"), "");
  assert.equal(playableLink(42), "");
});

test("the same link is the same channel, so two people pasting it share one decoder", () => {
  assert.equal(linkChannelId("https://a.example/x"), linkChannelId("https://a.example/x"));
  assert.notEqual(linkChannelId("https://a.example/x"), linkChannelId("https://a.example/y"));
  assert.match(linkChannelId("https://a.example/x"), /^url-[0-9a-f]{12}$/);
});

test("yt-dlp's answer is read into what the player needs", () => {
  const link = parseResolved(SOUNDCLOUD, "https://soundcloud.com/forss/flickermood");
  assert.ok(link);
  assert.equal(link?.title, "Flickermood");
  assert.equal(link?.live, false);
  assert.equal(link?.video, false);
  assert.equal(link?.duration, 213.886);
  assert.equal(link?.extractor, "soundcloud");
  assert.equal(link?.ext, "m4a");
  assert.equal(link?.media, SOUNDCLOUD.url);
  assert.deepEqual(Object.keys(link?.headers ?? {}), ["User-Agent", "Accept", "Accept-Language", "Sec-Fetch-Mode"]);

  // A live says so; a missing title falls back to the page's file name.
  const live = parseResolved({ url: "https://x.example/live.m3u8", is_live: true, vcodec: "h264" }, "https://tiktok.com/@a/live");
  assert.equal(live?.live, true);
  assert.equal(live?.video, true);
  assert.equal(live?.title, "live");

  // No media address is no answer.
  assert.equal(parseResolved({ title: "x" }, "https://x.example"), null);
  assert.equal(parseResolved("nope", "https://x.example"), null);
  // A header with a newline in it could smuggle a second header; it is dropped.
  const smuggled = parseResolved({ url: "https://x", http_headers: { Cookie: "a=b\r\nHost: evil" } }, "https://x");
  assert.deepEqual(smuggled?.headers, {});
});

test("a bare file is described without asking anybody", () => {
  const song = directLink("https://x.example/music/01%20-%20Bleed.flac");
  assert.equal(song.title, "01 - Bleed.flac");
  assert.equal(song.video, false);
  assert.equal(song.live, false);
  assert.equal(song.ext, "flac");
  assert.equal(song.extractor, "direct");
  const live = directLink("https://x.example/live/index.m3u8?t=1");
  assert.equal(live.live, true);
  assert.equal(live.video, true);
});

test("the headers a site expects reach ffmpeg the way ffmpeg wants them", () => {
  const args = inputArgsFor(SOUNDCLOUD.http_headers);
  assert.deepEqual(args.slice(0, 2), ["-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"]);
  assert.equal(args[2], "-headers");
  assert.equal(args[3], "Accept: text/html,*/*\r\nAccept-Language: en-us,en;q=0.5\r\nSec-Fetch-Mode: navigate\r\n");
  assert.deepEqual(inputArgsFor({}), []);
});

test("resolving asks for one playable format, and a cookie jar only when there is one", () => {
  const plain = resolveArgs("https://x.example/page");
  assert.equal(plain[0], "-j");
  assert.ok(plain.includes("--no-playlist"));
  assert.equal(plain[plain.length - 1], "https://x.example/page");
  assert.equal(plain[plain.length - 2], "--", "a link starting with a dash is not an option");
  assert.equal(plain.includes("--cookies"), false);
  const jar = resolveArgs("https://x.example/page", "/home/me/cookies.txt");
  assert.ok(jar.includes("--cookies") && jar.includes("/home/me/cookies.txt"));
});

test("a download goes down a pipe, whole, as video or as sound alone", () => {
  const video = downloadArgs("https://x.example/page", false);
  assert.deepEqual(video.slice(0, 2), ["-o", "-"]);
  assert.ok(video.includes("--hls-prefer-native"), "fragments are written as they come");
  const audio = downloadArgs("https://x.example/page", true);
  assert.match(audio[audio.indexOf("-f") + 1] ?? "", /^ba/);
  assert.match(video[video.indexOf("-f") + 1] ?? "", /^b\[vcodec!=none\]/);
});

test("a download is named for the title, safely, with the right ending", () => {
  const link = parseResolved(SOUNDCLOUD, "https://soundcloud.com/forss/flickermood");
  assert.ok(link);
  assert.equal(fileNameFor(link, true), "Flickermood.m4a");
  const film = parseResolved({ ...SOUNDCLOUD, title: 'Top Gun: "Maverick" / 2022', ext: "mp4", vcodec: "h264" }, "https://x");
  assert.ok(film);
  assert.equal(fileNameFor(film, false), "Top Gun Maverick 2022.mp4");
  assert.equal(fileNameFor(film, true), "Top Gun Maverick 2022.m4a");
  assert.equal(contentTypeFor("Flickermood.m4a"), "audio/mp4");
  assert.equal(contentTypeFor("x.mp4"), "video/mp4");
  assert.equal(contentTypeFor("x.weird"), "application/octet-stream");
});

test("yt-dlp's complaint is repeated to the person, without the link to its wiki", () => {
  const stderr = "WARNING: something\nERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how\n";
  assert.equal(
    reasonFrom(stderr),
    "[youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
  );
  assert.equal(reasonFrom(""), "that link could not be read");
});

/** A yt-dlp that answers with a file's contents, or fails as told. */
function fakeYtdlp(answer: string, exitCode = 0): string[] {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-ytdlp-"));
  const script = join(dir, "yt-dlp");
  const body = join(dir, "answer.json");
  writeFileSync(body, answer);
  writeFileSync(script, `#!/bin/sh\nif [ "${exitCode}" != 0 ]; then echo "ERROR: [site] no such thing" >&2; exit ${exitCode}; fi\ncat "${body}"\n`);
  chmodSync(script, 0o755);
  return [script];
}

test("a page is resolved through yt-dlp; a file is not", async () => {
  const link = await resolveLink(fakeYtdlp(JSON.stringify(SOUNDCLOUD)), "https://soundcloud.com/forss/flickermood");
  assert.ok(!("error" in link));
  assert.equal(link.title, "Flickermood");

  // A bare file never runs yt-dlp at all, so a server without it still plays one.
  const file = await resolveLink(null, "https://x.example/song.mp3");
  assert.ok(!("error" in file));
  assert.equal(file.title, "song.mp3");

  // And a page on a server without yt-dlp is a sentence, not a crash.
  const none = await resolveLink(null, "https://soundcloud.com/forss/flickermood");
  assert.ok("error" in none);
  assert.match(none.error, /no yt-dlp/);
});

test("a link yt-dlp cannot read is answered with its reason", async () => {
  const link = await resolveLink(fakeYtdlp("", 1), "https://x.example/gone");
  assert.ok("error" in link);
  assert.equal(link.error, "[site] no such thing");

  const nonsense = await resolveLink(fakeYtdlp("not json"), "https://x.example/odd");
  assert.ok("error" in nonsense);
  assert.match(nonsense.error, /did not say/);
});

test("a link that never answers is given up on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-ytdlp-"));
  const script = join(dir, "yt-dlp");
  writeFileSync(script, "#!/bin/sh\nsleep 30\n");
  chmodSync(script, 0o755);
  const link = await resolveLink([script], "https://x.example/slow", { timeoutMs: 200 });
  assert.ok("error" in link);
  assert.match(link.error, /too long/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentTypeFor, directLink, downloadArgs, fetchPlaylist, fileNameFor, inputArgsFor, isDirectMedia, isPlaylistLink, linkChannelId,
  parsePlaylist, playlistNameOf,
  mergeDownloadArgs, parseResolved, playableLink, reasonFrom, resolveArgs, resolveLink,
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

  // And a link with no extension on a server without yt-dlp is taken as the
  // media it may be -- an IPTV feed at /channel/906 -- and left to ffprobe,
  // which is asked before anything goes on the air. Not an error here.
  const feed = await resolveLink(null, "http://23.152.40.104/tipoffsport/abc/906");
  assert.ok(!("error" in feed));
  assert.equal(feed.media, "http://23.152.40.104/tipoffsport/abc/906");
  assert.equal(feed.extractor, "direct");
  assert.equal(feed.title, "906");
});

test("a feed that was the media all along keeps the pasted address, not the redirect's token", () => {
  // yt-dlp's generic extractor follows an IPTV panel's redirect to a second
  // host with a token minted for that one request. The channel dials the
  // link as pasted, so every redial gets a fresh token.
  const feed = parseResolved(
    { url: "http://23.152.40.73/auth/906.ts?token=once", direct: true, ext: "ts", title: "906", extractor: "generic" },
    "http://23.152.40.104/tipoffsport/abc/906",
  );
  assert.ok(feed);
  assert.equal(feed.media, "http://23.152.40.104/tipoffsport/abc/906");
  assert.equal(feed.title, "906");
  // A page yt-dlp scraped a player off is not the media, and is left alone.
  const scraped = parseResolved({ url: "https://cdn.example/clip.mp4", ext: "mp4", extractor: "generic" }, "https://blog.example/post");
  assert.ok(scraped);
  assert.equal(scraped.media, "https://cdn.example/clip.mp4");
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

test("a picture and a sound kept apart come back as a pair, and are put together by ffmpeg", () => {
  // What yt-dlp prints for a bv*+ba choice: no url of its own, and the two
  // parts under requested_formats, each with its own address and headers.
  const pair = parseResolved({
    title: "Never Gonna Give You Up",
    ext: "mp4",
    extractor: "youtube",
    duration: 212,
    requested_formats: [
      { url: "https://v.example/137", vcodec: "avc1.640028", acodec: "none", ext: "mp4", http_headers: { "User-Agent": "yt", Referer: "https://www.youtube.com/" } },
      { url: "https://a.example/140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", http_headers: { "User-Agent": "yt" } },
    ],
  }, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.ok(pair);
  assert.equal(pair?.media, "https://v.example/137");
  assert.equal(pair?.audio, "https://a.example/140");
  assert.equal(pair?.video, true);
  assert.equal(pair?.ext, "mp4");
  assert.deepEqual(pair?.headers, { "User-Agent": "yt", Referer: "https://www.youtube.com/" });

  // One part only, with sound in it, is a plain link with no pair.
  const one = parseResolved({ requested_formats: [{ url: "https://x.example/18", vcodec: "avc1", acodec: "mp4a" }] }, "https://x");
  assert.equal(one?.media, "https://x.example/18");
  assert.equal(one?.audio, "");
  // A url of its own wins over the parts, and a plain answer has no pair.
  const plain = parseResolved({ url: "https://x.example/file.mp4", vcodec: "h264" }, "https://x");
  assert.equal(plain?.audio, "");

  // Playing asks for a combined format first and a pair second.
  const format = resolveArgs("https://x.example/page")[4] ?? "";
  assert.match(format, /^b\[vcodec!=none\]\[acodec!=none\]\//);
  assert.ok(format.includes("+ba"), "a pair is asked for when there is no combined format");

  // The download of a pair is ffmpeg copying both into one file down a pipe.
  if (!pair) return;
  const merge = mergeDownloadArgs(pair);
  assert.equal(merge.filter((one) => one === "-i").length, 2);
  assert.ok(merge.includes("https://v.example/137") && merge.includes("https://a.example/140"));
  assert.deepEqual(merge.slice(merge.indexOf("-map"), merge.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "1:a:0"]);
  assert.ok(merge.includes("frag_keyframe+empty_moov+default_base_moof"), "an MP4 pair is a fragmented MP4");
  assert.equal(merge[merge.length - 1], "pipe:1");
  assert.equal(fileNameFor(pair, false), "Never Gonna Give You Up.mp4");
  // A VP9 picture goes into Matroska, and the name says so.
  const webm = { ...pair, ext: "webm" };
  assert.ok(mergeDownloadArgs(webm).includes("matroska"));
  assert.equal(fileNameFor(webm, false), "Never Gonna Give You Up.mkv");
  // Sound alone is still yt-dlp's own pipe, named for the sound.
  assert.equal(fileNameFor(pair, true), "Never Gonna Give You Up.m4a");
});

test("a playlist by address is a list of files, not a page and not one stream", async () => {
  // An .m3u is a bare link: ffmpeg cannot read it, but nixamp can, entry by
  // entry, and asking yt-dlp about it only earns a "generic" shrug.
  assert.equal(isDirectMedia("https://p0dcasters.com/podcast/off-protocol/playlist.m3u"), true);
  assert.equal(isDirectMedia("https://radio.example/station.pls"), true);
  assert.equal(isPlaylistLink("https://p0dcasters.com/podcast/off-protocol/playlist.m3u"), true);
  assert.equal(isPlaylistLink("https://x.example/live/index.m3u8"), false, "an .m3u8 is one stream in segments");
  assert.equal(isPlaylistLink("not a url"), false);

  // Named by its address when it does not name itself: the show, not "playlist".
  assert.equal(playlistNameOf("https://p0dcasters.com/podcast/off-protocol/playlist.m3u"), "off protocol");
  assert.equal(playlistNameOf("https://x.example/mixes/late_night-sets.m3u"), "late night sets");
  assert.equal(playlistNameOf("https://x.example/playlist.m3u"), "x.example");

  const direct = directLink("https://p0dcasters.com/podcast/off-protocol/playlist.m3u");
  assert.equal(direct.extractor, "playlist");
  assert.equal(direct.live, false);
  assert.equal(direct.video, false, "no picture is claimed of a list; the first entry is probed");
  assert.equal(direct.title, "off protocol");

  // The text: its own title wins, entries keep theirs, and relative ones are
  // taken against the list's address -- a root-relative one included, since
  // on the web that is what a leading slash means.
  const text = [
    "#EXTM3U",
    "#PLAYLIST:Off Protocol",
    "#EXTINF:3525,A Thousand PRs in Two Weeks",
    "https://media.example/off-protocol/one.mp3",
    "#EXTINF:-1,Second",
    "two.mp3",
    "/home/somebody/private.mp3",
    "#EXTINF:10,Third",
    "https://media.example/three.mp3",
  ].join("\n");
  const list = parsePlaylist(text, "https://p0dcasters.com/podcast/off-protocol/playlist.m3u");
  assert.equal(list.title, "Off Protocol");
  assert.deepEqual(list.entries, [
    { source: "https://media.example/off-protocol/one.mp3", title: "A Thousand PRs in Two Weeks" },
    { source: "https://p0dcasters.com/podcast/off-protocol/two.mp3", title: "Second" },
    { source: "https://p0dcasters.com/home/somebody/private.mp3", title: "private.mp3" },
    { source: "https://media.example/three.mp3", title: "Third" },
  ]);
  const pls = parsePlaylist("[playlist]\nFile1=https://radio.example/a\nTitle1=A\nFile2=https://radio.example/b\n", "https://radio.example/station.pls");
  assert.equal(pls.title, "station");
  assert.equal(pls.entries.length, 2);
  assert.equal(pls.entries[0]?.title, "A");

  // Fetched: a good answer is the list, and every kind of bad answer is a sentence.
  const fetcher = (async (url: string | URL | Request) => {
    const at = String(url);
    if (at.endsWith("/good.m3u")) return new Response(text, { status: 200 });
    if (at.endsWith("/empty.m3u")) return new Response("#EXTM3U\n", { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const good = await fetchPlaylist("https://x.example/good.m3u", fetcher);
  assert.ok(!("error" in good) && good.entries.length === 4);
  const empty = await fetchPlaylist("https://x.example/empty.m3u", fetcher);
  assert.ok("error" in empty && /nothing in it/.test(empty.error));
  const missing = await fetchPlaylist("https://x.example/missing.m3u", fetcher);
  assert.ok("error" in missing && /404/.test(missing.error));
});

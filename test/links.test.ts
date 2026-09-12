import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentTypeFor, directLink, downloadArgs, fileNameFor, inputArgsFor, isDirectMedia, isPlaylistLink, linkChannelId,
  mergeDownloadArgs, parseResolved, playableLink, playlistFrom, playlistNameOf, playlistTitleIn, reasonFrom, resolveArgs, resolveLink, resolvePlaylist,
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

test("a plain .m3u is a list of things to play, not a thing ffmpeg reads", () => {
  assert.equal(isPlaylistLink("https://x.example/shows/playlist.m3u"), true);
  assert.equal(isPlaylistLink("https://x.example/shows/playlist.M3U?v=2"), true);
  // HLS stays direct: a segment list is one stream, and ffmpeg reads it.
  assert.equal(isPlaylistLink("https://x.example/live/index.m3u8"), false);
  assert.equal(isDirectMedia("https://x.example/shows/playlist.m3u"), false);
  assert.equal(isPlaylistLink("https://x.example/song.mp3"), false);
});

test("a playlist's entries come back in order, resolved against where the list lives", () => {
  const text = [
    "#EXTM3U",
    "#EXTINF:3600,Episode one",
    "https://cdn.example/ep1.mp3",
    "#EXTINF:-1,Episode two",
    "ep2.mp3",
    "",
    "/other/ep3.mp3",
    "#EXTINF:1,A dupe",
    "https://cdn.example/ep1.mp3",
  ].join("\n");
  const list = playlistFrom(text, "https://x.example/shows/playlist.m3u");
  assert.equal(list.hls, false);
  assert.deepEqual(list.sources, [
    "https://cdn.example/ep1.mp3",
    "https://x.example/shows/ep2.mp3",
    "https://x.example/other/ep3.mp3",
  ]);
  // A segment list wearing the wrong extension is HLS after all.
  assert.deepEqual(playlistFrom("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\nseg0.ts\n", "https://x.example/a.m3u"), { hls: true, sources: [] });
});

test("a pasted playlist resolves to a station: the first entry probed, every entry kept, no end", async () => {
  const served = (status: number, body: string): typeof fetch =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;
  const list = await resolvePlaylist("https://x.example/shows/off-protocol.m3u", {
    fetcher: served(200, "#EXTM3U\nhttps://cdn.example/ep1.mp3\nhttps://cdn.example/ep2.mp3\n"),
  });
  assert.ok(!("error" in list));
  assert.equal(list.title, "off protocol");
  // A list that names itself is called that; one called "playlist" is
  // called for the folder it sits in, which is the show.
  const named = await resolvePlaylist("https://p0dcasters.com/podcast/off-protocol/playlist.m3u", {
    fetcher: served(200, "#EXTM3U\n#PLAYLIST:Off Protocol\n#EXTINF:10,One\nhttps://cdn.example/ep1.mp3\n"),
  });
  assert.ok(!("error" in named) && named.title === "Off Protocol");
  assert.equal(playlistNameOf("https://p0dcasters.com/podcast/off-protocol/playlist.m3u"), "off protocol");
  assert.equal(playlistNameOf("https://x.example/mixes/late_night-sets.m3u"), "late night sets");
  assert.equal(playlistNameOf("https://x.example/playlist.m3u"), "x.example");
  assert.equal(playlistTitleIn("#EXTM3U\n#PLAYLIST:  Late\u0001 Show \n"), "Late  Show");
  assert.equal(playlistTitleIn("#EXTM3U\n"), "");
  assert.equal(list.media, "https://cdn.example/ep1.mp3");
  assert.deepEqual(list.playlist, ["https://cdn.example/ep1.mp3", "https://cdn.example/ep2.mp3"]);
  assert.equal(list.live, true);
  assert.equal(list.extractor, "playlist");
  assert.equal(list.page, "https://x.example/shows/off-protocol.m3u");
  // HLS in a .m3u is the stream itself.
  const hls = await resolvePlaylist("https://x.example/live.m3u", { fetcher: served(200, "#EXTM3U\n#EXT-X-TARGETDURATION:2\nseg0.ts\n") });
  assert.ok(!("error" in hls) && hls.extractor === "direct" && hls.media === "https://x.example/live.m3u");
  // A list with nothing in it, or a list that is not there, is a sentence.
  const empty = await resolvePlaylist("https://x.example/e.m3u", { fetcher: served(200, "#EXTM3U\n") });
  assert.ok("error" in empty && /nothing in it/.test(empty.error));
  const gone = await resolvePlaylist("https://x.example/g.m3u", { fetcher: served(404, "") });
  assert.ok("error" in gone && /HTTP 404/.test(gone.error));
  // resolveLink knows the shape without yt-dlp, and before asking it.
  const viaResolve = await resolveLink(["false"], "https://x.example/shows/x.m3u", { timeoutMs: 500 });
  assert.ok("error" in viaResolve, "a real fetch of x.example fails, and is an error rather than a yt-dlp run");
});

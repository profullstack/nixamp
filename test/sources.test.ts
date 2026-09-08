import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isHls,
  isPlaylistFile,
  isRemote,
  nameOf,
  parseM3u,
  parsePls,
  playsInBrowser,
  resolveEntry,
} from "../src/sources.ts";
import { readPlaylist } from "../src/playlist.ts";

test("http and https are remote, and nothing else is", () => {
  assert.equal(isRemote("https://example.com/a.mp3"), true);
  assert.equal(isRemote("HTTP://example.com/a.mp3"), true);
  assert.equal(isRemote("/home/anthony/a.mp3"), false);
  assert.equal(isRemote("a.mp3"), false);
  // ffmpeg speaks these; a share link does not.
  assert.equal(isRemote("rtsp://example.com/live"), false);
});

test("a playlist is recognised through a query string", () => {
  assert.equal(isPlaylistFile("/music/set.m3u"), true);
  assert.equal(isPlaylistFile("https://example.com/live.m3u8?token=abc"), true);
  assert.equal(isPlaylistFile("https://example.com/radio.pls"), true);
  assert.equal(isPlaylistFile("/music/song.mp3"), false);
});

test("an HLS playlist is one stream, not a list of songs", () => {
  assert.equal(isHls("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.0,\nseg1.ts\n"), true);
  assert.equal(isHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n'), true);
  assert.equal(isHls("#EXTM3U\n#EXTINF:180,Artist - Song\nsong.mp3\n"), false);
});

test("entries resolve against wherever the playlist lives", () => {
  assert.equal(resolveEntry("/music/set.m3u", "song.mp3"), "/music/song.mp3");
  assert.equal(resolveEntry("/music/set.m3u", "/other/song.mp3"), "/other/song.mp3");
  assert.equal(
    resolveEntry("https://example.com/lists/set.m3u", "song.mp3"),
    "https://example.com/lists/song.mp3",
  );
  // A remote playlist may point anywhere, including back to a local idea of a
  // path, and an absolute URL always wins.
  assert.equal(
    resolveEntry("https://example.com/lists/set.m3u", "https://cdn.example/song.mp3"),
    "https://cdn.example/song.mp3",
  );
});

test("m3u keeps the title and duration EXTINF gave it", () => {
  const text = [
    "#EXTM3U",
    "#EXTINF:213,Meshuggah - Bleed",
    "bleed.flac",
    "#EXTINF:-1,Some Live Radio",
    "https://stream.example/live",
    "",
    "# a comment",
    "untitled.mp3",
  ].join("\n");

  const entries = parseM3u(text, "/music/set.m3u");
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    source: "/music/bleed.flac",
    title: "Meshuggah - Bleed",
    duration: 213,
  });
  // -1 is the conventional unknown, which is what live is.
  assert.equal(entries[1]?.duration, 0);
  assert.equal(entries[1]?.source, "https://stream.example/live");
  // A line with no EXTINF before it still plays, named after itself, and does
  // not inherit the previous entry's title.
  assert.deepEqual(entries[2], { source: "/music/untitled.mp3", title: "untitled.mp3", duration: 0 });
});

test("pls entries come back in numeric order, not string order", () => {
  const text = [
    "[playlist]",
    "File2=https://stream.example/two",
    "Title2=Two",
    "Length2=-1",
    "File10=three.mp3",
    "Title10=Ten",
    "File1=one.mp3",
    "Title1=One",
    "Length1=120",
  ].join("\n");

  const entries = parsePls(text, "/music/radio.pls");
  assert.deepEqual(entries.map((e) => e.title), ["One", "Two", "Ten"]);
  assert.equal(entries[0]?.duration, 120);
  assert.equal(entries[1]?.duration, 0);
  assert.equal(entries[2]?.source, "/music/three.mp3");
});

test("a name falls back to the last part of a path or URL", () => {
  assert.equal(nameOf("/music/Some%20Song.mp3"), "Some%20Song.mp3");
  assert.equal(nameOf("https://example.com/a/Some%20Song.mp3"), "Some Song.mp3");
  assert.equal(nameOf("https://example.com/live/"), "live");
});

test("only formats a browser plays are handed over untouched", () => {
  assert.equal(playsInBrowser("/music/a.mp3"), true);
  assert.equal(playsInBrowser("/music/a.M4A"), true);
  assert.equal(playsInBrowser("/music/a.flac"), false);
  assert.equal(playsInBrowser("/music/a.wma"), false);
  // Remote is never handed over untouched: it may be live, and it may be
  // anything at all.
  assert.equal(playsInBrowser("https://example.com/a.mp3"), false);
});

test("reading a local m3u gives its entries, and an HLS one gives itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-m3u-"));
  try {
    const list = join(dir, "set.m3u");
    writeFileSync(list, "#EXTM3U\n#EXTINF:100,A Song\nsong.mp3\n");
    const entries = await readPlaylist(list);
    assert.deepEqual(entries, [{ source: join(dir, "song.mp3"), title: "A Song", duration: 100 }]);

    const hls = join(dir, "live.m3u8");
    writeFileSync(hls, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.0,\nseg1.ts\n");
    assert.deepEqual(await readPlaylist(hls), [{ source: hls, title: "live.m3u8", duration: 0 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

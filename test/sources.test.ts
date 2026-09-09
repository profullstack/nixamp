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
  sourceLabel,
} from "../src/sources.ts";
import { loadTagged, readPlaylist, readRemoteIndex } from "../src/playlist.ts";

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

test("tagging yields, so a server can answer while it reads its library", async () => {
  // The invariant is that the loop awaits once per file, so anything else
  // waiting on the event loop gets a turn between them. Asserted by watching
  // the order things actually happen in rather than by racing a timer against
  // real ffprobes, which is only a race at all on a machine that has ffprobe:
  // CI does not, the probes resolved instantly, and the race flipped.
  const dir = mkdtempSync(join(tmpdir(), "nixamp-tagging-"));
  try {
    for (let at = 0; at < 5; at += 1) writeFileSync(join(dir, `s${at}.mp3`), "");

    const order: string[] = [];
    const probeOne = async (_tools: unknown, path: string) => {
      await new Promise<void>((done) => setTimeout(done, 0));
      order.push("file");
      return { path, title: path, artist: "", album: "", duration: 0 };
    };
    setTimeout(() => order.push("loop"), 0);

    const tools = { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null };
    const tagged = await loadTagged(tools, dir, probeOne as never);

    assert.equal(tagged.length, 5, "and it still reads every file");
    // The loop got its turn while the pass was running, not after it.
    assert.ok(order.includes("loop"), "the event loop never ran");
    assert.ok(order.indexOf("loop") < order.length - 1, "it only ran once everything was done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("and the same test fails when the loop does not yield", async () => {
  // Guarding the guard: a probe that resolves without ever reaching a
  // macrotask is what a synchronous pass looks like from here, and the
  // assertion above has to notice.
  const dir = mkdtempSync(join(tmpdir(), "nixamp-tagging-sync-"));
  try {
    for (let at = 0; at < 5; at += 1) writeFileSync(join(dir, `s${at}.mp3`), "");
    const order: string[] = [];
    const instant = async (_tools: unknown, path: string) => {
      order.push("file");
      return { path, title: path, artist: "", album: "", duration: 0 };
    };
    setTimeout(() => order.push("loop"), 0);

    const tools = { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null };
    await loadTagged(tools, dir, instant as never);

    // Every file was read before the event loop got anywhere near a timer,
    // which is precisely the failure the other test is there to catch.
    assert.deepEqual(order, ["file", "file", "file", "file", "file"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder served over http is a folder, not a page to decode", async () => {
  // What an Apache autoindex actually looks like: relative links, sort links
  // at the top of every column, and a parent directory nobody wants.
  const html = `<html><body>
    <a href="?C=N&amp;O=D">Name</a><a href="?C=S;O=A">Size</a>
    <a href="/parent/">Parent Directory</a>
    <a href="02%20-%20Boston%20Chicken.mp3">02 - Boston Chicken.mp3</a>
    <a href="01%20-%20I%27ve%20Got%20No%20Darkside.mp3">01 …</a>
    <a href="cover.jpg">cover.jpg</a>
    <a href="Disc%202/">Disc 2/</a>
  </body></html>`;
  const send = (async () =>
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;

  const found = await readRemoteIndex("http://box.example:19499/Album%20Name/", send);
  assert.deepEqual(
    found.map((entry) => entry.title),
    ["01 - I've Got No Darkside.mp3", "02 - Boston Chicken.mp3"],
    "audio only, named as a person wrote them, in order rather than in the server's",
  );
  // Resolved against the page, which is how an index writes its links.
  assert.equal(found[1]?.source, "http://box.example:19499/Album%20Name/02%20-%20Boston%20Chicken.mp3");

  // Anything that is not a page is the thing itself, and the caller plays it.
  const audio = (async () =>
    new Response("", { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
  assert.deepEqual(await readRemoteIndex("http://box.example/live", audio), []);

  // A server having a bad day is nothing to play, not an exception to handle
  // three layers up.
  const refused = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
  assert.deepEqual(await readRemoteIndex("http://box.example/gone/", refused), []);
  const offline = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await readRemoteIndex("http://box.example/gone/", offline), []);
});

test("a source is named by what it is, not by the whole URL", () => {
  // The heading over a block of the playlist, so it has to read like the name
  // of the thing somebody added.
  assert.equal(sourceLabel("https://x.test/music/%5B1982%5D%20How%20Could%20Hell/"), "[1982] How Could Hell");
  assert.equal(sourceLabel("https://x.test/music/album"), "album");
  assert.equal(sourceLabel("/home/me/Downloads/done"), "done");
  assert.equal(sourceLabel("/home/me/Downloads/done/"), "done");
  // A URL with nothing but a host has no last segment to take, and repeating
  // the whole address over every row is not a heading.
  assert.equal(sourceLabel("https://x.test/"), "x.test");
  assert.equal(sourceLabel("https://x.test"), "x.test");
});

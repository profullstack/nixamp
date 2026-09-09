import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clamp, displayName, formatTime, isVideoFile, titleFromFilename } from "../src/format.ts";
import { bandEdges, bands, decay, holdPeaks } from "../src/spectrum.ts";
import { apiUrl, blockedAsMixedContent, mediaUrl, normalizeBase, parseSnapshot, splitShareLink } from "../src/remote.ts";
import { byName, isPlayable } from "../src/player.ts";
import { NEVER_CACHE, serviceWorkerSource } from "../scripts/sw.ts";
import { Bitmap, crc32, drawIcon, encodePng, ICONS } from "../scripts/icons.ts";

const webDir = fileURLToPath(new URL("..", import.meta.url));

test("times and names are formatted as the terminal app formats them", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(65), "01:05");
  assert.equal(formatTime(447), "07:27");
  assert.equal(formatTime(-1), "--:--");
  assert.equal(formatTime(Number.NaN), "--:--");
  assert.equal(formatTime(Number.POSITIVE_INFINITY), "--:--");

  assert.equal(displayName({ title: "Bleed", artist: "Meshuggah" }), "Meshuggah — Bleed");
  assert.equal(displayName({ title: "Untitled", artist: "" }), "Untitled");

  assert.equal(titleFromFilename("/music/01 - Bleed.flac"), "01 - Bleed");
  assert.equal(titleFromFilename("noextension"), "noextension");
  assert.equal(clamp(5, 0, 1), 1);
});

test("video is told from audio by type first and extension second", () => {
  assert.equal(isVideoFile("clip.mp4"), true);
  assert.equal(isVideoFile("clip.webm"), true);
  assert.equal(isVideoFile("song.flac"), false);
  // An mp4 that is really an audio file says so in its type.
  assert.equal(isVideoFile("song.mp4", "audio/mp4"), false);
  assert.equal(isVideoFile("no-extension", "video/webm"), true);
});

test("playable files are recognised, and a playlist sorts the way a person reads", () => {
  assert.equal(isPlayable("a.flac"), true);
  assert.equal(isPlayable("a.FLAC"), true);
  assert.equal(isPlayable("cover.jpg"), false);
  assert.equal(isPlayable("notes.txt"), false);
  assert.equal(isPlayable("weird", "audio/ogg"), true);

  const names = ["10 ten.mp3", "2 two.mp3", "1 one.mp3"].sort(byName);
  assert.deepEqual(names, ["1 one.mp3", "2 two.mp3", "10 ten.mp3"]);
});

test("bands are logarithmic, cover every bin, and never come out empty", () => {
  const edges = bandEdges(24, 1024);
  assert.equal(edges.length, 25);
  assert.equal(edges[24], 1024);
  for (let i = 1; i < edges.length; i++) {
    assert.ok((edges[i] as number) > (edges[i - 1] as number), `edge ${i} did not advance`);
  }
  // Logarithmic means the low bands are narrow and the high ones are wide.
  assert.ok((edges[1] as number) - (edges[0] as number) < (edges[24] as number) - (edges[23] as number));

  const data = new Uint8Array(1024).fill(255);
  const values = bands(data, edges);
  assert.equal(values.length, 24);
  for (const value of values) assert.equal(value, 1);

  assert.deepEqual(bands(new Uint8Array(1024), edges).filter((v) => v !== 0), []);
});

test("bars rise instantly and fall gradually, and peaks sink", () => {
  assert.deepEqual(decay([0, 0], [1, 1]), [1, 1]);
  // A fall is limited; a rise is not.
  assert.deepEqual(decay([1], [0], 0.1), [0.9]);
  assert.deepEqual(decay([1], [0.95], 0.1), [0.95]);
  // Never below the value actually measured.
  assert.deepEqual(decay([0.05], [0], 0.5), [0]);

  assert.deepEqual(holdPeaks([0.8], [0.2], 0.02), [0.78]);
  assert.deepEqual(holdPeaks([0.2], [0.9], 0.02), [0.9]);
});

test("an address a person types becomes an address a browser can use", () => {
  assert.equal(normalizeBase("192.168.1.7:4321"), "http://192.168.1.7:4321");
  assert.equal(normalizeBase("  http://box.local:4321/  "), "http://box.local:4321");
  assert.equal(normalizeBase("https://nixamp.com"), "https://nixamp.com");
  // A pasted endpoint means the server it belongs to.
  assert.equal(normalizeBase("http://box:4321/api/state"), "http://box:4321");
  assert.equal(normalizeBase("http://box:4321/api"), "http://box:4321");
  assert.equal(normalizeBase(""), "");
  assert.equal(normalizeBase("   "), "");

  assert.equal(apiUrl("192.168.1.7:4321", "/api/state"), "http://192.168.1.7:4321/api/state");
  assert.equal(apiUrl("", "/api/state"), "/api/state");
  assert.equal(mediaUrl("http://box:4321", 3), "http://box:4321/api/media/3");
});

test("a snapshot off the wire is checked, not trusted", () => {
  const good = parseSnapshot({
    revision: 4,
    tracks: [{ title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 }],
    index: 0, playing: true, position: 12.5,
    bars: [0.1, 0.2], levels: [0.5, 0.6], silent: false, note: "", root: "/m",
  });
  assert.equal(good?.tracks?.length, 1);
  assert.equal(good?.playing, true);
  assert.equal(good?.position, 12.5);

  // Missing and wrong-typed fields become defaults rather than exceptions.
  const partial = parseSnapshot({ tracks: [{}] });
  assert.equal(partial?.tracks?.[0]?.title, "Untitled");
  assert.equal(partial?.revision, 0);
  assert.deepEqual(partial?.levels, [0, 0]);
  assert.equal(parseSnapshot({ tracks: [], position: "soon" })?.position, 0);
  assert.equal(parseSnapshot({ tracks: [], playing: "yes" })?.playing, false);

  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot("nope"), null);

  // A frame carries the library only when it has changed, so one without it is
  // ordinary. Rejecting those would throw away every frame but the first --
  // which is to say all the motion.
  const lean = parseSnapshot({ revision: 7, index: 3, playing: true, trackCount: 5778 });
  assert.equal(lean?.tracks, undefined, "no news about the list, rather than an empty list");
  assert.equal(lean?.trackCount, 5778, "and a count, so a client still knows how many");
  assert.equal(lean?.index, 3);

  // The flag that decides whether a file gets a picture survives the rebuild.
  const film = parseSnapshot({ tracks: [{ title: "A Film.mkv", video: true }] });
  assert.equal(film?.tracks?.[0]?.video, true);
  const song = parseSnapshot({ tracks: [{ title: "A Song.flac" }] });
  assert.equal(song?.tracks?.[0]?.video, undefined);
});

test("the manifest has everything an install prompt asks for", () => {
  const manifest = JSON.parse(
    readFileSync(join(webDir, "public/manifest.webmanifest"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(manifest.name, "nixamp — it really whips the terminal's ass");
  assert.equal(manifest.short_name, "nixamp");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#080c09");
  assert.equal(manifest.background_color, "#080c09");

  const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
  const sizes = icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"), "no 192 icon");
  assert.ok(sizes.includes("512x512"), "no 512 icon");
  const maskable = icons.filter((icon) => icon.purpose === "maskable").map((i) => i.sizes);
  assert.deepEqual(maskable.sort(), ["192x192", "512x512"]);
});

test("every icon the manifest names exists, and is the PNG it claims to be", () => {
  const manifest = JSON.parse(
    readFileSync(join(webDir, "public/manifest.webmanifest"), "utf8"),
  ) as { icons: { src: string; sizes: string }[] };

  for (const icon of [...manifest.icons.map((i) => i.src), "/apple-touch-icon.png"]) {
    const bytes = readFileSync(join(webDir, "public", icon.replace(/^\//, "")));
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${icon} is not a PNG`,
    );
    // IHDR sits at a fixed offset: width and height as big-endian 32-bit ints.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, height, `${icon} is not square`);
    const declared = manifest.icons.find((i) => i.src === icon)?.sizes;
    if (declared) assert.equal(`${width}x${height}`, declared, `${icon} is not ${declared}`);
  }

  // The generator and the manifest agree on the set.
  assert.deepEqual(
    ICONS.map((i) => `/${i.file}`).filter((f) => f.startsWith("/icons/")).sort(),
    manifest.icons.map((i) => i.src).sort(),
  );
});

test("icons are drawn, and the PNG encoder produces what it says", () => {
  const bitmap = drawIcon(64, true);
  assert.equal(bitmap.width, 64);
  // A maskable icon paints its corners; the launcher decides the shape.
  assert.notEqual(bitmap.pixels[3], 0);
  const png = encodePng(bitmap);
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);

  // A non-maskable icon has transparent corners instead.
  assert.equal(drawIcon(64, false).pixels[3], 0);

  const flat = new Bitmap(2, 2);
  flat.fill({ r: 1, g: 2, b: 3, a: 255 });
  assert.deepEqual([...flat.pixels.subarray(0, 4)], [1, 2, 3, 255]);
  // The CRC of "IEND" is the one every PNG in the world ends with.
  assert.equal(crc32(new TextEncoder().encode("IEND")), 0xae426082);
});

test("the service worker precaches the shell and never caches the control API", () => {
  const source = serviceWorkerSource(["/assets/app-abc123.js", "/icons/icon-192.png"], "build-7");
  assert.match(source, /const CACHE = "nixamp-build-7"/);
  assert.match(source, /\/assets\/app-abc123\.js/);
  assert.match(source, /"\/index\.html"/);
  assert.match(source, /skipWaiting/);
  assert.match(source, /clients\.claim/);
  // A navigation offline has to answer with the shell, or "installable" is a lie.
  assert.match(source, /caches\.match\("\/index\.html"\)/);
  assert.deepEqual(NEVER_CACHE, ["/api/"]);
  assert.match(source, /NEVER_CACHE\.some/);

  // The precache list is deduplicated, so a repeat cannot be cached twice.
  const twice = serviceWorkerSource(["/index.html", "/index.html", "/a.js"], "x");
  const list = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(twice)?.[1] ?? "[]") as string[];
  assert.deepEqual(list, ["/", "/a.js", "/index.html"]);
});

test("the shell links the manifest, the icons and the theme colour", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="theme-color" content="#080c09"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(html, /<meta name="viewport"/);
  // Every id app.ts reaches for has to be in the shell.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  for (const [, id] of app.matchAll(/need<[^>]+>\("([^"]+)"\)/g)) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from index.html`);
  }
});


test("the service worker can receive a push and act on a click", () => {
  const source = serviceWorkerSource(["/assets/app-abc123.js"], "build-9");

  // Without these two the whole notification feature is silent: a push would
  // arrive at a worker that ignores it, and a click would go nowhere.
  assert.match(source, /addEventListener\("push"/);
  assert.match(source, /addEventListener\("notificationclick"/);
  assert.match(source, /showNotification\(/);

  // A push with no payload still shows something. Some services strip bodies,
  // and a silent push is worse than a vague one.
  assert.match(source, /Someone you follow is live/);

  // Clicking focuses a window we already have rather than opening a fourth
  // copy of the app, which is what openWindow-every-time does.
  assert.match(source, /matchAll\(/);
  assert.match(source, /openWindow\(/);
});

test("an https page cannot reach an http server, and says so before trying", () => {
  // The browser refuses this without sending it, so "no nixamp answered there"
  // would be a lie about a server that is answering perfectly well.
  const why = blockedAsMixedContent("http://104.152.209.195:4321", "https:");
  assert.match(why, /https page/);
  assert.match(why, /--tls-cert/);

  // Everything else is somebody else's problem, and is left alone.
  assert.equal(blockedAsMixedContent("https://nixamp.example.com", "https:"), "");
  assert.equal(blockedAsMixedContent("http://192.168.1.5:4321", "http:"), "", "an http page may reach http");
  assert.equal(blockedAsMixedContent("http://localhost:4321", "file:"), "", "the desktop app is not a page");
});

test("a pasted share link is an address and a key, and both are needed", () => {
  // What people actually paste. Kept whole it is a 404 -- there is no
  // /s/KEY/api/state -- and with the key thrown away every request from
  // another origin is a 401. Neither half is optional.
  assert.deepEqual(splitShareLink("https://chovy.nixamp.com:4321/s/kk8a7LvceeVg1NassmuBwA"), {
    base: "https://chovy.nixamp.com:4321",
    key: "kk8a7LvceeVg1NassmuBwA",
  });
  // Trailing slash, and the query form the API itself takes.
  assert.deepEqual(splitShareLink("http://box.local:4321/s/ABC/"), {
    base: "http://box.local:4321",
    key: "ABC",
  });
  assert.deepEqual(splitShareLink("http://box.local:4321/?k=ABC"), {
    base: "http://box.local:4321",
    key: "ABC",
  });
  // A plain address is a server with no key, which is what --no-key serves.
  assert.deepEqual(splitShareLink("http://box.local:4321"), { base: "http://box.local:4321", key: "" });
  assert.deepEqual(splitShareLink(""), { base: "", key: "" });

  // The key rides in the query, because from another origin nothing else can
  // carry it: a cookie is same-origin, and a server answering
  // access-control-allow-origin: * is one browsers refuse to send credentials to.
  assert.equal(apiUrl("http://box:4321", "/api/state", "K"), "http://box:4321/api/state?k=K");
  // And it joins a query that already exists rather than starting a second one.
  assert.equal(mediaUrl("http://box:4321", 3, 1500, "K"), "http://box:4321/api/media/3?kbps=1500&k=K");
  assert.equal(apiUrl("http://box:4321", "/api/state"), "http://box:4321/api/state");
});

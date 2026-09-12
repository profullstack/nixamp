import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clamp, displayName, formatTime, isVideoFile, titleFromFilename } from "../src/format.ts";
import { bandEdges, bands, decay, holdPeaks } from "../src/spectrum.ts";
import {
  apiUrl, blockedAsMixedContent, canPlayHevc, mediaUrl, needsAName, normalizeBase, parseSnapshot,
  probeServer, refusesUs, splitShareLink,
} from "../src/remote.ts";
import { byName, isPlayable, isTransportFile, needsVideoElement } from "../src/player.ts";
import { isTelevision, pageSize, pageWindow } from "../src/tv.ts";
import { fixtureState, kickoff, scoreLine } from "../src/score.ts";
import { isMatchupName } from "../../src/matchup.ts";
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

test("a raw transport stream is media, and it needs its own engine", () => {
  // A `.ts` recording dragged into the page: 1080p or 4K television as it came
  // off the wire. It was filtered out of the list as if it were not media, and
  // a browser handed one as though it were an MP4 plays nothing at all --
  // mpegts.js is what opens it.
  for (const name of ["match.ts", "capture.m2ts", "recording.MTS", "dump.trp"]) {
    assert.equal(isPlayable(name), true, name);
    assert.equal(isVideoFile(name), true, `${name} belongs in the video element`);
    assert.equal(isTransportFile(name), true, name);
    assert.equal(needsVideoElement(true, "mpegts"), true);
  }
  assert.equal(isTransportFile("song.mp3"), false);
  assert.equal(isTransportFile("film.mp4"), false);
});

test("the server is told whether this browser decodes H.265", () => {
  // The one thing about a 4K film the server cannot work out for itself, and
  // the difference between copying it through untouched and re-encoding it.
  assert.equal(canPlayHevc({ canPlayType: () => "probably" }), true);
  assert.equal(canPlayHevc({ canPlayType: () => "maybe" }), true);
  assert.equal(canPlayHevc({ canPlayType: () => "" }), false);
  assert.equal(canPlayHevc({ canPlayType: () => { throw new Error("no"); } }), false);

  assert.equal(mediaUrl("http://box:4321", 3, 0, "", true), "http://box:4321/api/media/3?hevc=1");
  assert.equal(mediaUrl("http://box:4321", 3, 1500, "K", true), "http://box:4321/api/media/3?kbps=1500&hevc=1&k=K");
  // Said only when true, so the URL a browser without it asks for is the one
  // it always asked for.
  assert.equal(mediaUrl("http://box:4321", 3, 0, "", false), "http://box:4321/api/media/3");
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


test("the shell says what nixamp is, and asks a stranger to sign up", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  // The title is what a search result and a link preview show. It has to say
  // what the thing is, and it must not dare anybody to send a takedown.
  assert.match(html, /<title>nixamp: broadcast live radio, TV and film from your own machine<\/title>/);
  assert.doesNotMatch(html, /DMCA/);
  // The pitch is in the shell itself, hidden until app.ts decides, so a
  // crawler reads it without running anything.
  assert.match(html, /id="welcome"[^>]*hidden/);
  assert.match(html, /id="welcome-create"/);
  assert.match(html, /id="welcome-browse"/);
  assert.match(html, /id="welcome-hide"/);
  assert.match(html, /curl -fsSL https:\/\/nixamp\.com\/install\.sh \| sh/);
  // And app.ts only ever shows it where accounts live.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  assert.match(app, /dom\.welcome\.hidden = !keepsAccounts \|\| meId !== ""/);
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
  // /a/KEY/api/state -- and with the key thrown away every request from
  // another origin is a 401. Neither half is optional.
  assert.deepEqual(splitShareLink("https://chovy.nixamp.com:4321/admin/kk8a7LvceeVg1NassmuBwA"), {
    base: "https://chovy.nixamp.com:4321",
    key: "kk8a7LvceeVg1NassmuBwA",
  });
  // Trailing slash, and the query form the API itself takes.
  assert.deepEqual(splitShareLink("http://box.local:4321/view/ABC/"), {
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

test("a connected server plays on this device unless you say otherwise", () => {
  // The default that made picking your own server look like a broken player:
  // unticked, the server plays through its own speakers and the phone in your
  // hand draws bars in silence. Whether it is ticked is the whole feature, so
  // it is asserted on the shipped markup rather than on a variable.
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const box = /<input id="listen-here" type="checkbox"([^>]*)\/>/.exec(html);
  assert.ok(box, "#listen-here is missing from index.html");
  assert.match(box[1] ?? "", /\bchecked\b/);

  // And an explicit "no" is what turns it off, so an empty setting keeps the
  // default rather than reading as false.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  assert.match(app, /localStorage\.getItem\(LISTEN_HERE_KEY\) === "0"/);
});

test("nothing in the transport can push the page wider than a phone", () => {
  // Measured, not guessed: at an iPhone's 390px the transport row was 413px
  // wide, and a page wider than the screen is one iOS will not scroll straight
  // down -- which is what "I can't scroll to the bottom" was.
  //
  // A stylesheet cannot be laid out here, so this guards the two declarations
  // that let the row fit rather than re-measuring it. The measurement itself
  // needs a browser at 390px wide.
  const css = readFileSync(join(webDir, "src/styles.css"), "utf8");

  // A range input's default width is ~130px and a flex item will not shrink
  // below its own content without this.
  const range = /input\[type="range"\] \{([^}]*)\}/.exec(css);
  assert.ok(range, "the range rule is gone");
  assert.match(range[1] ?? "", /min-width:\s*0/);

  // Four buttons and a slider do not fit across a phone, so the row wraps.
  const transport = /\.transport \{([^}]*)\}/.exec(css);
  assert.ok(transport, "the transport rule is gone");
  assert.match(transport[1] ?? "", /flex-wrap:\s*wrap/);
});

test("the installed app is padded away from every edge of the phone", () => {
  // Installed on an iPhone this runs edge to edge under the status bar and the
  // home indicator both. Only the bottom inset was honoured, so the header sat
  // behind the clock.
  const css = readFileSync(join(webDir, "src/styles.css"), "utf8");
  const app = /#app \{([^}]*)\}/.exec(css);
  assert.ok(app, "the #app rule is gone");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(app[1] ?? "", new RegExp(`env\\(safe-area-inset-${side}\\)`), `no ${side} inset`);
  }
  // And the meta that makes those insets non-zero in the first place.
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  assert.match(html, /viewport-fit=cover/);
});

test("a share link has to be taken apart before a server is asked anything", async () => {
  // A nixamp with a key: the key rides in ?k=, and /a/KEY is a page for people
  // rather than a prefix the API lives under.
  const KEY = "sekrit";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/health") {
      response.writeHead(404).end("no such endpoint");
      return;
    }
    if (url.searchParams.get("k") !== KEY) {
      response.writeHead(401).end("no key");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "nixamp", version: "test" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const shareLink = `${origin}/admin/${KEY}`;

  try {
    // The bug, kept here so it cannot come back: pasted whole, the link is not
    // an address. Probing it asks for /a/KEY/api/health, gets a 404, and the
    // page reports "no nixamp answered there" about a server that was healthy
    // the whole time -- which is what picking your own server did.
    assert.equal(await probeServer(normalizeBase(shareLink)), null);

    // Split, and with the key, because a keyed server refuses even the health
    // check without one.
    const { base, key } = splitShareLink(shareLink);
    assert.equal(base, origin);
    assert.equal(key, KEY);
    assert.equal(await probeServer(base, undefined, key), "test");
    // The key really is load-bearing: right address, no key, still no.
    assert.equal(await probeServer(base), null);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("connecting splits the link and carries the key", () => {
  // The two calls the handler makes. Asserted on the source because the
  // handler needs a DOM to run, and the test above is what proves why it
  // matters.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const handler = app.slice(app.indexOf('dom.remoteForm.addEventListener("submit"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.match(body, /splitShareLink\(/);
  assert.match(body, /probeServer\(base, undefined, key\)/);
  // And what gets saved is the link with its key, not the bare address: a
  // reload that reconnects without the key is refused by its own server.
  assert.match(body, /setItem\(REMOTE_KEY, typed\.trim\(\)\)/);
});

test("a song goes to the audio element even when its URL says nothing", () => {
  // The bug this exists for: a nixamp serves /api/media/12, which has no
  // extension, so the kind comes back "unknown". Reading that as "not audio"
  // sent every remote song to the <video> element -- which is hidden for a
  // track with no picture. Chrome plays audio out of a display:none video;
  // iOS Safari does not, so a phone connected to a server was silent.
  assert.equal(needsVideoElement(false, "unknown"), false);
  assert.equal(needsVideoElement(false, "audio"), false);
  assert.equal(needsVideoElement(false, "mp4"), false);

  // A film goes to the video element, said by the server rather than guessed.
  assert.equal(needsVideoElement(true, "unknown"), true);
  assert.equal(needsVideoElement(true, "mp4"), true);

  // The streaming kinds want the video element whatever they carry.
  assert.equal(needsVideoElement(false, "hls"), true);
  assert.equal(needsVideoElement(false, "mpegts"), true);
});

test("a server that has already refused us says so instead of retrying forever", async () => {
  const KEY = "sekrit";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Health answers anybody: it is how you check a port is open. This is
    // exactly why a healthy answer is not permission.
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "nixamp", version: "test" }));
      return;
    }
    const offered = url.searchParams.get("k");
    if (offered === null) {
      response.writeHead(401).end('{"error":"needs the key"}');
      return;
    }
    if (offered === "listen-only") {
      response.writeHead(403).end('{"error":"can listen, not drive"}');
      return;
    }
    if (offered !== KEY) {
      response.writeHead(401).end('{"error":"needs the key"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ revision: 1, trackCount: 0, index: 0 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Healthy, and still refusing us. Connecting on the strength of the health
    // check alone is what left the page saying "reconnecting..." forever: an
    // event stream cannot report a 401, it can only retry.
    assert.equal(await probeServer(base), "test");
    assert.match(await refusesUs(base), /share link/);
    assert.match(await refusesUs(base, "wrong"), /not accepted/);
    assert.match(await refusesUs(base, "listen-only"), /listen but not drive/);

    // With the right key there is nothing to say, and connecting goes ahead.
    assert.equal(await refusesUs(base, KEY), "");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an https address for a bare IP is named as the problem it is", () => {
  // The report this exists for: a running server, reached by its IP over
  // https, reported as "nothing answered" -- because a browser refuses a
  // certificate it cannot match to a name, and a refused connection and an
  // absent machine look the same from here.
  assert.match(needsAName("https://104.152.209.195:4321"), /certificate is issued for a name/);
  assert.match(needsAName("https://[2a0a:4cc0::1]:4321"), /certificate is issued for a name/);

  // A name is exactly what a certificate can cover, so nothing to say.
  assert.equal(needsAName("https://server1.chovy.nixamp.com:4321"), "");
  // And http never had a certificate to fail.
  assert.equal(needsAName("http://104.152.209.195:4321"), "");
  assert.equal(needsAName(""), "");
});

test("connecting asks the server you connected to whether you may administer it", () => {
  // It never did. Whether the Admin panel appeared was decided by whatever
  // host served the page at load time, which has nothing to do with the
  // machine in front of you -- so re-streaming looked broken on any host that
  // did not happen to answer yes.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const handler = app.slice(app.indexOf('dom.remoteForm.addEventListener("submit"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.match(body, /remote\.connect\(typed\);/);
  assert.match(body, /void checkAdmin\(\);/);
});

test("an admin action says what it did somewhere that is not overwritten", () => {
  // The status line beside it refreshes every two seconds with a listener
  // count, so "Added 16 tracks" was replaced before it could be read -- which
  // is what "re-streaming does not work" looked like when it had worked.
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  assert.match(html, /id="admin-said"/);

  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // Every answer to an action goes through the helper, and none of them are
  // written into the polled line.
  assert.match(app, /function said\(message: string\): void/);

  // Each thing an admin can start, and what it says about how it went. Named
  // rather than sliced out of one handler: putting something on the air and
  // adding it to the library are two actions now, and both have to answer.
  for (const action of ["function goLive(", "dom.adminAdd.addEventListener"]) {
    const from = app.indexOf(action);
    assert.notEqual(from, -1, `${action} is gone`);
    const body = app.slice(from, from + 3000);
    assert.match(body, /said\(/);
    assert.equal(
      /dom\.adminNote\.textContent/.test(body), false,
      `${action} wrote to the polled status line`,
    );
  }
});

test("full screen is offered for a film and not for a song", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  assert.match(html, /id="fullscreen"/);
  // Hidden in the markup, because nothing is playing when the page opens.
  assert.match(html, /id="fullscreen"[^>]*hidden/);

  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // It appears and disappears with the picture, rather than sitting there
  // greyed out over a song.
  const show = app.slice(app.indexOf("function showVideo"));
  assert.match(show.slice(0, 400), /dom\.fullscreen\.hidden = !on/);
  // iOS Safari has no Fullscreen API on a video; webkitEnterFullscreen is the
  // only way a video goes full screen on an iPhone at all.
  assert.match(app, /webkitEnterFullscreen/);
});

test("there is nothing to administer until you are connected to something", () => {
  // Asked with no remote, the admin check went to whichever host served the
  // page -- and nixamp.com runs with no share key, which means "anyone who can
  // reach this port may drive it", so it answered yes to everybody. An Admin
  // panel sat there before you had connected anywhere, with a re-stream box
  // belonging to the wrong machine that did nothing useful when you typed in
  // it.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const check = app.slice(app.indexOf("const checkAdmin = async"));
  const body = check.slice(0, check.indexOf("\n  };"));
  assert.match(body, /if \(mode !== "remote"\)/);
  // And it hides them rather than leaving whatever was last drawn on screen.
  const early = body.slice(0, body.indexOf("return;"));
  assert.match(early, /dom\.adminPanel\.hidden = true/);
  assert.match(early, /dom\.publishPanel\.hidden = true/);
});

test("an invited link opens the stream rather than demanding an account first", () => {
  // It waited for a sign-in, on the reasoning that a stream can ask to be paid
  // for. But only the audio is ever gated, and only once a stream is busier
  // than its free allowance -- so demanding a sign-up before anybody has even
  // seen what they were sent walls off exactly the person an invite is for.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const fn = app.slice(app.indexOf("function openInvitedStream"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.equal(/meId === ""/.test(body), false, "still gated on an account");
  assert.match(body, /requestSubmit\(\)/);
});

test("being asked for money is said as money, not as a broken file", () => {
  // A media element reports "it would not play" and nothing else -- it cannot
  // hand back a status -- so a stream that is charging looked identical to one
  // that was broken, which is a useless thing to tell somebody about money.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const fn = app.slice(app.indexOf("async function whyItWouldNotPlay"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /status !== 402/);
  // Signed out, the thing to do is sign in; signed in, it is to pay.
  assert.match(body, /Sign in to nixamp\.com to pay/);
  assert.match(body, /charging for a pass/);
});

test("the jingle plays on every page load, not once per tab", () => {
  // It was kept in sessionStorage, so refreshing was silent -- and refreshing
  // is exactly how somebody checks whether the thing they asked for works.
  // A load is a load.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  assert.equal(app.includes("nixamp.jingled"), false, "still remembering across loads");
  assert.match(app, /let jingled = false;/);

  // One per page, though: a refused autoplay arms a listener for the first
  // click, and that must not fire twice on the same page.
  assert.match(app, /if \(jingled\) return;/);
});

test("signing out lets go of the server as well as the account", () => {
  // It cleared the account and nothing else, so you stayed connected to
  // somebody's machine with its address still saved -- which is a reasonable
  // thing to be alarmed by when you have just logged out.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const out = app.slice(app.indexOf('dom.accountSignOut.addEventListener'));
  const body = out.slice(0, out.indexOf("\n  });"));
  assert.match(body, /remote\.close\(\)/);
  assert.match(body, /mode = "local"/);
  assert.match(body, /removeItem\(REMOTE_KEY\)/);
  // And the panels that belong to a server go with it.
  assert.match(body, /adminPanel\.hidden = true/);
  assert.match(body, /sharePanel\.hidden = true/);
});

test("the top of the page says LOADING while something is on its way", () => {
  // A catalog entry can take half a minute to start, and for all of it the
  // page said STOPPED, which reads as broken. Loading outranks both states.
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const player = readFileSync(join(webDir, "src/player.ts"), "utf8");
  const css = readFileSync(join(webDir, "src/styles.css"), "utf8");
  assert.match(app, /wait \? "LOADING" : live \? "▶ PLAYING" : "■ STOPPED"/);
  assert.match(app, /dataset\.playing = wait \? "loading"/);
  // The element says when it is waiting on bytes, and a request in flight
  // counts the same.
  assert.match(player, /onBusy\?: \(busy: boolean\) => void/);
  for (const name of ["loadstart", "waiting", "stalled"]) assert.ok(player.includes(`"${name}"`), name);
  assert.match(app, /async function whileLoading/);
  // Playing a catalog entry, a channel, a file and the live stream all wait
  // through it, and the row that was clicked spins.
  assert.equal((app.match(/whileLoading\(/g) ?? []).length >= 6, true);
  assert.match(app, /classList\.add\("loading"\)/);
  assert.match(css, /\.status\[data-playing="loading"\]::before/);
  assert.match(css, /@keyframes turn/);
});

test("what is playing has a line of its own under the picture", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // Under the title and above the controls: the meta line comes after the
  // album line and before the scrub bar.
  const meta = html.indexOf('id="meta-line"');
  assert.ok(meta > html.indexOf('id="album-line"'));
  assert.ok(meta < html.indexOf('class="scrub"'));
  // Text, never markup: the words are a provider's or a stranger's.
  const drawMeta = app.slice(app.indexOf("function drawMeta"), app.indexOf("function draw(): void"));
  assert.match(drawMeta, /span\.textContent = chip/);
  assert.equal(drawMeta.includes("innerHTML"), false);
  // Who is watching, how big the picture is, where in a catalog it came from.
  assert.match(drawMeta, /watching/);
  assert.match(drawMeta, /videoWidth/);
  assert.match(drawMeta, /nowMeta\.catalog\.name/);
});

test("go live sits beside play, for whoever may, and puts it on the air for everyone", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // Next to Play, hidden until somebody who administers the server has
  // something loaded.
  const play = html.indexOf('id="play-pause"');
  const goLive = html.indexOf('id="go-live-now"');
  assert.ok(goLive > play && goLive < html.indexOf('id="stop"'));
  assert.match(app, /dom\.goLiveNow\.hidden = !canGoLive\(\) \|\| whatToGoLiveWith\(\) === null/);
  // Every row that plays offers it too, to whoever may: the owner, or a member.
  assert.equal((app.match(/goLiveButton\(/g) ?? []).length >= 3, true);
  // A catalog entry becomes a kept channel; a channel is kept; a file becomes
  // a kept channel of its own. Then it is listed, and the link is copied.
  const body = app.slice(app.indexOf("async function goLiveWith"), app.indexOf("function joinLiveLabel"));
  assert.match(body, /\/live`/);
  assert.match(body, /\/keep`/);
  assert.match(body, /`\/api\/tracks\/\$\{what\.index\}\/live`/);
  assert.match(body, /if \(!listed\) await setLive\(true\)/);
  assert.match(body, /copyText\(page, button/);
});

test("on a live stream the page says whose it is, what is on, and how to call in", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // Between the album line and the chips: where the eye goes after the title.
  const line = html.indexOf('id="live-line"');
  assert.ok(line > html.indexOf('id="album-line"') && line < html.indexOf('id="meta-line"'));
  const body = app.slice(app.indexOf("function drawLiveLine"), app.indexOf("function drawMeta"));
  // The server's own live stream and a channel both count; a file does not.
  assert.match(body, /channelOn !== null \|\| nowMeta\?\.kind === "live"/);
  // What is on comes from the server's current answer, so it follows the track.
  assert.match(body, /lastAir\?\.server\.nowPlaying/);
  // The number and the code, in the same words as the Share panel, as text.
  assert.match(body, /To talk about it, call /);
  assert.match(body, /boldly\(code\)/);
  assert.equal(body.includes("innerHTML"), false);
});

test("a pasted link is played by the server you are on, and a whole one can be kept", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  assert.ok(html.includes('id="link-form"') && html.includes('id="link-url"'));
  assert.ok(html.includes('id="download-now"'));
  const body = app.slice(app.indexOf("async function playLink"), app.indexOf("dom.linkForm.addEventListener"));
  // A link plays here first -- a site's player in a frame, or a file in the
  // page's own -- and only Make public asks the server, which is for whoever
  // administers it. Not connected, and not allowed, are said, not silently nothing.
  assert.match(body, /localPlayback\(url, wantsHls\(\)\)/);
  assert.match(body, /dom\.embedFrame\.src = local\.src/);
  assert.match(body, /if \(!isAdmin\(\)\) \{/);
  assert.match(body, /Connect to a server you administer/);
  assert.match(body, /\/api\/links\/play/);
  assert.match(body, /\/keep`\)/);
  assert.ok(html.includes('id="make-public"') && html.includes('id="embed-frame"'));
  // The answer is watched as a channel, remembering where it came from.
  assert.match(body, /watchChannel\(/);
  assert.match(body, /download: body\.download === true/);
  // Keeping it opens the server's download route in the browser, which saves it.
  assert.match(app, /\/api\/links\/download\?url=/);
  assert.match(app, /dom\.downloadNow\.hidden = !\(channelOn && nowMeta\?\.link\?\.download\)/);
  // A shared link can name a link to paste.
  assert.match(app, /asked\.startsWith\("link:"\)/);
  // And the footer points at the subreddit, beside GitHub.
  assert.ok(html.indexOf('href="https://www.reddit.com/r/nixamp"') > html.indexOf('href="https://github.com/profullstack/nixamp"'));
});

test("every live has its own room code, shown wherever the live is", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // The Live rows, the line under the title, and the directory's channel rows.
  assert.match(app, /if \(channel\.code\) detail\.push\(`☎ \$\{channel\.code\}`\)/);
  assert.match(app, /lastAir\?\.channels\.find\(\(one\) => one\.id === channelOn\?\.id\)\?\.code/);
  assert.match(app, /stream\.channelCodes\?\.\[channelName\]/);
});

test("a phone's Safari is handed a live channel as HLS, and a dead channel does not step on", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // Without MediaSource a browser cannot play a live MP4 at all; with native
  // HLS it plays the playlist. Everything else keeps the lower-latency MP4.
  const wants = app.slice(app.indexOf("function wantsHls"), app.indexOf("type GoLiveWith"));
  assert.match(wants, /typeof MediaSource !== "undefined"\) return false/);
  assert.match(wants, /canPlayType\("application\/vnd\.apple\.mpegurl"\)/);
  assert.match(app, /const asHls = channel\.video && wantsHls\(\)/);
  assert.match(app, /\/hls\/index\.m3u8`/);
  // A channel that gave up is not a place in the playlist to step on from.
  const ended = app.slice(app.indexOf("onEnded: () => {"), app.indexOf("onState: () => draw()"));
  assert.match(ended, /if \(mode === "remote" && watching < 0 && !remoteDrives\(\)\) return;/);
});

test("what is playing is asked about, and the answer is drawn only while it still plays", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  // Asked of the server we are on, which asks nichedb once per name.
  assert.match(app, /fetch\(remote\.url\(`\/api\/enrich\?\$\{params\}`\)\)/);
  // Every way something starts playing asks: a file, a channel, a catalog film, the live stream.
  assert.equal((app.match(/\benrich\((track\.title|channel\.name|name|title), /g) ?? []).length >= 4, true);
  // An answer for the last thing is not drawn over the next.
  assert.match(app, /if \(enrichAsked !== key\) return;/);
  assert.match(app, /enrichment\?\.key === enrichAsked \? enrichment\.match : null/);
  // A poster stands beside the chips; a synopsis under them; nothing is markup.
  assert.match(app, /"meta-logo meta-poster"/);
  assert.match(app, /dom\.metaBlurb\.textContent = blurb/);
  assert.ok(html.includes('id="meta-blurb"'));
});

test("a game is a score line: two teams, the score, and where the game has got to", () => {
  const game = (state: string, statusDetail: string) => ({
    published_at: "2026-09-14T00:20:00.000Z",
    tags: ["fixture", "football", "league:nfl", `state:${state}`],
    data: {
      state, statusDetail, broadcast: "NBC",
      league: { name: "NFL", abbreviation: "NFL", slug: "nfl" },
      away: { name: "Bills", displayName: "Buffalo Bills", abbreviation: "BUF", score: 17, logoUrl: "https://logos/buf.png" },
      home: { name: "Chiefs", displayName: "Kansas City Chiefs", abbreviation: "KC", score: 21, logoUrl: "https://logos/kc.png" },
      homeScore: 21, awayScore: 17,
    },
  });
  const clock = { now: new Date("2026-09-13T20:00:00.000Z"), locale: "en-US", timeZone: "America/New_York" };
  // On: the score, and the chip says LIVE with the clock.
  const on = scoreLine(game("in", "Q3 4:12"), clock);
  assert.equal(on.state, "in");
  assert.equal(on.text, "Bills 17 – Chiefs 21");
  assert.equal(on.status, "LIVE · Q3 4:12");
  assert.deepEqual(on.chips, ["NFL", "NBC"]);
  assert.equal(on.away.logo, "https://logos/buf.png");
  assert.equal(on.home.score, 21);
  // Before: no score yet, and when it starts, in the viewer's own clock.
  const before = scoreLine(game("pre", "9/13 - 8:20 PM EDT"), clock);
  assert.equal(before.text, "Bills – Chiefs");
  assert.equal(before.status, "Kicks off 8:20 PM");
  // Another day's game names the day, since "Kicks off 8:20 PM" read as tonight.
  const later = scoreLine(game("pre", ""), { ...clock, now: new Date("2026-09-10T20:00:00.000Z") });
  assert.match(later.status, /^Kicks off Sun,? 8:20 PM$/);
  // Over: FINAL, with the score.
  const over = scoreLine(game("post", "Final"), clock);
  assert.equal(over.status, "FINAL");
  assert.equal(over.text, "Bills 17 – Chiefs 21");
  // The state falls back to the tags, then to "pre"; scores fall back to the flat fields.
  assert.equal(fixtureState({ data: {}, tags: ["state:post"] }), "post");
  assert.equal(fixtureState({ data: {}, tags: [] }), "pre");
  const flat = scoreLine({ data: { state: "in", away: { name: "A" }, home: { name: "B" }, awayScore: 3, homeScore: 1 } });
  assert.equal(flat.text, "A 3 – B 1");
  assert.equal(flat.status, "LIVE");
  assert.deepEqual(flat.chips, []);
  assert.equal(kickoff("not a date"), "");
  assert.equal(kickoff(null), "");
});

test("a channel named for two teams is asked about as a game, and its score is asked again every minute", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const css = readFileSync(join(webDir, "src/styles.css"), "utf8");
  // The browser tells a matchup the same way the server does.
  assert.equal(isMatchupName("NFL: Chiefs vs Bills"), true);
  assert.equal(isMatchupName("CNN"), false);
  assert.match(app, /isMatchupName\(channel\.name\) \? "auto" : "channel"/);
  // A fixture is drawn as a score row instead of film chips: no poster, no blurb.
  const drawMeta = app.slice(app.indexOf("function drawMeta"), app.indexOf("function draw(): void"));
  assert.match(drawMeta, /if \(rich\?\.kind === "fixture"\) \{\s*score = scoreLine\(rich\);/);
  assert.match(drawMeta, /row\.className = "meta-score"/);
  assert.match(drawMeta, /img\.className = "meta-team-logo"/);
  assert.match(drawMeta, /points\.textContent = String\(one\.score\)/);
  assert.match(drawMeta, /!score && known\?\.summary/);
  assert.match(drawMeta, /"meta-chip chip-live"/);
  assert.equal(drawMeta.includes("innerHTML"), false);
  // Asked again every minute while the game is on or about to be, never after
  // it is over, and not once the track changed or stopped.
  const enrich = app.slice(app.indexOf("const FIXTURE_REFRESH_MS"), app.indexOf("let listed = false"));
  assert.match(enrich, /FIXTURE_REFRESH_MS = 60_000/);
  assert.match(enrich, /fixtureState\(match\) !== "post"/);
  assert.match(enrich, /if \(fixtureTimer\) clearTimeout\(fixtureTimer\);/);
  assert.match(enrich, /if \(enrichAsked !== key \|\| \(player\.source === "" && !channelOn\)\) return;/);
  assert.match(enrich, /enrich\(name, kind, year, true\)/);
  // Team logos are small, the score is bold, and the live chip has its dot.
  assert.match(css, /\.meta-team-logo \{[^}]*height: 20px/);
  assert.match(css, /\.meta-points \{[^}]*font-weight: 700/);
  assert.match(css, /\.meta-chip\.chip-live::before \{[^}]*border-radius: 50%/);
  assert.match(css, /\.meta-score \{[^}]*flex-wrap: wrap/);
});

test("a listed server's channels are rows in the directory that play them", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // A name in a list you cannot press is a name. Each channel is a row with
  // Play, which connects as a viewer and asks for that channel by name --
  // the directory knows channels by name only.
  assert.match(app, /className = "server-lives"/);
  assert.match(app, /open\(true, `channel:\$\{channelName\}`\)/);
  assert.match(app, /air\.channels\.find\(\(one\) => one\.name === wanted\)/);
});

test("the jingle plays into silence, never over a stream that was asked for", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const jingle = app.slice(app.indexOf("The noise it makes when it wakes up"));
  // A page opened from a link is opening a stream; the first click may be
  // the click that plays something. Neither gets the jingle over it.
  assert.match(jingle, /if \(invited !== ""\) return;/);
  assert.match(jingle, /const busy = \(\): boolean => player\.source !== ""/);
  assert.match(jingle, /if \(src === "" \|\| busy\(\)\) return;/);
  assert.match(jingle, /if \(busy\(\)\) return;/);
});

test("a television is told from a desk, a phone, and a Fire tablet", () => {
  const fireTv = "Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7285) AppleWebKit/537.36 (KHTML, like Gecko) Silk/126.3.1 like Chrome/126.0.6478.71 Safari/537.36";
  const fireTablet = "Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/126.3.1 like Chrome/126.0.6478.71 Safari/537.36";
  const androidTv = "Mozilla/5.0 (Linux; Android 12; SHIELD Android TV Build/SR3; wv) AppleWebKit/537.36";
  const tizen = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36";
  const desk = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  assert.equal(isTelevision(fireTv), true);
  assert.equal(isTelevision(androidTv), true);
  assert.equal(isTelevision(tizen), true);
  assert.equal(isTelevision(fireTablet), false);
  assert.equal(isTelevision(desk), false);
  assert.equal(isTelevision(phone), false);
  // Asked for from a desk, or refused from a set.
  assert.equal(isTelevision(desk, "?tv=1"), true);
  assert.equal(isTelevision(desk, "?url=x&tv"), true);
  assert.equal(isTelevision(fireTv, "?tv=0"), false);
  // A Silk with no touch screen is a television whatever it calls itself;
  // a Fire tablet has one.
  const silkDesktopMode = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Silk/126.3.1 like Chrome/126.0.6478.71 Safari/537.36";
  assert.equal(isTelevision(silkDesktopMode, "", 0), true);
  assert.equal(isTelevision(fireTablet, "", 5), false);
  assert.equal(isTelevision(desk, "", 0), false);
  // The switch in the footer, remembered, beats the browser's own account
  // of itself; the address beats the switch.
  assert.equal(isTelevision(desk, "", 0, "1"), true);
  assert.equal(isTelevision(fireTv, "", 0, "0"), false);
  assert.equal(isTelevision(fireTv, "?tv=1", 0, "0"), true);
  assert.equal(isTelevision(fireTv, "", 0, ""), true);

  assert.equal(pageSize(true) < pageSize(false), true);
});

test("a page is a window that is pulled back into range", () => {
  assert.deepEqual(pageWindow(0, 0, 25), { page: 0, from: 0, to: 0, pages: 1 });
  assert.deepEqual(pageWindow(80, 0, 25), { page: 0, from: 0, to: 25, pages: 4 });
  assert.deepEqual(pageWindow(80, 3, 25), { page: 3, from: 75, to: 80, pages: 4 });
  // A page number from a bigger folder lands on this one's last page.
  assert.deepEqual(pageWindow(80, 9, 25), { page: 3, from: 75, to: 80, pages: 4 });
  assert.deepEqual(pageWindow(80, -2, 25), { page: 0, from: 0, to: 25, pages: 4 });
  assert.deepEqual(pageWindow(25, 1, 25), { page: 0, from: 0, to: 25, pages: 1 });
});
import { localPlayback } from "../src/links.ts";

test("a pasted link plays here when it can: YouTube, Vimeo and SoundCloud in a frame, a file in the player", () => {
  const yt = localPlayback("https://www.youtube.com/watch?v=i5GTwBTCQJI&t=42");
  assert.equal(yt?.kind, "embed");
  assert.equal(yt?.kind === "embed" && yt.site, "youtube");
  assert.equal(yt?.kind === "embed" && yt.src, "https://www.youtube-nocookie.com/embed/i5GTwBTCQJI?autoplay=1&playsinline=1&rel=0&start=42");
  for (const spelled of ["https://youtu.be/i5GTwBTCQJI", "https://m.youtube.com/watch?v=i5GTwBTCQJI", "https://www.youtube.com/shorts/i5GTwBTCQJI", "https://www.youtube.com/live/i5GTwBTCQJI?feature=share"]) {
    const one = localPlayback(spelled);
    assert.equal(one?.kind === "embed" && one.src.includes("/embed/i5GTwBTCQJI?"), true, spelled);
  }
  // A YouTube address without a video in it is not a video.
  assert.equal(localPlayback("https://www.youtube.com/"), null);
  assert.equal(localPlayback("https://www.youtube.com/watch?v=short"), null);

  const vimeo = localPlayback("https://vimeo.com/76979871");
  assert.equal(vimeo?.kind === "embed" && vimeo.src, "https://player.vimeo.com/video/76979871?autoplay=1&playsinline=1");
  const sc = localPlayback("https://soundcloud.com/forss/flickermood");
  assert.equal(sc?.kind === "embed" && sc.site, "soundcloud");
  assert.ok(sc?.kind === "embed" && sc.src.startsWith("https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood"));
  assert.equal(localPlayback("https://soundcloud.com/forss"), null, "a profile is not a track");

  // A file plays in the page's own player, told apart by its ending.
  assert.deepEqual(localPlayback("https://x.example/ep/01.mp3?token=1"), { kind: "direct", url: "https://x.example/ep/01.mp3?token=1", video: false, label: "01.mp3" });
  const film = localPlayback("https://x.example/film.mp4");
  assert.equal(film?.kind === "direct" && film.video, true);
  // A playlist of segments only where the browser plays those itself.
  assert.equal(localPlayback("https://x.example/live.m3u8"), null);
  assert.equal(localPlayback("https://x.example/live.m3u8", true)?.kind, "direct");

  // Anything else -- a podcast's page, a TikTok live -- is a server's job.
  assert.equal(localPlayback("https://www.tiktok.com/@a/live"), null);
  assert.equal(localPlayback("not a link"), null);
  assert.equal(localPlayback("javascript:alert(1)"), null);
});

test("the directory keeps asking while it is on screen, and redraws only on news", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // A channel put on the air is told to nixamp.com at once; the page that
  // lists it asked exactly once, on opening, so an admin who went live and
  // looked at the directory did not see it there until a reload.
  assert.match(app, /const DIRECTORY_EVERY_MS = 10_000/);
  const load = app.slice(app.indexOf("const loadDirectory = async"), app.indexOf("// /directory is a page"));
  assert.match(load, /setInterval\(\(\) => \{\s*if \(!dom\.directory\.hidden && document\.visibilityState === "visible"\) void loadDirectory\(true\);/);
  // Quietly: no "Looking for…" and no emptied list on a poll that changes nothing.
  assert.match(load, /if \(quiet && seen === directorySeen\) return;/);
  assert.match(load, /if \(!quiet\) \{\s*dom\.directoryNote\.textContent = "Looking for live streams…";/);
  // The clock fields every heartbeat moves are not news.
  assert.match(load, /updatedAt: _u, startedAt: _s/);
  // Coming back to the tab asks now.
  assert.match(app, /visibilitychange[^]*?if \(document\.visibilityState === "visible" && !dom\.directory\.hidden\) void loadDirectory\(true\)/);
});

test("wherever a server is shown, the eye and the gear are the way in", () => {
  const html = readFileSync(join(webDir, "index.html"), "utf8");
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  // One helper, so a person learns the two buttons once.
  assert.match(app, /function wayIn\(server: \{ name: string; view: string; admin: string \| null \}/);
  // The directory, favourites, the machines on your account, and the header.
  assert.match(app, /const \[connect, admin\] = wayIn\(\s*\{ name: stream\.name, view: stream\.url, admin: adminLink \}/);
  assert.match(app, /wayIn\(\{ name: fav\.name \|\| fav\.url, view: fav\.url, admin: adminLinkFor\(fav\.url\) \}\)/);
  assert.match(app, /const \[open, admin\] = wayIn\(\{ name: entry\.name, view: driving, admin: driving \}\)/);
  assert.match(app, /function drawWayInHere\(\)/);
  assert.ok(html.includes('id="way-in-here"'));
  // The gear is greyed, not gone, when the server is not yours.
  assert.match(app, /gear\.disabled = server\.admin === null/);
  // A favourite learns whether it is yours from the machines on your account.
  assert.match(app, /ownedServers = new Map\(list\.map\(\(entry\) => \[originOf\(entry\.url\)/);
  // In the header only the other way is offered: no eye to a viewer, no gear to an admin.
  assert.match(app, /eye\.hidden = !driving;\s*gear\.hidden = driving;/);
});

test("a member may go live, a file goes on the air as its own channel, and every live says Join live", () => {
  const app = readFileSync(join(webDir, "src/app.ts"), "utf8");
  const remote = readFileSync(join(webDir, "src/remote.ts"), "utf8");
  // The session travels to a server on another origin in the query, the way the key does.
  assert.match(remote, /session=\$\{encodeURIComponent\(this\.session\)\}/);
  assert.match(app, /fetch\("\/api\/v1\/auth\/token"\)/);
  // The server says whether we are a member; the owner or any member may go live.
  assert.match(app, /memberHere = member && !allowed;/);
  assert.match(app, /const canGoLive = \(\): boolean => isAdmin\(\) \|\| \(mode === "remote" && memberHere\);/);
  assert.equal((app.match(/if \(canGoLive\(\)\) \{?\s*item\.append\(goLiveButton\(/g) ?? []).length, 2, "both go-live rows ask canGoLive");
  assert.doesNotMatch(app, /if \(isAdmin\(\)\) item\.append\(goLiveButton\(/);
  // A file goes on the air as a channel of its own, never by taking over the server's player.
  assert.match(app, /\? `\/api\/tracks\/\$\{what\.index\}\/live`/);
  assert.doesNotMatch(app, /remote\.send\(\{ type: "play", index: what\.index \}\)/);
  // A member takes off what they put on.
  assert.match(app, /onStop: canDrive \|\| \(memberHere && meId !== "" && channel\.startedBy === meId\)/);
  // One label for the one act: Join live with the stream icon, in the live list and the directory.
  assert.match(app, /function joinLiveLabel\(button: HTMLButtonElement, text = "Join live"\)/);
  assert.match(app, /joinLiveLabel\(play, row\.playLabel \?\? "Join live"\)/);
  assert.match(app, /joinLiveLabel\(play\);\s*play\.title = `Join \$\{channelName\}, live on \$\{stream\.name\}`/);
  assert.doesNotMatch(app, /play\.textContent = "Play"/);
});

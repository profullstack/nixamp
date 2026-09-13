import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EmptyEngine, brandOf, createServer, joinDocument, joinSubject } from "../src/server.ts";
import { humanizeSource } from "../src/naming.ts";
import { Directory } from "../src/directory.ts";

const SHELL = `<!doctype html><html><head>
    <title>nixamp: broadcast live radio, TV and film from your own machine</title>
    <meta name="description" content="Broadcast live radio." />
    <meta property="og:title" content="nixamp: broadcast live radio, TV and film from your own machine" />
    <meta property="og:description" content="Launch your own network." />
  </head><body><div id="app"></div></body></html>`;

test("a path becomes a title a stranger can read", () => {
  assert.equal(humanizeSource("/home/anthony/Music/live-sets_2024"), "Live Sets 2024");
  assert.equal(humanizeSource("/srv/media/Best.Of.2020/"), "Best Of 2020");
  assert.equal(humanizeSource("~/Music/DJ_night+lo-fi"), "DJ Night Lo Fi");
  // A playlist is named by its file, without the ending.
  assert.equal(humanizeSource("/home/x/playlists/morning_show.m3u8"), "Morning Show");
  assert.equal(humanizeSource("/x/jazz.pls"), "Jazz");
  // A date between digits keeps its dashes and dots.
  assert.equal(humanizeSource("/x/recordings/2024-06-12 gig"), "2024-06-12 Gig");
  assert.equal(humanizeSource("/x/v1.2 mixes"), "V1.2 Mixes");
  // A URL says its last segment, decoded.
  assert.equal(humanizeSource("https://cdn.example.com/shows/late%20night/"), "Late Night");
  // Nothing worth saying falls back to the caller.
  assert.equal(humanizeSource("/"), "");
  assert.equal(humanizeSource("~"), "");
  assert.equal(humanizeSource("___"), "");
  assert.equal(humanizeSource("https://cdn.example.com"), "");
  // The directory caps a name at 60, so this does first.
  assert.equal(humanizeSource("/x/" + "word ".repeat(30)).length <= 60, true);
});

test("the brand is the part of the shell title before a dash or a colon", () => {
  assert.equal(brandOf(SHELL, "https://nixamp.com"), "nixamp");
  assert.equal(brandOf("<title>BackToSchool.help — Learn something live</title>", "https://x"), "BackToSchool.help");
  assert.equal(brandOf("<title>plain</title>", "https://www.example.com"), "plain");
  assert.equal(brandOf("<html></html>", "https://www.example.com"), "example.com");
});

test("a join link is titled by what the server knows, never by the address alone", () => {
  const url = (search: string) => new URL(`http://localhost/${search}`);
  // A server names itself, and a channel it has.
  const channels = { list: () => [{ id: "cnn", name: "CNN" }] } as unknown as NonNullable<Parameters<typeof joinSubject>[1]["channels"]>;
  assert.deepEqual(joinSubject(url(""), { serverName: "Live Sets 2024" }), { title: "Live Sets 2024", where: "" });
  assert.deepEqual(joinSubject(url("?play=channel:cnn"), { serverName: "Box", channels }), { title: "CNN", where: "Box" });
  assert.deepEqual(joinSubject(url("?play=channel:CNN"), { serverName: "Box", channels }), { title: "CNN", where: "Box" });
  // A channel that is not on the air is not something to put in a preview.
  assert.equal(joinSubject(url("?play=channel:Buy%20pills"), { serverName: "Box", channels }), null);
  // A link to another server is that server's to name.
  assert.equal(joinSubject(url("?url=https://other.example.com/view/k"), { serverName: "Box" }), null);
  assert.equal(joinSubject(url(""), {}), null);

  // The directory names the listing a link points at, and its channel.
  const directory = new Directory(60_000, () => 1_000_000);
  directory.announce({
    name: "Jazz Vinyl Rips",
    url: "https://a.example.com/view/abc",
    tracks: 12,
    nowPlaying: "",
    channels: ["Late Show"],
  });
  assert.deepEqual(
    joinSubject(url("?url=https%3A%2F%2Fa.example.com%2Fview%2Fabc"), { directory }),
    { title: "Jazz Vinyl Rips", where: "" },
  );
  assert.deepEqual(
    joinSubject(url("?url=https%3A%2F%2Fa.example.com%2Fview%2Fabc&play=channel:Late%20Show"), { directory }),
    { title: "Late Show", where: "Jazz Vinyl Rips" },
  );
  // Same server, another share link: still that listing.
  assert.deepEqual(
    joinSubject(url("?url=https%3A%2F%2Fa.example.com%2Fv%2Fother"), { directory }),
    { title: "Jazz Vinyl Rips", where: "" },
  );
  // A join link names a channel by its id, which the lineup knows, along
  // with its picture and its line: what the card is made of.
  directory.announce({
    name: "server1",
    url: "https://s1.example:4321/view/LISTEN",
    tracks: 5717,
    nowPlaying: "",
    channels: ["Inspiring Founders Podcast"],
    lineup: [{
      id: "url-6f4152c1590e", name: "Inspiring Founders Podcast", kind: "audio",
      art: "https://s1.example:4321/api/channels/url-6f4152c1590e/art?k=LISTEN", about: "Inspiring Founders · Season 2",
    }],
  });
  assert.deepEqual(
    joinSubject(url("?url=https%3A%2F%2Fs1.example%3A4321%2Fview%2FLISTEN&play=channel%3Aurl-6f4152c1590e"), { directory }),
    {
      title: "Inspiring Founders Podcast", where: "server1", kind: "audio",
      image: "https://s1.example:4321/api/channels/url-6f4152c1590e/art?k=LISTEN", about: "Inspiring Founders · Season 2",
    },
  );
  // By name still works, and picks up the same picture.
  assert.equal(
    joinSubject(url("?url=https%3A%2F%2Fs1.example%3A4321%2Fview%2FLISTEN&play=channel:Inspiring%20Founders%20Podcast"), { directory })?.image,
    "https://s1.example:4321/api/channels/url-6f4152c1590e/art?k=LISTEN",
  );
  // A channel nobody announced, or a server nobody listed, gets the plain shell.
  assert.deepEqual(
    joinSubject(url("?url=https%3A%2F%2Fa.example.com%2Fview%2Fabc&play=channel:Nope"), { directory }),
    { title: "Jazz Vinyl Rips", where: "" },
  );
  assert.equal(joinSubject(url("?url=https%3A%2F%2Fnobody.example.com%2Fview%2Fx"), { directory }), null);
  assert.equal(joinSubject(url("?play=channel:Late%20Show"), { directory, serverName: "nixamp.com" }), null);
});

test("the shell for a join link is titled before any script runs", () => {
  const page = joinDocument(SHELL, { title: "Late Show", where: "Jazz Vinyl Rips" }, "https://nixamp.com");
  assert.match(page, /<title>Late Show — nixamp<\/title>/);
  assert.match(page, /<meta property="og:title" content="Late Show" \/>/);
  assert.match(page, /Late Show is live on Jazz Vinyl Rips\. Tune in free on nixamp, no account needed\./);
  // The page takes over the tab later, and needs the shell's own title for that.
  assert.match(page, /<meta name="nixamp-shell-title" content="nixamp: broadcast live radio, TV and film from your own machine" \/>/);
  // No picture, no picture tags: a card with an empty og:image is a broken card.
  assert.doesNotMatch(page, /og:image|twitter:card/);

  // With a picture: og:image for everybody, and the Twitter card that fits
  // it -- a sleeve beside the words, a frame of a picture across the card.
  const sleeve = joinDocument(SHELL, {
    title: "Inspiring Founders Podcast", where: "server1", kind: "audio",
    image: "https://s1.example:4321/api/channels/url-6f4152c1590e/art?k=LISTEN", about: "Inspiring Founders · Season 2",
  }, "https://nixamp.com");
  assert.match(sleeve, /<meta property="og:image" content="https:\/\/s1\.example:4321\/api\/channels\/url-6f4152c1590e\/art\?k=LISTEN" \/>/);
  assert.match(sleeve, /<meta property="og:image:alt" content="Inspiring Founders Podcast" \/>/);
  assert.match(sleeve, /<meta name="twitter:card" content="summary" \/>/);
  assert.match(sleeve, /<meta name="twitter:image" content="https:\/\/s1\.example:4321[^"]*" \/>/);
  // The line about it leads the description, then where it is.
  assert.match(sleeve, /<meta property="og:description" content="Inspiring Founders · Season 2 — Inspiring Founders Podcast is live on server1\. Tune in free on nixamp, no account needed\." \/>/);
  const frame = joinDocument(SHELL, { title: "CNN", where: "box", kind: "video", image: "https://s1.example/api/channels/cnn/art?k=K" }, "https://nixamp.com");
  assert.match(frame, /<meta name="twitter:card" content="summary_large_image" \/>/);
  // The shell's own title is still noted after the card, for the page to take over.
  assert.match(frame, /twitter:image[^\n]*\n\s*<meta name="nixamp-shell-title"/);

  // A name is text, whatever it contains.
  const sharp = joinDocument(SHELL, { title: `<b>"x"</b>`, where: "" }, "https://nixamp.com");
  assert.match(sharp, /<title>&lt;b&gt;&quot;x&quot;&lt;\/b&gt; — nixamp<\/title>/);
  assert.doesNotMatch(sharp, /<b>/);
});

test("a server's own page says what the server is called", async () => {
  const web = mkdtempSync(join(tmpdir(), "nixamp-join-"));
  writeFileSync(join(web, "index.html"), SHELL);
  const server = createServer(new EmptyEngine(), { web, media: false, version: "test", serverName: "Live Sets 2024" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /<title>Live Sets 2024 — nixamp<\/title>/);
    assert.match(page, /<meta property="og:title" content="Live Sets 2024" \/>/);
    // A channel that does not exist leaves the shell as it was.
    const plain = await (await fetch(`http://127.0.0.1:${port}/?play=channel:nope`)).text();
    assert.equal(plain, SHELL);
  } finally {
    server.close();
    rmSync(web, { recursive: true, force: true });
  }
});

test("a server's own join link carries the channel's picture, with the listen key on it", async () => {
  const web = mkdtempSync(join(tmpdir(), "nixamp-join-"));
  writeFileSync(join(web, "index.html"), SHELL);
  const channels = {
    list: () => [{ id: "url-tv", name: "CNN", kind: "video", startedAt: 1, bytes: 0, listeners: 0, format: "mp4", via: "pull", about: "News" }],
  } as unknown as NonNullable<Parameters<typeof joinSubject>[1]["channels"]>;
  const live = {
    status: () => ({ live: true, code: "123456", name: "Box", url: "https://box.example:4321/view/LISTEN", possible: true }),
    start: async () => ({ live: true, code: "123456", name: "Box", url: "" }),
    stop: async () => {},
  };
  const server = createServer(new EmptyEngine(), { web, media: false, version: "test", serverName: "Box", channels, live });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/?play=channel:url-tv`)).text();
    assert.match(page, /<title>CNN — nixamp<\/title>/);
    assert.match(page, /<meta property="og:image" content="https:\/\/box\.example:4321\/api\/channels\/url-tv\/art\?k=LISTEN" \/>/);
    assert.match(page, /<meta name="twitter:card" content="summary_large_image" \/>/);
    assert.match(page, /News — CNN is live on Box/);
  } finally {
    server.close();
    rmSync(web, { recursive: true, force: true });
  }
});

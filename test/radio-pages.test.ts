import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channels } from "../src/channels.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore, type Station } from "../src/stations.ts";
import { PeerGuides } from "../src/station-guide.ts";
import { albumSlug, artistSlug, slugify, stationSlug } from "../src/radio-slug.ts";
import { buildCatalogue, radioPeers, radioRewriter, radioStations, renderAlbum, renderArtist } from "../src/radio-pages.ts";
import { followTarget } from "../src/follow-page.ts";

const memory = () => ({ read: () => null, write: () => undefined });

function get(port: number, path: string, host = "live.streaming"): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("station names read as paths", () => {
  assert.equal(stationSlug("Profullstack AI · Metal"), "ai-metal");
  assert.equal(stationSlug("Profullstack AI · Hip-Hop"), "ai-hip-hop");
  assert.equal(stationSlug("Roaring Twenties: Jazz, Blues & Dance"), "roaring-twenties");
  assert.equal(stationSlug("Shared: Classical"), "shared-classical");
  assert.equal(stationSlug("Public Domain Classical"), "public-domain-classical");
  assert.equal(stationSlug("Þrøngva Radio"), "throngva-radio");
  assert.equal(stationSlug("AI Lo-Fi Beats"), "ai-lo-fi-beats");
  assert.equal(slugify("Beyoncé & Jay-Z"), "beyonce-and-jay-z");
  assert.equal(artistSlug("Ludwig van Beethoven; Berlin Phil"), "ludwig-van-beethoven");
  assert.equal(albumSlug("Iron Veil", "Ashes of Tomorrow"), "iron-veil-ashes-of-tomorrow");
  assert.ok(slugify("a ".repeat(100), 20).length <= 20);
});

function station(over: Partial<Station>): Station {
  return {
    id: "aaaaaaaaaa", name: "X", description: "", items: [], shuffle: false, repeat: true, visibility: "public", listed: true, desired: "running",
    listenToken: "tok", bitrate: 128, video: false, breaksEvery: 0, auto: "", rights: null, owner: "", failures: {}, idempotencyKey: "", createdAt: 1, updatedAt: 1,
    ...over,
  } as Station;
}

test("only public, listed stations get a name, and the older one keeps it", () => {
  const map = radioStations([
    station({ id: "bbbbbbbbbb", name: "Jazz", createdAt: 2 }),
    station({ id: "aaaaaaaaaa", name: "Jazz", createdAt: 1 }),
    station({ id: "cccccccccc", name: "Secret", visibility: "private", listed: false }),
    station({ id: "dddddddddd", name: "Unlisted", visibility: "unlisted", listed: false }),
    station({ id: "eeeeeeeeee", name: "Artist" }),
  ]);
  assert.deepEqual([...map].map(([slug, one]) => `${slug}=${one.id}`).sort(), ["artist-radio=eeeeeeeeee", "jazz-2=bbbbbbbbbb", "jazz=aaaaaaaaaa"]);
});

test("the rewriter takes the station's address and token out", () => {
  const rewrite = radioRewriter({ id: "abcdefghij", listenToken: "s3cr-t_tok" }, "ai-metal");
  const out = rewrite(JSON.stringify({ art: "/api/v1/stations/abcdefghij/art?t=s3cr-t_tok&f=12", lyrics: "/api/v1/stations/abcdefghij/lyrics?t=s3cr-t_tok", x: "s3cr-t_tok" }));
  assert.doesNotMatch(out, /s3cr-t_tok|api\/v1\/stations/);
  assert.match(out, /"\/radio\/ai-metal\/art\?f=12"/);
  assert.match(out, /"\/radio\/ai-metal\/lyrics"/);
});

test("peers' stations get names after ours, and only their own links", () => {
  const peers = radioPeers(["dsa"], [
    { id: "aaaaaaaaaa", name: "DSA", kind: "video", state: "live", page: "https://server2.example:4321/station/aaaaaaaaaa?t=tok", nowPlaying: null },
    { name: "Broken", kind: "audio", state: "live", page: "https://server2.example:4321/watch?play=x", nowPlaying: null },
  ]);
  assert.deepEqual([...peers.keys()], ["dsa-2"]);
  assert.equal(peers.get("dsa-2")!.token, "tok");
});

test("the catalogue: label artists sell, commercial ones only show", () => {
  const label = { holder: "Profullstack, Inc.", genres: [{ genre: "Metal", station: "s", artists: [{ key: "k1", name: "Iron Veil", genre: "Metal", bio: "Loud.", albums: [{ key: "a1", title: "Ashes", year: 2026, concept: "", cover: true, complete: true, songs: [{ n: 1, title: "Burn", seconds: 200, lyrics: "[Verse]\nfire" }] }] }] }] };
  const stations = new Map([["ai-metal", station({ items: ["/m/1.mp3", "/c/2.mp3", "/c/3.mp3"] })]]);
  const catalogue = buildCatalogue({
    stations, label,
    songAt: (file) => file === "/m/1.mp3" ? { artistName: "Iron Veil", albumTitle: "Ashes" } : null,
    tags: (file) => file === "/c/2.mp3" ? { title: "Song", artist: "Band", album: "Record", year: 1999, track: 2, duration: 180, hasArt: true }
      : file === "/c/3.mp3" ? { title: "Other", artist: "Band", album: "", year: 0, track: 0, duration: 60, hasArt: false } : null,
  });
  const veil = catalogue.artists.get("iron-veil")!;
  assert.deepEqual(veil.stations, ["ai-metal"]);
  const band = catalogue.artists.get("band")!;
  assert.equal(band.singles.length, 1);
  const record = catalogue.albums.get("band-record")!;
  assert.equal(record.coverFile, "/c/2.mp3");
  const shop = { site: "https://nixamp.com", buy: (kind: string, artist: string) => `https://nixamp.com/buy?kind=${kind}&artist=${artist}`, prices: { song: 10, album: 100, artist: 200 } };
  const names = new Map([["ai-metal", "Profullstack AI · Metal"]]);
  const ctx = { base: "https://live.streaming.pit.world", nav: "", shop, site: "https://nixamp.com", stationNames: names };
  const veilPage = renderArtist(catalogue, veil, ctx);
  assert.match(veilPage, /Everything by them · \$2/);
  assert.match(veilPage, /nixamp\.com\/follow\?id=artist%3Airon-veil/);
  assert.match(veilPage, /href="\/radio\/ai-metal"/);
  assert.match(veilPage, /og:url" content="https:\/\/live\.streaming\.pit\.world\/radio\/artist\/iron-veil"/);
  const bandPage = renderArtist(catalogue, band, ctx);
  assert.doesNotMatch(bandPage, /\/buy\?/, "only the label's music is for sale");
  assert.match(bandPage, /Follow/);
  const ashes = renderAlbum(catalogue, catalogue.albums.get("iron-veil-ashes")!, ctx);
  assert.match(ashes, /\/api\/v1\/label\/k1\/a1\/cover\.jpg/);
  assert.match(ashes, /Download the album · \$1/);
  assert.match(ashes, /MP3 · 10¢/);
  assert.match(renderAlbum(catalogue, record, ctx), /\/radio\/album\/band-record\/cover\.jpg/);
});

test("a follow link names an artist and an https page to go back to, nothing else", () => {
  assert.deepEqual(followTarget(new URLSearchParams({ id: "artist:iron-veil", name: "Iron Veil", back: "https://live.streaming.pit.world/radio/artist/iron-veil" })),
    { id: "artist:iron-veil", name: "Iron Veil", back: "https://live.streaming.pit.world/radio/artist/iron-veil" });
  assert.equal(followTarget(new URLSearchParams({ id: "streamer-uuid" })), null);
  assert.equal(followTarget(new URLSearchParams({ id: "artist:x", back: "javascript:alert(1)" }))!.back, "");
});

test("/radio serves public stations by name, and their routes without the token", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-radio-"));
  process.env["NIXAMP_GUIDE_HOSTS"] = "live.streaming";
  process.env["NIXAMP_WATCH_BASE"] = "https://live.streaming.pit.world";
  const store = new StationStore(join(top, "s.json"), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [top] });
  const shown = store.create({ name: "Profullstack AI · Metal" }, ["/x.mp3"], "");
  store.setAccess(shown.id, { visibility: "public", listed: true, rights: { basis: "owned" } }, "acct");
  const hidden = store.create({ name: "Punk Radio" }, ["/z.mp3"], "");
  const token = store.get(shown.id)!.listenToken;
  const fetcher = (async () => Response.json({ stations: [
    { id: "aaaaaaaaaa", name: "DSA TV", kind: "video", group: "tv", state: "live", page: "https://server2.example:4321/station/aaaaaaaaaa?t=peertok", nowPlaying: null },
  ] })) as unknown as typeof fetch;
  const peers = new PeerGuides(() => ["https://server2.example:4321"], fetcher);
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, peers, publicBase: () => "https://server1.example:4321" } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  try {
    const list = await get(port, "/radio");
    assert.equal(list.status, 200, "no key needed");
    assert.match(list.body, /href="\/radio\/ai-metal"/);
    assert.match(list.body, /href="\/radio\/dsa-tv"/, "a peer's station too");
    assert.doesNotMatch(list.body, /Punk Radio|server1|server2|peertok/);
    assert.doesNotMatch(list.body, new RegExp(token));

    const page = await get(port, "/radio/ai-metal");
    assert.equal(page.status, 200);
    assert.match(page.body, /<meta property="og:url" content="https:\/\/live\.streaming\.pit\.world\/radio\/ai-metal"/);
    assert.match(page.body, /<title>Profullstack AI · Metal · live.streaming<\/title>/);
    assert.match(page.body, /class="radio-nav"/);
    assert.doesNotMatch(page.body, /server1|noindex/);
    assert.doesNotMatch(page.body, new RegExp(token));

    const state = await get(port, "/radio/ai-metal/state");
    assert.equal(state.status, 200);
    assert.equal((JSON.parse(state.body) as { name: string }).name, "Profullstack AI · Metal");
    assert.doesNotMatch(state.body, new RegExp(token));

    const m3u = await get(port, "/radio/ai-metal/listen.m3u");
    assert.match(m3u.body, /^https:\/\/live\.streaming\.pit\.world\/radio\/ai-metal\/stream$/m);
    assert.doesNotMatch(m3u.body, new RegExp(token));

    assert.equal((await get(port, `/radio/${hidden.id}`)).status, 404, "a private station has no name here");
    assert.equal((await get(port, "/radio/punk-radio")).status, 404);
    assert.equal((await get(port, "/radio/punk-radio/state")).status, 404);
    const byId = await get(port, `/radio/${shown.id}`);
    assert.equal(byId.status, 301);
    assert.equal(byId.headers.location, "/radio/ai-metal");

    // The guide's own list names stations by /radio, with no server or token.
    const guide = await get(port, "/api/v1/stations/guide?radio=1");
    assert.doesNotMatch(guide.body, /server1|server2|peertok|\?t=/);
    assert.doesNotMatch(guide.body, new RegExp(token));
    assert.match(guide.body, /https:\/\/live\.streaming\.pit\.world\/radio\/ai-metal/);
    assert.match(guide.body, /https:\/\/live\.streaming\.pit\.world\/radio\/dsa-tv/);
    // And so does the guide page itself, behind its name.
    const front = await get(port, "/");
    assert.match(front.body, /href="\/radio">Radio/);
    assert.match(front.body, /href="https:\/\/live\.streaming\.pit\.world\/radio\/ai-metal"/);
    assert.doesNotMatch(front.body, /server1|server2|peertok/);
    // The short link goes to the name too.
    assert.equal((await get(port, `/watch/${shown.id}`)).headers.location, "https://live.streaming.pit.world/radio/ai-metal");
    assert.equal((await get(port, "/radio/artist/nobody")).status, 404);
  } finally {
    delete process.env["NIXAMP_GUIDE_HOSTS"];
    delete process.env["NIXAMP_WATCH_BASE"];
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

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
import { StationStore } from "../src/stations.ts";
import { GUIDE_CSP, PeerGuides, cleanGuideAds, guideAds, guideCsp, nowLine, peerBase, renderGuide } from "../src/station-guide.ts";

const memory = () => ({ read: () => null, write: () => undefined });

function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("the guide lists only what its owner made public and listed", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-guide-"));
  process.env["NIXAMP_GUIDE_HOSTS"] = "live.streaming";
  const store = new StationStore(join(top, "s.json"), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [top] });
  const shown = store.create({ name: "Public FM <script>alert(1)</script>" }, ["/x.mp3"], "");
  store.setAccess(shown.id, { visibility: "public", listed: true, rights: { basis: "owned" } }, "acct");
  const unlisted = store.create({ name: "Unlisted FM" }, ["/y.mp3"], "");
  store.setAccess(unlisted.id, { visibility: "unlisted" }, "acct");
  store.create({ name: "Private FM" }, ["/z.mp3"], "");
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, publicBase: () => "https://server1.example:4321" } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  try {
    const listed = await get(port, "/api/v1/stations/guide", "server1.example");
    assert.equal(listed.status, 200, "no key needed");
    const names = (JSON.parse(listed.body) as { stations: Array<{ name: string; page: string }> }).stations.map((one) => one.name);
    assert.deepEqual(names, ["Public FM <script>alert(1)</script>"]);
    const pages = (JSON.parse(listed.body) as { stations: Array<{ page: string }> }).stations.map((one) => one.page);
    assert.match(pages[0]!, /^https:\/\/server1\.example:4321\/station\/[a-z0-9]{10}\?t=/, "linked at the server's public address");
    assert.equal((await get(port, "/guide", "server1.example")).status, 200);
    const front = await get(port, "/", "live.streaming");
    assert.match(front.body, /Radio and TV, on the air now/);
    // Rendered in, so it reads through a gateway that cannot run the script; escaped.
    assert.match(front.body, /Public FM &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(front.body, /<script>alert/);
    // Its shareable /radio name, not the raw link with its token (radio-pages.ts).
    assert.match(front.body, /href="https:\/\/server1\.example:4321\/radio\/public-fm-script-alert-1-script"/);
    assert.doesNotMatch(front.body, /Unlisted FM|Private FM/);
    // Anywhere else, the front page is the server's own and still needs its key.
    assert.equal((await get(port, "/", "server1.example")).status, 401);
  } finally {
    delete process.env["NIXAMP_GUIDE_HOSTS"];
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

test("the guide lists its peers' public stations, and a peer asking gets only this one's", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-guide-peer-"));
  const store = new StationStore(join(top, "s.json"), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => [top] });
  const own = store.create({ name: "Server1 FM" }, ["/x.mp3"], "");
  store.setAccess(own.id, { visibility: "public", listed: true, rights: { basis: "owned" } }, "acct");
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json({ stations: [
      { id: "aaaaaaaaaa", name: "Server2 FM", kind: "video", group: "tv", state: "live", page: "https://server2.example:4321/station/aaaaaaaaaa?t=tok", nowPlaying: { title: "A film", artist: "" } },
      // Somebody else's address in a peer's list is not the peer's to give.
      { id: "bbbbbbbbbb", name: "Elsewhere", kind: "audio", state: "live", page: "https://evil.example/station/bbbbbbbbbb?t=x", nowPlaying: null },
    ] });
  }) as typeof fetch;
  const peers = new PeerGuides(() => ["https://server2.example:4321"], fetcher);
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, peers, publicBase: () => "https://server1.example:4321" } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  try {
    const all = JSON.parse((await get(port, "/api/v1/stations/guide", "server1.example")).body) as { stations: Array<{ name: string; peer?: boolean }> };
    assert.deepEqual(all.stations.map((one) => one.name), ["Server1 FM", "Server2 FM"]);
    assert.equal(all.stations[1]!.peer, true);
    assert.deepEqual(asked, ["https://server2.example:4321/api/v1/stations/guide?local=1"]);
    const local = JSON.parse((await get(port, "/api/v1/stations/guide?local=1", "server1.example")).body) as { stations: Array<{ name: string }> };
    assert.deepEqual(local.stations.map((one) => one.name), ["Server1 FM"], "no ring between two peers");
    const page = (await get(port, "/guide", "server1.example")).body;
    assert.match(page, /Server2 FM/);
    // By its /radio name here, asked of the peer by this server (radio-pages.ts).
    assert.match(page, /href="https:\/\/server1\.example:4321\/radio\/server2-fm"/);
    assert.doesNotMatch(page, /Elsewhere/);
    assert.equal(asked.length, 1, "asked once in 15 s");
  } finally {
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

test("a peer that is down drops out of the guide instead of holding it up", async () => {
  const peers = new PeerGuides(() => ["https://down.example"], (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  assert.deepEqual(await peers.entries(), []);
  assert.equal(peerBase("http://plain.example:4321"), "", "https only");
  assert.equal(peerBase("https://server2.example:4321/admin/key"), "https://server2.example:4321");
});

test("a card's now-playing line drops pasted links and reads ';' artists as a list", () => {
  assert.equal(nowLine({ title: "His Girl Friday - http://www.archive.org/details/his_girl_friday", artist: "Howard Hawks" }), "His Girl Friday — Howard Hawks");
  assert.equal(nowLine({ title: "A LA PAREE", artist: "REGA DANCE ORCHESTRA;Henri Verdin" }), "A LA PAREE — REGA DANCE ORCHESTRA, Henri Verdin");
  assert.equal(nowLine(null), "");
  const page = renderGuide([{ name: "TV", kind: "video", state: "live", page: "https://x.example/station/abcdefghij", nowPlaying: { title: "Film https://a.example/b", artist: "" } }]);
  assert.match(page, /<div class="now">Film<\/div>/);
  // The page's own script tidies the same way when it refreshes.
  assert.ok(page.includes("const nowLine = "));
});

test("a gateway's own stylesheet may style its notice on the guide", () => {
  assert.match(GUIDE_CSP, /style-src 'self' 'sha256-/);
});

test("crawlproof on the guide: tracker + ad only when configured, and the policy lets exactly those in", () => {

  const bare = renderGuide([]);
  assert.doesNotMatch(bare, /crawlproof/, "off by default");
  assert.doesNotMatch(guideCsp(), /crawlproof|frame-src/);
  const ads = { site: "b5f8f7af-32b5-460b-ae7b-9732414fee8a", slot: "ade2345b-7a5e-40e3-ac02-004fb8c880b2" };
  const page = renderGuide([], "", ads);
  assert.match(page, /<script data-site="b5f8f7af-32b5-460b-ae7b-9732414fee8a" src="https:\/\/crawlproof\.com\/stats\.js" async><\/script>\n<\/head>/);
  assert.match(page, /<iframe src="https:\/\/crawlproof\.com\/api\/ads\/frame\?slot=ade2345b-7a5e-40e3-ac02-004fb8c880b2&amp;format=text_link"[^>]*sandbox=/);
  const csp = guideCsp(ads);
  assert.match(csp, /script-src 'sha256-[^']+' https:\/\/crawlproof\.com;/);
  assert.match(csp, /frame-src https:\/\/crawlproof\.com/);
  assert.match(csp, /connect-src 'self' https:/);
  assert.match(renderGuide([], "", { slot: ads.slot, format: "text_link" }), /format=text_link/);
  assert.deepEqual(cleanGuideAds({ site: "\"><script>", slot: "x y", format: "huge" }), {}, "only ids");
  assert.deepEqual(guideAds({ NIXAMP_GUIDE_CRAWLPROOF_SITE: "abc", NIXAMP_GUIDE_AD_SLOT: "def" }), { site: "abc", slot: "def" });
});

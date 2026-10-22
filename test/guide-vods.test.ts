import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, handleVods, VodProbe, vodAddress, vodEntries, VodStore, VODS_PER_MEMBER } from "../src/guide-vods.ts";
import { renderGuide } from "../src/station-guide.ts";

const KEY = "JV5m_XbnQFD0K9_JEnGEXw";
const PLAY = `https://server1.chovy.nixamp.com:4321/api/v1/library/items/0123456789abcdef/play?k=${KEY}`;
const ITEM = { id: "0123456789abcdef", rel: "Films/Nosferatu (1922).mp4", state: "ready", title: "Nosferatu", artist: "F. W. Murnau", duration: 5640, video: true };

test("a VOD address is one library item's play route, with a key and nothing else", () => {
  assert.deepEqual(vodAddress(PLAY), { origin: "https://server1.chovy.nixamp.com:4321", item: "0123456789abcdef", key: KEY, play: PLAY });
  // The raw stream route is accepted and kept as the play route, which a browser can always play.
  assert.equal(vodAddress(PLAY.replace("/play?", "/stream?"))?.play, PLAY);
  for (const bad of [
    PLAY.replace("https:", "http:"),
    PLAY.replace(`?k=${KEY}`, ""),
    `${PLAY}&session=s`,
    "https://a.example/api/channels/x?k=abcdefghij", // a room, not a file
    "https://a.example/api/v1/library/items/xyz/play?k=abcdefghij",
    "not a link",
  ]) assert.equal(vodAddress(bad), null, bad);
});

test("clock reads like a player", () => {
  assert.equal(clock(5640), "1:34:00");
  assert.equal(clock(245), "4:05");
});

function fakeServer(item: unknown) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/library/items/0123456789abcdef" && url.searchParams.get("k") === KEY) {
      return new Response(JSON.stringify({ item }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

test("the probe reads the file's name, kind and length from its own server, and refuses private networks", async () => {
  assert.deepEqual(await new VodProbe(fakeServer(ITEM)).state(PLAY), { name: "Nosferatu", kind: "video", duration: 5640, artist: "F. W. Murnau" });
  // No title: the file's name without its extension.
  assert.equal((await new VodProbe(fakeServer({ ...ITEM, title: "" })).state(PLAY))?.name, "Nosferatu (1922)");
  assert.equal(await new VodProbe(fakeServer({ ...ITEM, state: "failed" })).state(PLAY), null);
  assert.equal(await new VodProbe(fakeServer(ITEM), async () => "a private address").state(PLAY), null);
});

async function serve(ctx: Omit<Parameters<typeof handleVods>[3], "json" | "readBody">) {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleVods(request, response, new URL(request.url ?? "/", "http://x").pathname, {
      ...ctx,
      json: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
      readBody: async (req) => { let text = ""; for await (const chunk of req) text += chunk; return text; },
    }).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test("a member publishes a file with a basis, gets a short link, and the guide lists it on demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vods-"));
  const store = new VodStore(join(dir, "vods.json"));
  const probe = new VodProbe(fakeServer(ITEM));
  const { base, close } = await serve({ store, probe, base: "https://live.streaming.pit.world", canControl: false, member: async () => "acct-1" });
  try {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/v1/guide/vods`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ play: PLAY, agree: true })).status, 400, "a basis is required");
    assert.equal((await post({ play: "https://a.example/nope", basis: "owned", agree: true })).status, 400);
    const made = await post({ play: PLAY, basis: "public-domain", agree: true, note: "1922, public domain in the US" });
    assert.equal(made.status, 200);
    const body = (await made.json()) as { page: string; vod: { id: string; name: string; duration: number; play: string } };
    assert.match(body.page, /^https:\/\/live\.streaming\.pit\.world\/vod\/[A-Za-z0-9_-]{8}$/);
    assert.equal(body.vod.name, "Nosferatu");
    assert.equal(body.vod.duration, 5640);

    // Publishing it again keeps the same link.
    const again = (await (await post({ play: PLAY, basis: "public-domain", agree: true, title: "Nosferatu (1922)" })).json()) as { page: string; vod: { name: string } };
    assert.equal(again.page, body.page);
    assert.equal(again.vod.name, "Nosferatu (1922)");

    const one = (await (await fetch(`${base}/api/v1/guide/vods/${body.vod.id}`)).json()) as { vod: Record<string, unknown> };
    assert.equal(one.vod["available"], true);
    assert.equal(one.vod["play"], PLAY);
    assert.equal("by" in one.vod, false, "who published it stays private");
    assert.equal((await fetch(`${base}/api/v1/guide/vods/nope`)).status, 404);

    const cards = await vodEntries(store, probe, "https://live.streaming.pit.world");
    assert.equal(cards[0]!.group, "vod");
    assert.equal(cards[0]!.state, "vod");
    const page = renderGuide(cards);
    assert.match(page, /<h2 id="vod-title">On demand<\/h2>/);
    assert.match(page, /▶ ON DEMAND/);
    assert.match(page, /1:34:00/);

    assert.equal((await fetch(`${base}/api/v1/guide/vods/${body.vod.id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.list().length, 0);
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nobody signed in publishes nothing; the owner may name an item of its own; a member has a cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vods-"));
  const store = new VodStore(join(dir, "vods.json"));
  const probe = new VodProbe(fakeServer(ITEM));
  const anon = await serve({ store, probe, base: "https://x", canControl: false, member: async () => "" });
  const owner = await serve({ store, probe, base: "https://x", canControl: true, member: async () => "", ownPlay: (item) => (item === ITEM.id ? PLAY : "") });
  try {
    const post = (to: string, body: unknown) => fetch(`${to}/api/v1/guide/vods`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(anon.base, { play: PLAY, basis: "owned", agree: true })).status, 401);
    const mine = await post(owner.base, { item: ITEM.id, basis: "owned", agree: true });
    assert.equal(mine.status, 200);
    assert.equal(store.list()[0]!.play, PLAY);
    assert.equal(store.list()[0]!.by, "");
  } finally {
    anon.close();
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // The cap counts other files of the same member.
  const capped = new VodStore(join(mkdtempSync(join(tmpdir(), "vods-")), "v.json"));
  for (let n = 0; n < VODS_PER_MEMBER; n++) {
    capped.put({ play: PLAY.replace("0123456789abcdef", n.toString(16).padStart(16, "0")), name: String(n), kind: "video", duration: 0, basis: "owned", note: "", by: "acct-1" });
  }
  const member = await serve({ store: capped, probe, base: "https://x", canControl: false, member: async () => "acct-1" });
  try {
    const answer = await fetch(`${member.base}/api/v1/guide/vods`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ play: PLAY, basis: "owned", agree: true }) });
    assert.equal(answer.status, 409);
  } finally {
    member.close();
  }
});

test("the owner prices its own sellable file; a bought grant redirects to the file as a download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vods-"));
  const store = new VodStore(join(dir, "vods.json"));
  const probe = new VodProbe(fakeServer(ITEM));
  const good = { kind: "vod", artist: "", server: "https://live.streaming.pit.world" };
  const grants = { check: async (g: string) => (g === "good" ? good : g === "other" ? { ...good, artist: "zzzzzzzz" } : null) };
  let control = true;
  let member = "";
  const { base, close } = await serve({ store, probe, base: "https://live.streaming.pit.world", get canControl() { return control; }, member: async () => member, grants });
  try {
    const post = (body: unknown) => fetch(`${base}/api/v1/guide/vods`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ play: PLAY, basis: "licensed", agree: true, price: 2 })).status, 400, "licensed is shareable, not sellable");
    assert.equal((await post({ play: PLAY, basis: "public-domain", agree: true, price: 500 })).status, 400, "a typo of a price");
    const made = await post({ play: PLAY, basis: "public-domain", agree: true, note: "PD", price: 1.5 });
    assert.equal(made.status, 200);
    const vod = ((await made.json()) as { vod: { id: string; priceCents: number } }).vod;
    assert.equal(vod.priceCents, 150);
    // Published again with nothing new keeps its price, title and note.
    const again = ((await (await post({ play: PLAY, basis: "public-domain", agree: true })).json()) as { vod: { id: string; priceCents: number; note: string } }).vod;
    assert.deepEqual([again.id, again.priceCents, again.note], [vod.id, 150, "PD"]);
    good.artist = vod.id;
    const download = (g: string) => fetch(`${base}/api/v1/guide/vods/${vod.id}/download?grant=${g}`, { redirect: "manual" });
    const ok = await download("good");
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), `${PLAY}&download=1&name=Nosferatu`);
    assert.equal((await download("other")).status, 403, "a grant for another video");
    assert.equal((await download("bad")).status, 403);
    // A member may not put a price on anything.
    control = false;
    member = "acct-1";
    assert.equal((await post({ play: PLAY.replace("0123456789abcdef", "0123456789abcdef"), basis: "owned", agree: true, price: 1 })).status, 409, "the owner's file is not the member's to touch");
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

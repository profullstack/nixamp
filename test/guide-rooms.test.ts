import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRooms, RoomProbe, roomAddress, roomEntries, RoomStore, ROOMS_PER_MEMBER, watchPage } from "../src/guide-rooms.ts";
import { renderGuide } from "../src/station-guide.ts";

const PLAY = "https://server1.chovy.nixamp.com:4321/api/channels/folder-b19b85542264?k=JV5m_XbnQFD0K9_JEnGEXw";

test("a room address is a channel or the live stream, with a key and nothing else", () => {
  assert.deepEqual(roomAddress(PLAY), {
    origin: "https://server1.chovy.nixamp.com:4321", channel: "folder-b19b85542264", key: "JV5m_XbnQFD0K9_JEnGEXw", play: PLAY,
  });
  assert.equal(roomAddress("https://a.example/api/live?k=abcdefghij")?.channel, null);
  for (const bad of [
    "http://a.example/api/channels/x?k=abcdefghij", // not https
    "https://a.example/api/channels/x", // no key
    "https://a.example/api/channels/x?k=abcdefghij&session=s", // anything else in the query
    "https://a.example/admin/abcdefghij", // a control link, not a stream
    "https://u:p@a.example/api/live?k=abcdefghij",
    "not a link",
  ]) assert.equal(roomAddress(bad), null, bad);
});

test("the room page carries the stream address", () => {
  assert.equal(watchPage("https://live.streaming.pit.world", PLAY), `https://live.streaming.pit.world/watch?play=${encodeURIComponent(PLAY)}`);
});

/** A nixamp server's channel list, as the probe asks for it. */
function fakeServer(channels: unknown[]) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/channels" && url.searchParams.get("k") === "JV5m_XbnQFD0K9_JEnGEXw") {
      return new Response(JSON.stringify({ channels }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 401 });
  }) as typeof fetch;
}

const CHANNEL = { id: "folder-b19b85542264", name: "Dropkick Murphys - Studio Discography/", kind: "audio", live: true, codecs: { tags: { title: "John Law", artist: "Dropkick Murphys" } } };

test("the probe reads a room's name, kind and what is on from its own server, and refuses private networks", async () => {
  const probe = new RoomProbe(fakeServer([CHANNEL]));
  assert.deepEqual(await probe.state(PLAY), { live: true, name: "Dropkick Murphys - Studio Discography", kind: "audio", nowPlaying: { title: "John Law", artist: "Dropkick Murphys" } });
  assert.equal(await new RoomProbe(fakeServer([])).state(PLAY), null);
  assert.equal(await new RoomProbe(fakeServer([CHANNEL]), async () => "a private address").state(PLAY), null);
});

async function serve(ctx: Omit<Parameters<typeof handleRooms>[3], "json" | "readBody">) {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRooms(request, response, new URL(request.url ?? "/", "http://x").pathname, {
      ...ctx,
      json: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
      // Raw text, as server.ts's readBody gives it: parsing is handleRooms's job.
      readBody: async (req) => { let text = ""; for await (const chunk of req) text += chunk; return text; },
    }).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test("a member publishes a room with a rights basis, it is listed, and only they take it off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rooms-"));
  try {
    const store = new RoomStore(RoomStore.fileFor(dir, 4321));
    const probe = new RoomProbe(fakeServer([CHANNEL]));
    let member = "acct-1";
    const site = await serve({ store, probe, base: "https://live.streaming.pit.world", canControl: false, member: async () => member });
    try {
      const post = (body: unknown) => fetch(`${site.base}/api/v1/guide/rooms`, { method: "POST", body: JSON.stringify(body) });
      assert.equal((await post({ play: PLAY, basis: "owned" })).status, 400, "agreeing is required");
      assert.equal((await post({ play: PLAY, basis: "because", agree: true })).status, 400, "a known basis is required");
      assert.equal((await post({ play: PLAY.replace("folder-b19b85542264", "gone"), basis: "owned", agree: true })).status, 404);
      const made = await post({ play: PLAY, basis: "owned", agree: true });
      assert.equal(made.status, 200);
      const { page, room } = await made.json() as { page: string; room: { id: string; name: string } };
      assert.equal(page, watchPage("https://live.streaming.pit.world", PLAY));
      assert.equal(room.name, "Dropkick Murphys - Studio Discography");
      // Survives a restart.
      assert.equal(new RoomStore(RoomStore.fileFor(dir, 4321)).list().length, 1);

      const listed = await (await fetch(`${site.base}/api/v1/guide/rooms`)).json() as { rooms: Array<{ group: string; state: string; page: string }> };
      assert.deepEqual(listed.rooms.map((one) => [one.group, one.state, one.page]), [["rooms", "live", page]]);
      assert.match(renderGuide(await roomEntries(store, probe, "https://live.streaming.pit.world")), /<h2 id="rooms-title">Live rooms<\/h2>/);

      member = "acct-2";
      assert.equal((await post({ play: PLAY, basis: "owned", agree: true })).status, 409, "somebody else's room");
      assert.equal((await fetch(`${site.base}/api/v1/guide/rooms/${room.id}`, { method: "DELETE" })).status, 404);
      member = "";
      assert.equal((await post({ play: PLAY, basis: "owned", agree: true })).status, 401, "signed out");
      member = "acct-1";
      assert.equal((await fetch(`${site.base}/api/v1/guide/rooms/${room.id}`, { method: "DELETE" })).status, 200);
      assert.equal(store.list().length, 0);
    } finally {
      site.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a member may have a few rooms on the guide at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rooms-"));
  try {
    const store = new RoomStore(RoomStore.fileFor(dir, 1));
    const channels = Array.from({ length: ROOMS_PER_MEMBER + 1 }, (_, i) => ({ ...CHANNEL, id: `c${i}` }));
    const site = await serve({ store, probe: new RoomProbe(fakeServer(channels)), base: "https://x", canControl: false, member: async () => "acct" });
    try {
      const statuses = [];
      for (const one of channels) {
        statuses.push((await fetch(`${site.base}/api/v1/guide/rooms`, { method: "POST", body: JSON.stringify({ play: PLAY.replace("folder-b19b85542264", one.id), basis: "owned", agree: true }) })).status);
      }
      assert.deepEqual(statuses, [...Array(ROOMS_PER_MEMBER).fill(200), 409]);
    } finally {
      site.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

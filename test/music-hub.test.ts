import { test } from "node:test";
import assert from "node:assert/strict";
import { artistFollowId, handleMusicRoutes, isMusicPath, MusicHub, musicPageFor, parseMirrors, parseMoved, serverId } from "../src/music-hub.ts";
import { buyLink } from "../src/label-routes.ts";

const S1 = "https://server1.example.com:4321";
const S2 = "https://server2.example.com:4321";

function fetcher(calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    if (url === `${S1}/api/v1/label`) return Response.json({ holder: "Profullstack, Inc.", genres: [{ genre: "Punk", station: "punkstatio", artists: [{ key: "aaaaaaaaaa", name: "The Bent Spokes", genre: "Punk", bio: "Teenagers.", members: [{ slug: "kai", name: "Kai", role: "vocals", bio: "" }], albums: [] }] }] });
    if (url === `${S1}/api/v1/stations/guide?local=1`) return Response.json({ stations: [
      { id: "punkstatio", name: "Profullstack AI · Punk", group: "ai", state: "live", page: `${S1}/station/punkstatio?t=TOKEN1`, nowPlaying: { title: "Burn the Schedule", artist: "The Bent Spokes" } },
      { id: "rockradio1", name: "Rock Radio", group: "radio", state: "live", page: `${S1}/station/rockradio1?t=T`, nowPlaying: null },
      { id: "elsewhere1", name: "Elsewhere", group: "ai", state: "live", page: `https://evil.example/station/elsewhere1?t=T`, nowPlaying: null },
    ] });
    if (url === `${S2}/api/v1/label`) return Response.json({ holder: "Profullstack, Inc.", genres: [{ genre: "Punk", station: "", artists: [{ key: "bbbbbbbbbb", name: "Gutter Velvet", genre: "Punk", bio: "", albums: [] }] }] });
    return new Response("gone", { status: 503 });
  }) as typeof fetch;
}

test("servers go by an opaque id both sides can work out; Buy links carry it, not the address", () => {
  assert.match(serverId(S1), /^[a-f0-9]{10}$/);
  assert.equal(serverId(S1), serverId(`${S1}/`));
  assert.notEqual(serverId(S1), serverId(S2));
  const link = buyLink("https://nixamp.com", S1, "album", "aaaaaaaaaa", "bbbbbbbb");
  assert.ok(!link.includes("server1"), link);
  assert.equal(new URL(link).searchParams.get("server"), serverId(S1));
  assert.equal(artistFollowId("The Bent Spokes"), "artist:the-bent-spokes");
});

test("the catalogue gathers every server's label and AI stations, under ids, and is kept a minute", async () => {
  const calls: string[] = [];
  let now = 0;
  const hub = new MusicHub({ peers: () => [S1, S2], fetcher: fetcher(calls), now: () => now });
  const catalogue = await hub.catalogue();
  assert.deepEqual(catalogue.holders, ["Profullstack, Inc."]);
  const punk = catalogue.genres.find((one) => one.genre === "Punk")!;
  // Servers answer in any order: compare as a set.
  assert.deepEqual(punk.artists.map((one) => [one.name, one.server, one.follow]).sort(), [
    ["Gutter Velvet", serverId(S2), "artist:gutter-velvet"],
    ["The Bent Spokes", serverId(S1), "artist:the-bent-spokes"],
  ]);
  assert.equal(punk.stations[0]?.token, "TOKEN1");
  assert.equal(punk.stations[0]?.listen, `${S1}/api/v1/stations/punkstatio`);
  assert.deepEqual(catalogue.stations.map((one) => one.id), ["punkstatio"], "only AI stations, and only on the server that lists them");
  assert.equal(hub.resolve(serverId(S2)), S2);
  assert.equal(hub.resolve("0000000000"), "");
  const asked = calls.length;
  await hub.catalogue();
  assert.equal(calls.length, asked, "kept for a minute");
  now += 61_000;
  await hub.catalogue();
  assert.ok(calls.length > asked, "and gathered again after");
});

test("live.streaming's /radio artist and album addresses find the same page of the music app", async () => {
  const hub = new MusicHub({ peers: () => [S1], fetcher: (async (url: string) => {
    if (url === `${S1}/api/v1/label`) return Response.json({ holder: "P", genres: [{ genre: "Metal", station: "", artists: [{ key: "cccccccccc", name: "Hollow Sovereign", genre: "Metal", bio: "", albums: [{ key: "dddddddd", title: "Crown of Ash", year: 2026, concept: "", cover: true, complete: true, songs: [] }] }] }] });
    return new Response("none", { status: 404 });
  }) as typeof fetch });
  const id = serverId(S1);
  assert.equal(await musicPageFor(hub, "/radio/artist/hollow-sovereign"), `/music/artist/${id}/cccccccccc`);
  assert.equal(await musicPageFor(hub, "/radio/album/hollow-sovereign-crown-of-ash"), `/music/album/${id}/cccccccccc/dddddddd`);
  assert.equal(await musicPageFor(hub, "/radio/artist/nobody"), "");
});

test("an empty catalogue (no server has said hello yet) is asked for again in seconds, not a minute", async () => {
  let now = 0;
  let peers: string[] = [];
  const hub = new MusicHub({ peers: () => peers, fetcher: fetcher([]), now: () => now });
  assert.equal((await hub.catalogue()).genres.length, 0);
  peers = [S1];
  now += 11_000;
  assert.equal((await hub.catalogue()).genres.length, 1);
});

test("the app's paths: the pages, the catalogue, files through nixamp.com, and released", () => {
  for (const ok of ["/music", "/music/me", "/music/artist/0123456789/aaaaaaaaaa", "/api/v1/music", "/api/v1/music/released",
    "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/cover.jpg", "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/3.txt", "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/3.mp4",
    "/api/v1/music/file/0123456789/aaaaaaaaaa/members/kai-rylan.jpg", "/api/v1/music/file/0123456789/aaaaaaaaaa/artist.md"]) assert.ok(isMusicPath(ok), ok);
  for (const no of ["/musical", "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/1.mp3", "/api/v1/music/file/x/../../etc/passwd"]) assert.ok(!isMusicPath(no), no);
});

test("a label that moved: the old server is not listed twice and its old addresses go to the new id", async () => {
  assert.deepEqual(parseMoved(` ${S1}/ > ${S2} ,junk,${S2}>${S2}`), { [S1]: S2 });
  const hub = new MusicHub({ peers: () => [S1, S2], fetcher: fetcher([]), moved: { [S1]: S2 } });
  const catalogue = await hub.catalogue();
  assert.deepEqual(catalogue.genres.flatMap((one) => one.artists.map((artist) => artist.server)), [serverId(S2)]);
  assert.equal(hub.movedTo(serverId(S1)), serverId(S2));
  assert.equal(hub.movedTo(serverId(S2)), "");
  const answered: Array<{ status: number; headers: Record<string, string> }> = [];
  const response = { writeHead(status: number, headers: Record<string, string>) { answered.push({ status, headers }); }, end() {} } as never;
  const ctx = { hub, json: () => undefined, readBody: async () => "", page: () => "<html></html>" };
  for (const [path, want] of [
    [`/music/album/${serverId(S1)}/aaaaaaaaaa/bbbbbbbb`, `/music/album/${serverId(S2)}/aaaaaaaaaa/bbbbbbbb?x=1`],
    [`/api/v1/music/file/${serverId(S1)}/aaaaaaaaaa/bbbbbbbb/1.mp4`, `/api/v1/music/file/${serverId(S2)}/aaaaaaaaaa/bbbbbbbb/1.mp4?x=1`],
  ] as const) {
    answered.length = 0;
    assert.equal(await handleMusicRoutes({ method: "GET", url: `${path}?x=1`, headers: {} } as never, response, path, ctx), true);
    assert.deepEqual(answered, [{ status: 301, headers: { location: want, "cache-control": "public, max-age=86400" } }]);
  }
});

test("files come from the server's mirror (a c0mpute site) first, by the label's own folder names, and from the server when the mirror lacks them", async () => {
  const MIRROR = "https://gateway.c0mpute.example/s/28c1945dfaf4e11f1350";
  assert.deepEqual(parseMirrors(`${S1}/ > ${MIRROR}/`), { [S1]: MIRROR });
  const label = (async (url: string) => {
    if (url === `${S1}/api/v1/label`) return Response.json({ holder: "Profullstack, Inc.", genres: [{ genre: "Celtic Punk Core", station: "", artists: [{ key: "aaaaaaaaaa", name: "Blackshore Brigade", genre: "Celtic Punk Core", bio: "", albums: [
      { key: "bbbbbbbb", title: "Rebel Tides Rise", year: 2026, concept: "", cover: true, complete: true, songs: [{ n: 1, title: "Riot's Edge", seconds: 180 }, { n: 12, title: "Whistle: and Rise?", seconds: 600 }] }] }] }] });
    return new Response("gone", { status: 503 });
  }) as typeof fetch;
  const hub = new MusicHub({ peers: () => [S1], fetcher: label, mirrors: parseMirrors(`${S1}>${MIRROR}`) });
  const id = serverId(S1);
  const folder = `${MIRROR}/celtic-punk-core/Blackshore%20Brigade/2026-Rebel%20Tides%20Rise`;
  assert.equal(await hub.mirrorUrl(id, "aaaaaaaaaa/bbbbbbbb/cover.jpg"), `${folder}/cover.jpg`);
  assert.equal(await hub.mirrorUrl(id, "aaaaaaaaaa/bbbbbbbb/1.txt"), `${folder}/001.%20Riot's%20Edge.lyrics.txt`);
  // The label's file names drop what a file system refuses (fileName in ai-label.ts).
  assert.equal(await hub.mirrorUrl(id, "aaaaaaaaaa/bbbbbbbb/12.mp4"), `${folder}/012.%20Whistle%20and%20Rise.mp4`);
  assert.equal(await hub.mirrorUrl(id, "aaaaaaaaaa/artist.md"), `${MIRROR}/celtic-punk-core/Blackshore%20Brigade/artist.md`);
  assert.equal(await hub.mirrorUrl(id, "aaaaaaaaaa/members/kai.jpg"), `${MIRROR}/celtic-punk-core/Blackshore%20Brigade/members/kai.jpg`);
  for (const unknown of ["aaaaaaaaaa/bbbbbbbb/2.txt", "aaaaaaaaaa/cccccccc/cover.jpg", "zzzzzzzzzz/artist.md"]) assert.equal(await hub.mirrorUrl(id, unknown), "", unknown);
  assert.equal(await new MusicHub({ peers: () => [S1], fetcher: label }).mirrorUrl(id, "aaaaaaaaaa/bbbbbbbb/cover.jpg"), "", "no mirror set up");

  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url) === `${folder}/cover.jpg`) return new Response("from-mirror", { headers: { "content-type": "image/jpeg" } });
    if (String(url).startsWith(MIRROR)) return new Response("not yet", { status: 404 });
    if (String(url) === `${S1}/api/v1/label/aaaaaaaaaa/bbbbbbbb/1.txt`) return new Response("from-server", { headers: { "content-type": "text/plain" } });
    return new Response("gone", { status: 503 });
  }) as typeof fetch;
  try {
    for (const [file, body, source] of [["aaaaaaaaaa/bbbbbbbb/cover.jpg", "from-mirror", "mirror"], ["aaaaaaaaaa/bbbbbbbb/1.txt", "from-server", "server"]] as const) {
      const path = `/api/v1/music/file/${id}/${file}`;
      let head: Record<string, string> = {};
      const chunks: string[] = [];
      const response = { headersSent: false, writeHead(_status: number, headers: Record<string, string>) { head = headers; }, write(chunk: Uint8Array) { chunks.push(Buffer.from(chunk).toString()); return true; }, end() {}, once() {} } as never;
      const ctx = { hub, json: () => undefined, readBody: async () => "", page: () => "<html></html>" };
      assert.equal(await handleMusicRoutes({ method: "GET", url: path, headers: {} } as never, response, path, ctx), true);
      assert.equal(chunks.join(""), body, file);
      assert.equal(head["x-nixamp-source"], source, file);
    }
    assert.deepEqual(asked, [`${folder}/cover.jpg`, `${folder}/001.%20Riot's%20Edge.lyrics.txt`, `${S1}/api/v1/label/aaaaaaaaaa/bbbbbbbb/1.txt`]);
  } finally {
    globalThis.fetch = real;
  }
});

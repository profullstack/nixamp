import { test } from "node:test";
import assert from "node:assert/strict";
import { artistFollowId, isMusicPath, MusicHub, musicPageFor, serverId } from "../src/music-hub.ts";
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

test("the app's paths: the pages, the catalogue, files through nixamp.com, and released", () => {
  for (const ok of ["/music", "/music/me", "/music/artist/0123456789/aaaaaaaaaa", "/api/v1/music", "/api/v1/music/released",
    "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/cover.jpg", "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/3.txt",
    "/api/v1/music/file/0123456789/aaaaaaaaaa/members/kai-rylan.jpg", "/api/v1/music/file/0123456789/aaaaaaaaaa/artist.md"]) assert.ok(isMusicPath(ok), ok);
  for (const no of ["/musical", "/api/v1/music/file/0123456789/aaaaaaaaaa/bbbbbbbb/1.mp3", "/api/v1/music/file/x/../../etc/passwd"]) assert.ok(!isMusicPath(no), no);
});

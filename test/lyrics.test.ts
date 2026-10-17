import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LyricsFinder, lyricsFromTags } from "../src/lyrics.ts";
import { LyricsPublisher, mayPublishLyrics } from "../src/lyrics-publish.ts";
import { handleStations, isStationListenPath, type StationContext } from "../src/station-routes.ts";
import type { Station } from "../src/stations.ts";

const SUNO = "[Verse 1 — low, spoken]\nFrost on the oar\nSalt in the rope\n\n[Chorus]\nRow, row";

const station = (over: Partial<Station> = {}): Station => ({
  id: "rvhmw2dwv3", name: "Þrøngva Radio", description: "", items: ["/m/a.mp3", "/m/b.mp3", "/m/c.mp3"], shuffle: true, repeat: true,
  visibility: "public", listed: true, desired: "running", listenToken: "good-token", bitrate: 192, video: false, breaksEvery: 0, auto: "",
  rights: { basis: "owned", note: "Original music by Profullstack, made with Suno", declaredAt: 0, declaredBy: "x" },
  owner: "", failures: {}, idempotencyKey: "", createdAt: 0, updatedAt: 0, ...over,
});

test("the file's own lyrics tag: USLT as ffprobe names it, and the other spellings", () => {
  assert.deepEqual(lyricsFromTags({ title: "x", "lyrics-eng": SUNO }), { text: SUNO, language: "en" });
  assert.deepEqual(lyricsFromTags({ "lyrics-suno-deu": "Wort" }), { text: "Wort", language: "de" });
  assert.deepEqual(lyricsFromTags({ lyrics: "a\r\nb" }), { text: "a\nb", language: "" });
  assert.deepEqual(lyricsFromTags({ unsyncedlyrics: "la la" }), { text: "la la", language: "" });
  assert.equal(lyricsFromTags({ "lyrics-xxx": "  " }), null, "blank is not lyrics");
  assert.equal(lyricsFromTags({ title: "x", comment: "made with suno" }), null);
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("no tag: nichedb by artist and title, kept ten minutes, misses too", async () => {
  const asked: string[] = [];
  let now = 0;
  const finder = new LyricsFinder({
    base: "https://nichedb.test",
    tags: async (file) => (file === "/m/own.mp3" ? { title: "Frost", artist: "Þrøngva", "lyrics-eng": SUNO } : { title: file === "/m/hit.mp3" ? "Hit" : "Miss", artist: "Band" }),
    fetcher: async (url) => {
      asked.push(url);
      return url.includes("title=Hit") ? json(200, { lyrics: { artist: "Band", title: "Hit", language: "en", text: "words\nmore", source: "lrclib" } }) : json(404, { error: "none" });
    },
    now: () => now,
  });
  assert.deepEqual(await finder.find("/m/own.mp3"), { title: "Frost", artist: "Þrøngva", text: SUNO, source: "embedded", language: "en" });
  assert.equal(asked.length, 0, "a tagged file never asks nichedb");
  assert.equal((await finder.find("/m/hit.mp3"))?.source, "nichedb");
  assert.equal(asked[0], "https://nichedb.test/api/v1/lyrics?artist=Band&title=Hit");
  assert.equal(await finder.find("/m/miss.mp3"), null);
  await finder.find("/m/hit.mp3");
  await finder.find("/m/miss.mp3");
  assert.equal(asked.length, 2, "hit and miss both kept");
  now += 11 * 60_000;
  await finder.find("/m/miss.mp3");
  assert.equal(asked.length, 3, "asked again after ten minutes");
});

test("nichedb that hangs or breaks is no lyrics, not an error", async () => {
  const finder = new LyricsFinder({
    base: "https://nichedb.test",
    timeoutMs: 50,
    tags: async () => ({ title: "Slow", artist: "Band" }),
    fetcher: (_url, init) => new Promise((_done, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted")))),
  });
  assert.equal(await finder.find("/m/slow.mp3"), null);
});

function harness(over: Partial<StationContext> & { state?: string; file?: string } = {}) {
  const one = station();
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const ctx = {
    store: { get: (id: string) => (id === one.id ? one : undefined), list: () => [one] },
    runner: { observed: () => over.state ?? "live", listeners: () => 0 },
    channels: { info: () => ({ playlist: [over.file ?? "/m/a.mp3"], playlistAt: 0 }) },
    canControl: false,
    account: "",
    json: (_response: unknown, status: number, body: unknown) => { answers.push({ status, body: body as Record<string, unknown> }); },
    headers: {},
    ...over,
  } as unknown as StationContext;
  const ask = async (path: string, method = "GET") => {
    const url = new URL(`http://x${path}`);
    await handleStations({ method, headers: {}, on: () => undefined } as never, { setHeader: () => undefined } as never, url.pathname, url, ctx);
    return answers.at(-1)!;
  };
  return { ask, one };
}

test("GET /lyrics: on the station's link, for what is on the air", async () => {
  assert.equal(isStationListenPath("/api/v1/stations/rvhmw2dwv3/lyrics"), true);
  const files: string[] = [];
  const { ask } = harness({ lyrics: async (_s, file) => { files.push(file); return file === "/m/a.mp3" ? { title: "Frost", artist: "Þrøngva", text: SUNO, source: "embedded", language: "en" } : null; } });
  const ok = await ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=good-token");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body["lyrics"], { title: "Frost", artist: "Þrøngva", text: SUNO, source: "embedded", language: "en" });
  assert.deepEqual(files, ["/m/a.mp3"]);
  assert.equal((await ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=wrong")).status, 404, "a wrong link");
  assert.equal((await ask("/api/v1/stations/rvhmw2dwv3/lyrics")).status, 404, "no link");
  assert.equal((await ask("/api/v1/stations/zzzzzzzzzz/lyrics?t=good-token")).status, 404, "no such station");
  assert.equal((await ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=good-token", "POST")).status, 405);
});

test("GET /lyrics: 404 when the track has none, the station is off, or it is private", async () => {
  assert.equal((await harness({ file: "/m/b.mp3", lyrics: async () => null }).ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=good-token")).status, 404);
  let asked = false;
  const off = harness({ state: "stopped", lyrics: async () => { asked = true; return { title: "", artist: "", text: "x", source: "embedded", language: "" }; } });
  assert.equal((await off.ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=good-token")).status, 404);
  assert.equal(asked, false, "nothing on the air, nothing read");
  const closed = harness({ lyrics: async () => ({ title: "", artist: "", text: "x", source: "embedded", language: "" }) });
  closed.one.visibility = "private";
  assert.equal((await closed.ask("/api/v1/stations/rvhmw2dwv3/lyrics?t=good-token")).status, 404, "a private station's link opens nothing");
});

test("publishing: only public, listed, owned stations", () => {
  assert.equal(mayPublishLyrics(station()), true);
  assert.equal(mayPublishLyrics(station({ rights: { basis: "licensed", note: "", declaredAt: 0, declaredBy: "x" } })), false);
  assert.equal(mayPublishLyrics(station({ rights: { basis: "public-domain", note: "", declaredAt: 0, declaredBy: "x" } })), false);
  assert.equal(mayPublishLyrics(station({ rights: null })), false);
  assert.equal(mayPublishLyrics(station({ visibility: "unlisted" })), false);
  assert.equal(mayPublishLyrics(station({ listed: false })), false);
});

test("publishing: tagged files once per text, with the key, never without one or for a station not owned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-lyrics-"));
  try {
    const sent: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    let key = "nl_test";
    const tags: Record<string, Record<string, string>> = {
      "/m/a.mp3": { title: "Frost", artist: "Þrøngva", album: "Oar", "lyrics-eng": SUNO },
      "/m/b.mp3": { title: "Instrumental", artist: "Þrøngva" },
      "/m/c.mp3": { "lyrics-eng": "no title, no artist" },
    };
    const stations = [station(), station({ id: "rockradio1", rights: { basis: "licensed", note: "", declaredAt: 0, declaredBy: "x" } })];
    const make = () => new LyricsPublisher({
      file: join(dir, "p.json"),
      key: () => key,
      stations: () => stations,
      tags: async (file) => tags[file] ?? {},
      base: "https://nichedb.test",
      gapMs: 0,
      fetcher: async (url, init) => {
        sent.push({ url, auth: String((init?.headers as Record<string, string>)["authorization"]), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json(201, { ok: true });
      },
    });
    const publisher = make();
    const [report] = await publisher.publishAll();
    assert.deepEqual({ ...report, stopped: undefined }, { station: "rvhmw2dwv3", published: 1, unchanged: 0, without: 2, failed: 0, stopped: undefined });
    assert.equal(sent.length, 1, "the licensed station is not published");
    assert.equal(sent[0]!.url, "https://nichedb.test/api/v1/lyrics");
    assert.equal(sent[0]!.auth, "Bearer nl_test");
    assert.deepEqual(sent[0]!.body, { artist: "Þrøngva", title: "Frost", album: "Oar", language: "en", text: SUNO, source: "embedded" });
    // Remembered across restarts: the same words are not sent again.
    await make().publishAll();
    assert.equal(sent.length, 1);
    tags["/m/a.mp3"]!["lyrics-eng"] = `${SUNO}\nnew line`;
    await make().publishAll();
    assert.equal(sent.length, 2, "changed words go again");
    const refused = await make().publish(stations[1]!);
    assert.match(refused.stopped, /not declared owned/);
    key = "";
    tags["/m/a.mp3"]!["lyrics-eng"] = "again";
    const keyless = await make().publish(stations[0]!);
    assert.match(keyless.stopped, /no key/);
    assert.equal(sent.length, 2, "nothing without a key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishing: a refused key stops the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-lyrics-"));
  try {
    let posts = 0;
    const publisher = new LyricsPublisher({
      file: join(dir, "p.json"),
      key: () => "bad",
      stations: () => [station()],
      tags: async (file) => ({ title: file, artist: "Þrøngva", "lyrics-eng": "words" }),
      base: "https://nichedb.test",
      gapMs: 0,
      fetcher: async () => { posts += 1; return json(401, { error: "bad key" }); },
    });
    const [report] = await publisher.publishAll();
    assert.equal(posts, 1);
    assert.match(report!.stopped, /401/);
    assert.equal((publisher.status() as { published: number }).published, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

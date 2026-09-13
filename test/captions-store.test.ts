import { test } from "node:test";
import assert from "node:assert/strict";
import { Captions, WINDOW_MS, lineAt, mediaSpan, type CaptionLine, type ChannelMedia, type Decoder } from "../src/captions.ts";
import { NATIVE_REVISION, RATE } from "../src/speech.ts";
import type { Listener } from "../src/channels.ts";
import { transcriptIdOf } from "../src/transcripts.ts";

function window(loud: boolean, seconds = WINDOW_MS / 1000): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2);
  if (loud) for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  return pcm;
}

const FILM = "file:v1:" + "ab".repeat(32);
const FILM_ID = transcriptIdOf(FILM);
const LIVE = "live:box.test:4321/live@1000000";

/**
 * nixamp.com as the captioner sees it: an ear, a store with a film in it
 * (two lines, and one of them in German), and a translator that wraps
 * whatever it is given.
 */
function storeWorld(legacy = false) {
  const listeners = new Map<string, Listener>();
  const heard: { language: string | null }[] = [];
  const kept: Record<string, unknown>[] = [];
  const translated: Record<string, unknown>[] = [];
  const fetched: string[] = [];
  let now = 1_000_000;
  const decoder = (onPcm: (pcm: Buffer) => void): Decoder => ({ write: (chunk) => { onPcm(chunk); return true; }, end: () => undefined });
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/speech/transcribe") {
      heard.push({ language: url.searchParams.get("language") });
      return json(200, { text: `heard ${heard.length}`, seconds: 5, language: "en", model: "whisper-test" });
    }
    if (url.pathname === "/api/v1/translate") {
      const body = JSON.parse(String(init?.body)) as { texts: string[]; from: string; to: string };
      translated.push(body);
      return json(200, { texts: body.texts.map((text) => `${body.to}(${text})`), from: body.from, to: body.to, model: "opus-test" });
    }
    if (url.pathname === `/api/v1/transcripts/${FILM_ID}/lines`) {
      const body = JSON.parse(String(init?.body)) as { lines: unknown[] };
      kept.push(body);
      return json(200, { saved: body.lines.length, seconds: 0, complete: false });
    }
    if (url.pathname === `/api/v1/transcripts/${FILM_ID}`) {
      const language = url.searchParams.get("language") ?? "";
      fetched.push(language);
      if (language === "") {
        return json(200, {
          id: FILM_ID, media: FILM, kind: "file", language: "en", translatedFrom: null, model: "whisper-test", complete: false, title: "A film",
          seconds: 10, updatedAt: "", languages: [],
          lines: [{ start: 0, end: 5, text: "stored one", language: "en", ...(legacy ? {} : { revision: NATIVE_REVISION }) }, { start: 5, end: 10, text: "stored two", language: "en", ...(legacy ? {} : { revision: NATIVE_REVISION }) }],
        });
      }
      if (language === "de") {
        return json(200, {
          id: FILM_ID, media: FILM, kind: "file", language: "de", translatedFrom: "en", model: "opus-test", complete: false, title: "A film",
          seconds: 5, updatedAt: "", languages: [], lines: [{ start: 0, end: 5, text: "eins", original: "stored one", revision: NATIVE_REVISION }],
        });
      }
      return json(404, { error: "nothing written down" });
    }
    if (url.pathname.startsWith("/api/v1/transcripts/")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init?.body)) as { lines: unknown[] };
        kept.push(body);
        return json(200, { saved: body.lines.length, seconds: 0, complete: false });
      }
      fetched.push(url.searchParams.get("language") ?? "");
      return json(404, { error: "nothing written down" });
    }
    return json(404, { error: `no route ${url.pathname}` });
  }) as typeof fetch;
  const events: string[] = [];
  const media: Record<string, ChannelMedia> = {
    // Six seconds in with a six-second backlog: the first byte a listener gets is the film's start.
    film: { media: FILM, title: "A film", position: 6, startedAt: 1_000_000, backlog: 6 },
    live: { media: LIVE, title: "Live", startedAt: 1_000_000, backlog: 6 },
  };
  const captions = new Captions({
    ffmpeg: ["ffmpeg"],
    listen: (id, listener) => {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    session: () => ({ site: "https://nixamp.test/", token: "nxa_server" }),
    fetcher,
    decoder,
    mediaOf: (id) => media[id] ?? null,
    now: () => now,
    onEvent: (message) => events.push(message),
    idleMs: 10,
    flushMs: 15,
  });
  return {
    captions, listeners, heard, kept, translated, fetched, events,
    feed: (id: string, pcm: Buffer) => listeners.get(id)?.write(pcm),
    tick: (ms: number) => { now += ms; },
    settle: (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

test("a window's seconds into the media: from a film's position and the backlog, or from a live's start; and the stored line at a moment", () => {
  const film: ChannelMedia = { media: FILM, title: "", position: 100, startedAt: 0, backlog: 6 };
  assert.deepEqual(mediaSpan(film, 0, 5, 0, 5000), { start: 94, end: 99 });
  assert.deepEqual(mediaSpan(film, 3, 5, 0, 5000), { start: 109, end: 114 });
  assert.deepEqual(mediaSpan({ ...film, position: 2 }, 0, 5, 0, 5000), { start: 0, end: 5 });
  const live: ChannelMedia = { media: LIVE, title: "", startedAt: 1_000_000, backlog: 6 };
  assert.deepEqual(mediaSpan(live, 7, 5, 1_030_000, 1_035_000), { start: 30, end: 35 });
  assert.deepEqual(mediaSpan(live, 0, 5, 999_000, 1_004_000), { start: 0, end: 4 });
  const lines = [{ start: 0, end: 5, text: "a" }, { start: 5.4, end: 10, text: "b" }, { start: 20, end: 25, text: "c" }];
  assert.equal(lineAt(lines, 5)?.text, "b");
  assert.equal(lineAt(lines, 0.9)?.text, "a");
  assert.equal(lineAt(lines, 12), null);
});

test("a film the store knows is read out of the store, and what the ear hears beyond it is kept", async () => {
  const world = storeWorld();
  const got: CaptionLine[] = [];
  const off = world.captions.subscribe("film", (line) => got.push(line));
  assert.ok(off);
  await world.settle();
  assert.deepEqual(world.fetched, [""]);
  assert.match(world.events.find((one) => one.includes("store knows")) ?? "", /2 lines/);
  assert.equal(world.captions.status("film").known, 2);
  assert.equal(world.captions.status("film").language, "");

  // The first two windows are moments the store has been through: no ask, the stored words, stamped for this playback.
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  assert.equal(world.heard.length, 0);
  assert.deepEqual(got.map((line) => line.text), ["stored one", "stored two"]);
  assert.equal(got[0]?.at, 1_005_000 - WINDOW_MS);
  assert.equal(got[0]?.until, 1_005_000);
  assert.equal(got[0]?.language, "en");
  assert.equal(got[1]?.at, 1_010_000 - WINDOW_MS);

  // The third window is new: the ear is asked, told the language, and the line is kept as seconds 10 to 15.
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  assert.deepEqual(world.heard, [{ language: null }]);
  assert.equal(got[2]?.text, "heard 1");
  await world.settle(30);
  assert.equal(world.kept.length, 1);
  assert.deepEqual(world.kept[0], {
    media: FILM, title: "A film", language: "", model: "whisper-test",
    lines: [{ start: 10, end: 15, text: "heard 1", language: "en", voiceProfile: "higher", revision: NATIVE_REVISION }],
  });
  assert.deepEqual(world.captions.recent("film").map((line) => line.text), ["stored one", "stored two", "heard 1"]);
  off();
});

test("a listener who wants German gets each line translated once, from the store when it has been through that moment, and the translations are kept", async () => {
  const world = storeWorld();
  const german: CaptionLine[] = [];
  const english: CaptionLine[] = [];
  const offDe = world.captions.subscribe("film", (line) => german.push(line), "de");
  const offEn = world.captions.subscribe("film", (line) => english.push(line));
  assert.ok(offDe && offEn);
  await world.settle();
  assert.deepEqual(world.fetched.sort(), ["", "de"]);

  // The first window is known in both languages: nothing is asked of anybody.
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  assert.equal(world.translated.length, 0);
  assert.deepEqual(german.map((line) => line.text), ["eins"]);
  assert.equal(german[0]?.original, "stored one");
  assert.equal(german[0]?.language, "de");
  assert.deepEqual(english.map((line) => line.text), ["stored one"]);

  // The second is known only in English: translated once, on nixamp.com, from the heard language.
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  assert.deepEqual(world.translated, [{ texts: ["stored two"], from: "en", to: "de" }]);
  assert.deepEqual(german.map((line) => line.text), ["eins", "de(stored two)"]);
  assert.deepEqual(world.captions.recent("film", 0, "de").map((line) => line.text), ["eins", "de(stored two)"]);
  assert.deepEqual(world.captions.recent("film", 0, "en").map((line) => line.text), ["stored one", "stored two"]);
  assert.deepEqual(world.captions.status("film").languages, ["de"]);

  // The third is heard, then translated, and both go to the store: the German says what it came from.
  world.tick(5000);
  world.feed("film", window(true));
  await world.settle();
  assert.equal(world.heard.length, 1);
  assert.deepEqual(german[2]?.text, "de(heard 1)");
  await world.settle(30);
  const languages = world.kept.map((batch) => `${batch["language"]}<${batch["translatedFrom"] ?? ""}`).sort();
  assert.deepEqual(languages, ["<", "de<en"]);
  const kept = world.kept.find((batch) => batch["language"] === "de");
  assert.deepEqual(kept?.["lines"], [{ start: 5, end: 10, text: "de(stored two)", original: "stored two", revision: NATIVE_REVISION }, { start: 10, end: 15, text: "de(heard 1)", original: "heard 1", revision: NATIVE_REVISION }]);
  offDe();
  offEn();
});

test("a file channel describes its file once for nixamp.com/hash/<id>, and the status carries the hash", async () => {
  const world = storeWorld();
  const kept: { url: string; body: Record<string, unknown> }[] = [];
  const HEX = "ef".repeat(32);
  const inner = world.captions;
  const captions = new Captions({
    ffmpeg: ["ffmpeg"],
    listen: (id, listener) => {
      world.listeners.set(id, listener);
      return () => world.listeners.delete(id);
    },
    session: () => ({ site: "https://nixamp.test/", token: "nxa_server" }),
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v1/media/${HEX}` && init?.method === "PUT") {
        kept.push({ url: url.toString(), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ id: `sha256:${HEX}` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "nothing" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    decoder: (onPcm) => ({ write: (chunk) => { onPcm(chunk); return true; }, end: () => undefined }),
    mediaOf: () => ({
      media: FILM, title: "A film", position: 6, startedAt: 1_000_000, backlog: 6,
      describe: async () => ({ id: HEX, keep: { name: "film.mkv", size: 10, facts: { duration: 90 }, holder: { url: "https://s1", channel: "film" } } }),
    }),
    now: () => 1_000_000,
    idleMs: 10,
  });
  void inner;
  const off = captions.subscribe("film", () => undefined);
  assert.ok(off);
  await world.settle(20);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.body["name"], "film.mkv");
  assert.equal((kept[0]?.body["holder"] as { channel: string }).channel, "film");
  assert.equal(captions.status("film").hash, HEX);
  off();
});

test("a live is kept as the broadcast it is, in seconds from when it began", async () => {
  const world = storeWorld();
  const got: CaptionLine[] = [];
  const off = world.captions.subscribe("live", (line) => got.push(line));
  assert.ok(off);
  await world.settle();
  world.tick(30_000);
  world.feed("live", window(true));
  await world.settle();
  assert.equal(got[0]?.text, "heard 1");
  await world.settle(30);
  assert.equal(world.kept.length, 1);
  assert.deepEqual(world.kept[0]?.["lines"], [{ start: 25, end: 30, text: "heard 1", language: "en", voiceProfile: "higher", revision: NATIVE_REVISION }]);
  assert.equal(world.kept[0]?.["media"], LIVE);
  off();
});

 test("legacy English cache cannot override native audio detection", async () => {
 const world = storeWorld(true);
 const got: CaptionLine[] = [];
 world.captions.subscribe("film", line => got.push(line));
 await world.settle();
 assert.equal(world.captions.status("film").known, 0);
 assert.equal(world.captions.status("film").language, "");
 world.tick(5000); world.feed("film", window(true));
 await world.settle();
 assert.deepEqual(world.heard, [{ language: null }]);
 assert.equal(got[0]?.text, "heard 1");
 world.captions.stopAll();
 });

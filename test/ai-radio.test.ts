import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiRadio, OutOfCredit, PRESETS, plainBrief, writeBrief, type Composer } from "../src/ai-radio.ts";
import { NoModel, firstObject } from "../src/ai-text.ts";
import { Channels } from "../src/channels.ts";
import { LibraryIndex, type Probed } from "../src/library-index.ts";
import { emptySnapshot } from "../src/protocol.ts";
import { createServer, type Engine } from "../src/server.ts";
import { StationRunner } from "../src/station-runner.ts";
import { StationStore } from "../src/stations.ts";

const memory = () => ({ read: () => null, write: () => undefined });
const probe = async (): Promise<Probed> => ({ state: "ready", error: "", duration: 120, codec: "mp3", bitrate: 192, sampleRate: 44100, channels: 2, video: false, hasArt: false, tags: {} });

function setup(composer: Composer | null, ask?: Parameters<typeof writeBrief>[1]) {
  const top = mkdtempSync(join(tmpdir(), "nixamp-ai-"));
  const index = new LibraryIndex(LibraryIndex.fileFor(top, 1), memory());
  const store = new StationStore(StationStore.fileFor(top, 1), memory());
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const runner = new StationRunner({ store, channels, pull: async () => false, roots: () => index.roots() });
  const asked: string[] = [];
  const ai = new AiRadio(join(top, "ai-radio.json"), {
    index, store, runner, probe, ffmpeg: ["ffmpeg"], root: join(top, "ai-music"), owner: "chovy",
    mayStart: () => false,
    composer: () => composer,
    tag: async (from, to) => { copyFileSync(from, to); },
    ask: ask ?? (async (options) => {
      asked.push(options.prompt);
      return { model: "test-model", value: { title: `Track ${asked.length}`, prompt: "warm lo-fi, 80 BPM, Rhodes" } };
    }),
    canAsk: () => true,
  });
  return { top, index, store, runner, channels, ai, asked };
}

const fakeComposer = (calls: Array<{ prompt: string; seconds: number; vocals: boolean }>): Composer => ({
  name: "fake/music",
  async compose(input) {
    calls.push({ prompt: input.prompt, seconds: input.seconds, vocals: input.vocals });
    writeFileSync(input.out, Buffer.alloc(4096, calls.length));
  },
});

test("an AI station composes, lands in a managed source, and goes on the guide as owned", async () => {
  const calls: Array<{ prompt: string; seconds: number; vocals: boolean }> = [];
  const { top, store, ai, asked } = setup(fakeComposer(calls));
  try {
    const made = ai.create({ preset: "lofi", trackSeconds: 60, perDay: 0 });
    // create() kicks off a tick; let it finish before asking for more.
    for (let tries = 0; tries < 100 && ai.get(made.key)!.tracks.length < 1; tries++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(made.name, PRESETS["lofi"]!.name);
    const first = ai.get(made.key)!;
    assert.equal(first.tracks.length, 1);
    assert.ok(existsSync(first.tracks[0]!.file), "the tagged file is there");
    assert.match(first.tracks[0]!.file, /ai-music\/[a-f0-9]{10}\/0001 Track 1\.mp3$/);
    assert.equal(calls[0]!.seconds, 60);
    assert.equal(calls[0]!.vocals, false, "the preset is instrumental");
    const station = store.get(first.stationId)!;
    assert.equal(station.auto, `ai:${made.key}`);
    assert.equal(station.visibility, "public");
    assert.equal(station.listed, true);
    assert.equal(station.rights?.basis, "owned");
    assert.deepEqual(station.items, [first.tracks[0]!.file]);

    await ai.generate(made.key);
    assert.deepEqual(store.get(first.stationId)!.items.length, 2, "the next track joins the same station");
    assert.match(asked[1]!, /Track 1/, "the brief is told what is already on the station");
    const status = ai.status() as { secondsThisMonth: number; stations: Array<{ tracks: number }> };
    assert.equal(status.secondsThisMonth, 120);
    assert.equal(status.stations[0]!.tracks, 2);
  } finally {
    ai.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("the month's budget, running out of credit, and briefs without a model", async () => {
  let credit = true;
  const composer: Composer = {
    name: "fake/music",
    async compose({ out }) {
      if (!credit) throw new OutOfCredit("out of credit");
      writeFileSync(out, Buffer.alloc(4096, 7));
    },
  };
  const { top, ai, store } = setup(composer, async () => { throw new NoModel(); });
  try {
    ai.configure({ monthlySeconds: 150 });
    const made = ai.create({ name: "Test FM", style: "upbeat chiptune with square leads", trackSeconds: 100, perDay: 0, publish: false, enabled: false });
    const track = await ai.generate(made.key);
    assert.match(track.made, /^plain \+ fake\/music$/, "no model: a plain brief from the style");
    assert.match(track.prompt, /upbeat chiptune/);
    assert.equal(store.get(ai.get(made.key)!.stationId)!.visibility, "unlisted", "publish: false is a link, not a listing");
    await assert.rejects(ai.generate(made.key), (error: Error & { code?: string }) => error.code === "budget_used");
    ai.configure({ monthlySeconds: 0 });
    credit = false;
    await assert.rejects(ai.generate(made.key));
    assert.match(String((ai.status() as { paused: string }).paused), /out of credit/);
    await assert.rejects(ai.generate(made.key), (error: Error & { code?: string }) => error.code === "paused");
    ai.configure({ resume: true });
    credit = true;
    await ai.generate(made.key);
    assert.equal(ai.get(made.key)!.tracks.length, 2);
  } finally {
    ai.stopSchedule();
    rmSync(top, { recursive: true, force: true });
  }
});

test("briefs: plain titles do not repeat; a rambling model is still read", () => {
  const titles = new Set<string>();
  const station = { style: "ambient drones", tracks: [] as Array<{ title: string }> };
  for (let i = 0; i < 30; i++) {
    const brief = plainBrief(station as never);
    assert.ok(!titles.has(brief.title.toLowerCase()));
    titles.add(brief.title.toLowerCase());
    station.tracks.push({ title: brief.title });
  }
  assert.deepEqual(firstObject('Sure! ```json\n{"title": "A", "prompt": "B"}\n```'), { title: "A", prompt: "B" });
  assert.deepEqual(firstObject('Here you go: {"title": "A"} hope it helps'), { title: "A" });
});

test("AI radio over HTTP is the owner's, and keys are never shown back", async () => {
  const calls: Array<{ prompt: string; seconds: number; vocals: boolean }> = [];
  const { top, store, runner, channels, ai } = setup(fakeComposer(calls));
  const engine = { snapshot: () => ({ ...emptySnapshot(), root: top }), command: () => undefined, subscribe: () => () => undefined, trackPath: () => undefined } as unknown as Engine;
  const server = createServer(engine, { web: null, media: true, version: "test", key: "ctl", listenKey: "lst", channels, stations: { store, runner, ai } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (key: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}?k=${key}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await send("lst", "GET", "/api/v1/stations/ai")).status, 403);
    const made = await send("ctl", "POST", "/api/v1/stations/ai/stations", { preset: "synthwave", perDay: 0, enabled: false });
    assert.equal(made.status, 201);
    const { station } = (await made.json()) as { station: { key: string } };
    const generated = await send("ctl", "POST", `/api/v1/stations/ai/stations/${station.key}/generate`);
    assert.equal(generated.status, 200, await generated.clone().text());
    assert.equal(((await generated.json()) as { track: { title: string } }).track.title, "Track 1");
    const bad = await send("ctl", "POST", "/api/v1/stations/ai/stations", { preset: "polka" });
    assert.equal(((await bad.json()) as { code: string }).code, "unknown_preset");
    const status = (await (await send("ctl", "GET", "/api/v1/stations/ai")).json()) as { keys: Record<string, unknown>; composer: string };
    assert.equal(status.composer, "fake/music");
    for (const value of Object.values(status.keys)) assert.equal(typeof value, "boolean");
    // The station it made is on the public guide, grouped as AI radio.
    const guide = (await (await fetch(`${base}/api/v1/stations/guide`)).json()) as { stations: Array<{ name: string; group: string }> };
    assert.deepEqual(guide.stations.map((one) => [one.name, one.group]), [[PRESETS["synthwave"]!.name, "ai"]]);
  } finally {
    ai.stopSchedule();
    const closing = new Promise<void>((done) => server.close(() => done()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await closing;
    rmSync(top, { recursive: true, force: true });
  }
});

test("a model that refuses this server hands over to the next one with a key", async () => {
  const { askJson } = await import("../src/ai-text.ts");
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(new URL(url).host);
    if (url.includes("googleapis")) return new Response(JSON.stringify({ error: { message: "User location is not supported for the API use." } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"T","prompt":"P"}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" };
  const answer = await askJson({ system: "s", prompt: "p", fetcher, env });
  assert.deepEqual(asked, ["generativelanguage.googleapis.com", "api.openai.com"]);
  assert.equal(answer.model, "gpt-4.1-mini");
  assert.deepEqual(answer.value, { title: "T", prompt: "P" });
  const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(askJson({ system: "s", prompt: "p", fetcher: failing, env }), /gemini answered HTTP 500; openai answered HTTP 500/);
});

test("an OpenAI-compatible endpoint stands in for OpenAI", async () => {
  const { askJson } = await import("../src/ai-text.ts");
  let seen: { url: string; body: Record<string, unknown> } | null = null;
  const fetcher = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Here: {"title":"T","prompt":"P"}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { OPENAI_API_KEY: "cf", NIXAMP_OPENAI_URL: "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/", NIXAMP_OPENAI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
  const answer = await askJson({ system: "s", prompt: "p", fetcher, env });
  assert.equal(seen!.url, "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions");
  assert.equal(seen!.body["model"], "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(seen!.body["response_format"], undefined, "json_object only for OpenAI itself");
  assert.equal(answer.model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.deepEqual(answer.value, { title: "T", prompt: "P" });
});

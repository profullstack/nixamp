import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askToHear, transcribe, wavOf, type Window } from "../src/transcribe.ts";
import { RATE, encodeWav } from "../src/speech.ts";
import { transcriptIdOf } from "../src/transcripts.ts";
import { callTool, TOOLS } from "../src/mcp.ts";

const session = { site: "https://nixamp.test", token: "nxa_deadbeef_secret" };
const clip = encodeWav(new Float32Array(16_000));

/** A fetch that records what was asked, including the bytes, and answers what the test says. */
function recorder(answer: unknown, status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string>; bytes: number; json?: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    const bytes = body instanceof Blob ? body.size : typeof body === "string" ? body.length : 0;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      bytes,
      ...(typeof body === "string" ? { json: JSON.parse(body) } : {}),
    });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

function quietly<T>(run: () => Promise<T>): Promise<{ result: T; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  return run().then((result) => ({ result, out, err })).finally(() => {
    console.log = log;
    console.error = error;
  });
}

test("a WAV on disk is sent as it is; anything else needs an ffmpeg, and says so without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-transcribe-"));
  const wavPath = join(dir, "line.wav");
  writeFileSync(wavPath, clip);
  assert.equal(wavOf(wavPath, () => { throw new Error("must not be asked"); }).length, clip.length);
  const other = join(dir, "line.m4a");
  writeFileSync(other, "not audio");
  assert.throws(() => wavOf(other, () => ({ ffmpeg: ["ffmpeg"], carries: false })), /no ffmpeg here/);
  assert.throws(() => wavOf(join(dir, "missing.wav")), /cannot read/);
  // An ffmpeg that is there but cannot read the file is a sentence, not a stack.
  assert.throws(() => wavOf(other, () => ({ ffmpeg: ["false"], carries: true })), /ffmpeg could not read/);
});

test("the ask is one POST of WAV bytes with the token, and a room rides in the query", async () => {
  const { calls, fetcher } = recorder({ text: "hello room", seconds: 1, model: "m", message: { id: "l1", handle: "chovy", body: "hello room", createdAt: "now" } }, 201);
  const answer = await askToHear(session, { wav: clip, language: "en", server: "https://box:4321/view/K", channel: "cat-1" }, fetcher);
  assert.ok(answer.ok);
  assert.equal(answer.heard.text, "hello room");
  assert.equal(answer.heard.message?.handle, "chovy");
  const call = calls[0];
  assert.ok(call);
  const url = new URL(call.url);
  assert.equal(url.pathname, "/api/v1/speech/transcribe");
  assert.equal(url.searchParams.get("language"), "en");
  assert.equal(url.searchParams.get("server"), "https://box:4321/view/K");
  assert.equal(url.searchParams.get("channel"), "cat-1");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["authorization"], `Bearer ${session.token}`);
  assert.equal(call.headers["content-type"], "audio/wav");
  assert.equal(call.bytes, clip.length);

  // Refusals come back as the server's sentence and status.
  const refused = recorder({ error: "sign in to nixamp.com to dictate" }, 401);
  const no = await askToHear(session, { wav: clip }, refused.fetcher);
  assert.ok(!no.ok);
  assert.equal(no.status, 401);
  assert.match(no.error, /sign in/);
  // No room asked: nothing about a room in the query.
  assert.equal(new URL(refused.calls[0]?.url ?? "").searchParams.has("server"), false);
});

test("`nixamp transcribe` prints the words, posts with --say, and refuses without a file or a session", async () => {
  const { calls, fetcher } = recorder({ text: "hello room", seconds: 1, message: { id: "l1", handle: "chovy", body: "hello room", createdAt: "now" } }, 201);
  const wav = () => clip;
  const said = await quietly(() => transcribe(["clip.m4a", "--say", "https://box:4321", "--channel", "cat-1"], { fetcher, wavOf: wav, session }));
  assert.equal(said.result, 0);
  assert.deepEqual(said.out, ["hello room"]);
  assert.match(said.err[0] ?? "", /Said in the room for cat-1 at https:\/\/box:4321 as chovy/);
  assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("channel"), "cat-1");

  const asJson = await quietly(() => transcribe(["clip.wav", "--say", "https://box:4321", "--json"], { fetcher, wavOf: wav, session }));
  assert.equal(JSON.parse(asJson.out.join("\n")).text, "hello room");

  const noFile = await quietly(() => transcribe(["--say", "https://box:4321"], { fetcher, wavOf: wav, session }));
  assert.equal(noFile.result, 64);
  const noSession = await quietly(() => transcribe(["clip.wav"], { fetcher, wavOf: wav, session: null }));
  assert.equal(noSession.result, 1);
  assert.match(noSession.err[0] ?? "", /not signed in/);
  const help = await quietly(() => transcribe([], { fetcher, wavOf: wav, session }));
  assert.equal(help.result, 64);
  assert.match(help.out[0] ?? "", /nixamp transcribe FILE/);
  const unreadable = await quietly(() => transcribe(["clip.ogg", "--say", "https://box:4321"], { fetcher, wavOf: () => { throw new Error("no ffmpeg here"); }, session }));
  assert.equal(unreadable.result, 1);
  assert.match(unreadable.err[0] ?? "", /no ffmpeg here/);
  const missing = await quietly(() => transcribe(["nowhere.mkv"], { fetcher, session }));
  assert.equal(missing.result, 1);
  assert.match(missing.err[0] ?? "", /cannot read nowhere.mkv/);
  const badLanguage = await quietly(() => transcribe(["clip.wav", "--language", "german"], { fetcher, session }));
  assert.equal(badLanguage.result, 64);
});

/**
 * nixamp.com as the whole-file path sees it: an ear that answers with the
 * pieces' timing, a store that keeps what it is sent, and a translator
 * that finishes on the second look.
 */
function site() {
  const media = "file:v1:" + "ef".repeat(32);
  const id = transcriptIdOf(media);
  const heard: { language: string | null; bytes: number }[] = [];
  const kept: Record<string, unknown>[] = [];
  const fetched: string[] = [];
  let translatePolls = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/speech/transcribe") {
      const body = init?.body as Blob;
      heard.push({ language: url.searchParams.get("language"), bytes: body.size });
      assert.equal(url.searchParams.get("timestamps"), "1");
      const n = heard.length;
      return json(200, {
        text: `window ${n} first. window ${n} second.`, seconds: 60, language: "en", model: "whisper-test",
        segments: [{ start: 0, end: 3.5, text: `window ${n} first.` }, { start: 3.5, end: 8, text: `window ${n} second.` }],
      });
    }
    if (url.pathname === `/api/v1/transcripts/${id}/lines`) {
      const body = JSON.parse(String(init?.body)) as { language: string; complete?: boolean; lines: unknown[]; media: string; title?: string };
      kept.push(body);
      const had = rows.get(body.language);
      rows.set(body.language, {
        id, media, kind: "file", language: body.language, translatedFrom: null, model: "whisper-test", complete: body.complete === true, title: body.title ?? "",
        seconds: 0, updatedAt: "", languages: [],
        lines: body.complete ? body.lines : [...((had?.["lines"] as unknown[] | undefined) ?? []), ...body.lines],
      });
      return json(200, { saved: body.lines.length, seconds: 0, complete: body.complete === true });
    }
    if (url.pathname === `/api/v1/transcripts/${id}`) {
      const language = url.searchParams.get("language") ?? "";
      fetched.push(language);
      if (language === "") {
        const row = rows.get("en");
        return row ? json(200, row) : json(404, { error: "nothing has been written down for that" });
      }
      if (language === "sv") {
        translatePolls += 1;
        const original = rows.get("en") as { lines: { start: number; end: number; text: string }[] };
        const lines = original.lines.map((line) => ({ ...line, text: `sv:${line.text}` }));
        if (translatePolls === 1) return json(202, { id, language: "sv", lines: [], languages: [], translating: { done: 0, total: lines.length } });
        return json(200, { id, media, kind: "file", language: "sv", translatedFrom: "en", model: "opus", complete: true, title: "film", seconds: 0, updatedAt: "", lines, languages: [] });
      }
      return json(409, { error: `there is no model here from en to ${language}` });
    }
    return json(404, { error: `no route ${url.pathname}` });
  }) as typeof fetch;
  /** Three windows: a minute, a minute, and a tail; the middle one silent. */
  async function* windows(): AsyncGenerator<Window> {
    const loud = Buffer.alloc(60 * RATE * 2);
    for (let i = 0; i < loud.length / 2; i++) loud.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
    yield { offset: 0, pcm: loud };
    yield { offset: 60, pcm: Buffer.alloc(60 * RATE * 2) };
    yield { offset: 120, pcm: loud.subarray(0, 10 * RATE * 2) };
  }
  return { media, id, heard, kept, fetched, rows, fetcher, windows, fingerprint: () => media, sleep: async () => undefined };
}

test("a whole file is heard a minute at a time with the pieces' timing, silence skipped, kept as it goes and then whole, and printed with seconds", async () => {
  const s = site();
  const run = await quietly(() => transcribe(["film.mkv"], { fetcher: s.fetcher, session, windows: s.windows, fingerprint: s.fingerprint, sleep: s.sleep }));
  assert.equal(run.result, 0, run.err.join("\n"));
  // The store was asked first, and had nothing.
  assert.equal(s.fetched[0], "");
  // Two loud windows heard; the second ask knew the language from the first.
  assert.deepEqual(s.heard.map((one) => one.language), [null, "en"]);
  assert.equal(s.heard[0]?.bytes, 44 + 60 * RATE * 2);
  // Kept whole at the end, under the file's fingerprint, with the pieces at their seconds into the film.
  const whole = s.kept.find((batch) => batch["complete"] === true);
  assert.ok(whole);
  assert.equal(whole["media"], s.media);
  assert.equal(whole["language"], "en");
  assert.equal(whole["title"], "film");
  assert.deepEqual(whole["lines"], [
    { start: 0, end: 3.5, text: "window 1 first." },
    { start: 3.5, end: 8, text: "window 1 second." },
    { start: 120, end: 123.5, text: "window 2 first." },
    { start: 123.5, end: 128, text: "window 2 second." },
  ]);
  assert.deepEqual(run.out, ["   0:00  window 1 first.\n   0:03  window 1 second.\n   2:00  window 2 first.\n   2:03  window 2 second."]);
  assert.match(run.err.join("\n"), /Kept on nixamp.com/);

  // Kept means the next ask reads it: no hearing at all.
  const again = await quietly(() => transcribe(["film.mkv", "--srt"], { fetcher: s.fetcher, session, windows: s.windows, fingerprint: s.fingerprint, sleep: s.sleep }));
  assert.equal(again.result, 0);
  assert.equal(s.heard.length, 2);
  assert.match(again.err[0] ?? "", /Already written down \(4 lines, en\)/);
  assert.match(again.out[0] ?? "", /^1\n00:00:00,000 --> 00:00:03,500\nwindow 1 first\.\n/);

  // --fresh hears it again; --translate waits for nixamp.com and prints both; --out writes a file per language.
  const fresh = await quietly(() => transcribe(["film.mkv", "--fresh", "--translate", "sv", "--vtt"], { fetcher: s.fetcher, session, windows: s.windows, fingerprint: s.fingerprint, sleep: s.sleep }));
  assert.equal(fresh.result, 0, fresh.err.join("\n"));
  assert.equal(s.heard.length, 4);
  assert.match(fresh.err.join("\n"), /translating to sv: 0 of 4 lines/);
  assert.equal(fresh.out.length, 2);
  // Heard again, so the fake ear's third and fourth windows are what is kept now.
  assert.match(fresh.out[0] ?? "", /^WEBVTT\n\n00:00:00\.000 --> 00:00:03\.500\nwindow 3 first\./);
  assert.match(fresh.out[1] ?? "", /sv:window 3 first\./);
  const dir = mkdtempSync(join(tmpdir(), "nixamp-subs-"));
  const files = await quietly(() => transcribe(["film.mkv", "--translate", "sv", "--out", dir], { fetcher: s.fetcher, session, windows: s.windows, fingerprint: s.fingerprint, sleep: s.sleep, polls: 3 }));
  assert.equal(files.result, 0, files.err.join("\n"));
  assert.deepEqual(files.out, [join(dir, "film.en.txt"), join(dir, "film.sv.txt")]);
  assert.equal(readFileSync(join(dir, "film.sv.txt"), "utf8"), "sv:window 3 first.\nsv:window 3 second.\nsv:window 4 first.\nsv:window 4 second.");
  const nowhere = await quietly(() => transcribe(["film.mkv", "--translate", "xx"], { fetcher: s.fetcher, session, windows: s.windows, fingerprint: s.fingerprint, sleep: s.sleep }));
  assert.equal(nowhere.result, 1);
  assert.match(nowhere.err.join("\n"), /no model here from en to xx/);
});

test("the MCP room tools: transcribe a recording, say a line, read the room", async () => {
  for (const name of ["transcribe_audio", "trollbox_say", "trollbox_read"]) assert.ok(TOOLS.some((tool) => tool.name === name), name);

  const heard = recorder({ text: "hello room", seconds: 1, message: { id: "l1", handle: "chovy", body: "hello room", createdAt: "now" } }, 201);
  const spoken = await callTool("transcribe_audio", { path: "/tmp/clip.m4a", server: "https://box:4321" }, { fetcher: heard.fetcher, session, wavOf: () => clip });
  assert.equal(spoken.isError, undefined);
  assert.match(spoken.content[0]?.text ?? "", /hello room[\s\S]*Said in the room for live at https:\/\/box:4321 as chovy/);
  assert.equal(new URL(heard.calls[0]?.url ?? "").searchParams.get("channel"), "live");

  const unreadable = await callTool("transcribe_audio", { path: "/tmp/clip.m4a" }, { fetcher: heard.fetcher, session, wavOf: () => { throw new Error("cannot read /tmp/clip.m4a"); } });
  assert.equal(unreadable.isError, true);
  const noPath = await callTool("transcribe_audio", {}, { fetcher: heard.fetcher, session, wavOf: () => clip });
  assert.equal(noPath.isError, true);

  const posted = recorder({ message: { id: "l2", handle: "chovy", body: "typed line", createdAt: "now" } }, 201);
  const say = await callTool("trollbox_say", { server: "https://box:4321", channel: "cat-1", text: "typed line" }, { fetcher: posted.fetcher, session });
  assert.equal(say.isError, undefined);
  assert.match(say.content[0]?.text ?? "", /Said, as chovy: typed line/);
  assert.equal(posted.calls[0]?.method, "POST");
  assert.deepEqual(posted.calls[0]?.json, { server: "https://box:4321", channel: "cat-1", body: "typed line" });
  assert.equal(posted.calls[0]?.headers["authorization"], `Bearer ${session.token}`);
  const nothing = await callTool("trollbox_say", { server: "https://box:4321", text: "  " }, { fetcher: posted.fetcher, session });
  assert.equal(nothing.isError, true);

  const lines = recorder({ messages: [{ id: "l1", handle: "chovy", body: "hi", createdAt: "2026-09-13T01:00:00.000Z" }] });
  const read = await callTool("trollbox_read", { server: "https://box:4321", after: "2026-09-13T00:00:00.000Z" }, { fetcher: lines.fetcher, session });
  assert.equal(read.content[0]?.text, "2026-09-13T01:00:00.000Z  chovy: hi");
  const asked = new URL(lines.calls[0]?.url ?? "");
  assert.equal(asked.pathname, "/api/v1/trollbox");
  assert.equal(asked.searchParams.get("channel"), "live");
  assert.equal(asked.searchParams.get("after"), "2026-09-13T00:00:00.000Z");
  const empty = recorder({ messages: [] });
  const quiet = await callTool("trollbox_read", { server: "https://box:4321" }, { fetcher: empty.fetcher, session });
  assert.match(quiet.content[0]?.text ?? "", /Nobody has said anything/);
  const noRoom = await callTool("trollbox_read", {}, { fetcher: empty.fetcher, session });
  assert.equal(noRoom.isError, true);
});

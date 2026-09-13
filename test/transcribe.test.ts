import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askToHear, transcribe, wavOf } from "../src/transcribe.ts";
import { encodeWav } from "../src/speech.ts";
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

  const plain = recorder({ text: "just words", seconds: 2 });
  const heard = await quietly(() => transcribe(["clip.wav", "--language", "de"], { fetcher: plain.fetcher, wavOf: wav, session }));
  assert.equal(heard.result, 0);
  assert.deepEqual(heard.out, ["just words"]);
  assert.equal(new URL(plain.calls[0]?.url ?? "").searchParams.get("language"), "de");
  assert.equal(new URL(plain.calls[0]?.url ?? "").searchParams.has("server"), false);

  const asJson = await quietly(() => transcribe(["clip.wav", "--json"], { fetcher: plain.fetcher, wavOf: wav, session }));
  assert.deepEqual(JSON.parse(asJson.out.join("\n")), { text: "just words", seconds: 2 });

  const noFile = await quietly(() => transcribe(["--say", "https://box:4321"], { fetcher, wavOf: wav, session }));
  assert.equal(noFile.result, 64);
  const noSession = await quietly(() => transcribe(["clip.wav"], { fetcher, wavOf: wav, session: null }));
  assert.equal(noSession.result, 1);
  assert.match(noSession.err[0] ?? "", /not signed in/);
  const help = await quietly(() => transcribe([], { fetcher, wavOf: wav, session }));
  assert.equal(help.result, 64);
  assert.match(help.out[0] ?? "", /nixamp transcribe FILE/);
  const unreadable = await quietly(() => transcribe(["clip.ogg"], { fetcher, wavOf: () => { throw new Error("no ffmpeg here"); }, session }));
  assert.equal(unreadable.result, 1);
  assert.match(unreadable.err[0] ?? "", /no ffmpeg here/);
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

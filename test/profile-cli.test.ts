import { test } from "node:test";
import assert from "node:assert/strict";
import { personaLines, profile, voices } from "../src/profile.ts";
import { callTool } from "../src/mcp.ts";

const session = { site: "https://nixamp.test", token: "nxa_x" };
const me = { handle: "chovy", voice: "male", profile: "", chosen: true, spoken: "ElevenLabs.pNInz6obpgDQGcFmaJgB" };

function recorder(answer: unknown, status = 200) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
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

test("a persona reads as three plain lines", () => {
  const lines = personaLines(me);
  assert.equal(lines[0], "You are chovy in every room.");
  assert.match(lines[1] ?? "", /a man's voice \(ElevenLabs\.pNInz6obpgDQGcFmaJgB\)/);
  assert.match(lines[2] ?? "", /No OpenProfile/);
  assert.match(personaLines({ handle: "nixamp-1a2b3c4d", voice: "", profile: "https://x.example/p.md", chosen: false })[0] ?? "", /until you pick a handle/);
  assert.match(personaLines({ handle: "x", voice: "", profile: "https://x.example/p.md", chosen: true })[1] ?? "", /OpenProfile says/);
});

test("`nixamp profile` reads, and with flags writes only what was given", async () => {
  const read = recorder(me);
  const shown = await quietly(() => profile([], { fetcher: read.fetcher, session }));
  assert.equal(shown.result, 0);
  assert.equal(read.calls[0]?.method, "GET");
  assert.equal(new URL(read.calls[0]?.url ?? "").pathname, "/api/v1/me/handle");
  assert.match(shown.out[0] ?? "", /You are chovy/);

  const write = recorder({ ...me, voice: "female" });
  const set = await quietly(() => profile(["--voice", "female"], { fetcher: write.fetcher, session }));
  assert.equal(set.result, 0);
  assert.equal(write.calls[0]?.method, "PUT");
  assert.deepEqual(write.calls[0]?.body, { voice: "female" });
  assert.match(set.out[1] ?? "", /a woman's voice/);

  const bare = await quietly(() => profile(["--handle"], { fetcher: write.fetcher, session }));
  assert.equal(bare.result, 64);
  const refused = recorder({ error: "somebody already has that one" }, 409);
  const taken = await quietly(() => profile(["--handle", "chovy"], { fetcher: refused.fetcher, session }));
  assert.equal(taken.result, 1);
  assert.match(taken.err[0] ?? "", /already has/);
  const nobody = await quietly(() => profile([], { fetcher: read.fetcher, session: null }));
  assert.equal(nobody.result, 1);
  const asJson = await quietly(() => profile(["--json"], { fetcher: read.fetcher, session }));
  assert.equal(JSON.parse(asJson.out.join("\n")).handle, "chovy");
});

test("`nixamp voices` lists the pools by sex", async () => {
  const { calls, fetcher } = recorder({ provider: "elevenlabs", female: ["ElevenLabs.a"], male: ["ElevenLabs.b", "ElevenLabs.c"] });
  const listed = await quietly(() => voices([], { fetcher, session }));
  assert.equal(listed.result, 0);
  assert.equal(new URL(calls[0]?.url ?? "").pathname, "/api/v1/voices");
  assert.match(listed.out[0] ?? "", /Voices: elevenlabs/);
  assert.ok(listed.out.some((line) => line.trim() === "ElevenLabs.c"));
});

test("the MCP profile and voices tools front the same routes", async () => {
  const read = recorder(me);
  const got = await callTool("profile_get", {}, { fetcher: read.fetcher, session });
  assert.equal(got.isError, undefined);
  assert.match(got.content[0]?.text ?? "", /You are chovy/);
  const write = recorder({ ...me, profile: "https://ada.example/.well-known/openprofile.md" });
  const set = await callTool("profile_set", { profile: "https://ada.example/.well-known/openprofile.md" }, { fetcher: write.fetcher, session });
  assert.equal(set.isError, undefined);
  assert.deepEqual(write.calls[0]?.body, { profile: "https://ada.example/.well-known/openprofile.md" });
  assert.match(set.content[0]?.text ?? "", /OpenProfile: https:\/\/ada\.example/);
  const nothing = await callTool("profile_set", {}, { fetcher: write.fetcher, session });
  assert.equal(nothing.isError, true);
  const pools = recorder({ provider: "kokoro", female: ["Telnyx.KokoroTTS.af_heart"], male: ["Telnyx.KokoroTTS.am_adam"] });
  const list = await callTool("voices_list", {}, { fetcher: pools.fetcher, session });
  assert.match(list.content[0]?.text ?? "", /Voices: kokoro[\s\S]*af_heart[\s\S]*am_adam/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { LiveVoice } from "../src/live-voice.ts";
import { SpeechError } from "../src/speech.ts";
import { EmptyEngine, createServer } from "../src/server.ts";
import type { Accounts } from "../src/accounts.ts";
import type { Queryable } from "../src/follows.ts";

const catalog = { voices: [
  { voice_id: "male", name: "Lower voice", labels: { gender: "male", language: "en" } },
  { voice_id: "female", name: "Higher voice", labels: { gender: "female", language: "en" } },
  { voice_id: "neutral", name: "Neutral voice", labels: { gender: "neutral" } },
] };

function provider() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  return { requests, fetcher: (async (input, init) => {
    const url = String(input);
    if (url.includes("/voices?")) return Response.json(catalog);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(new Uint8Array([0, 0, 10, 0, 20, 0]), { headers: { "content-type": "audio/pcm" } });
  }) as typeof fetch };
}

test("voices stream once per text/language/voice, with automatic acoustic matching and a user budget", async () => {
  const remote = provider();
  const voice = new LiveVoice({ apiKey: "test-key", fetcher: remote.fetcher, charsPerMinute: 20 });
  const ask = { text: "Hello", language: "en", profile: "lower" as const };
  const a = await voice.stream(ask, "alice");
  const b = await voice.stream(ask, "bob");
  assert.deepEqual(await a.arrayBuffer(), await b.arrayBuffer());
  assert.equal(remote.requests.length, 1);
  assert.match(remote.requests[0]!.url, /\/male\/stream\?output_format=pcm_16000$/);
  assert.equal(remote.requests[0]!.body.model_id, "eleven_flash_v2_5");
  await (await voice.stream({ ...ask, profile: "higher" }, "alice")).arrayBuffer();
  assert.match(remote.requests[1]!.url, /\/female\/stream/);
  await assert.rejects(voice.stream({ text: "This exceeds the remaining budget", language: "en" }, "alice"), (error: unknown) => error instanceof SpeechError && error.status === 429);
  assert.equal(remote.requests.length, 2);
  await assert.rejects(voice.stream({ ...ask, voice: "not-in-catalog" }, "alice"), /available voice/);
});

test("voice grants expire, are channel-scoped, and cannot authorize unlimited characters", async () => {
  let now = 1000;
  const voice = new LiveVoice({ apiKey: "key", now: () => now });
  const grant = await voice.grant("alice", "ufc");
  await assert.rejects(voice.authorize("account-session", "ufc", 10), /sign in/);
  await assert.rejects(voice.authorize(grant.token, "another-channel", 10), /sign in/);
  for (let i = 0; i < 4; i++) assert.equal(await voice.authorize(grant.token, "ufc", 500), "alice");
  await assert.rejects(voice.authorize(grant.token, "ufc", 1), /character limit/);
  now += 91_000;
  await assert.rejects(voice.authorize(grant.token, "ufc", 1), /sign in/);
});

test("the persisted budget is shared by service instances and a database failure never reaches the provider", async () => {
  const buckets = new Map<string, number>();
  const db: Queryable = { query: async (sql, values = []) => {
    if (!sql.includes("INSERT INTO live_voice_usage")) return { rows: [] };
    assert.match(sql, /WHERE live_voice_usage.chars \+ EXCLUDED.chars <= \$3/);
    const [key, chars, limit] = values as [string, number, number];
    const used = (buckets.get(key) ?? 0) + chars;
    if (used > limit) return { rows: [] };
    buckets.set(key, used); return { rows: [{ chars: used }] };
  } };
  const remote = provider();
  const first = new LiveVoice({ apiKey: "test", fetcher: remote.fetcher, db, charsPerMinute: 10 });
  const restarted = new LiveVoice({ apiKey: "test", fetcher: remote.fetcher, db, charsPerMinute: 10 });
  await (await first.stream({ text: "12345678", language: "en" }, "alice")).arrayBuffer();
  await assert.rejects(restarted.stream({ text: "12345", language: "en" }, "alice"), /budget/);
  assert.equal(remote.requests.length, 1);
  const failed = new LiveVoice({ apiKey: "test", fetcher: remote.fetcher, db: { query: async () => { throw new Error("database down"); } } });
  await assert.rejects(failed.stream({ text: "Hello", language: "en" }, "bob"), /database down/);
  assert.equal(remote.requests.length, 1);
});

test("server requires account auth to issue grants and a scoped grant to synthesize, including cache hits", async () => {
  const remote = provider();
  const voice = new LiveVoice({ apiKey: "test", fetcher: remote.fetcher });
  const server = createServer(new EmptyEngine(), {
    web: null, media: false, version: "test", liveVoice: voice,
    accounts: { whoIs: async (token: string) => token === "account" ? { id: "alice" } : null } as unknown as Accounts,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token = "") => fetch(`${base}/api/v1/speech/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post("grant", { channel: "ufc" })).status, 401);
    const ask = { text: "Hello", language: "en", channel: "ufc" };
    assert.equal((await post("synthesize", ask, "account")).status, 401);
    assert.equal(remote.requests.length, 0);
    const response = await post("grant", { channel: "ufc" }, "account");
    assert.equal(response.status, 200);
    const grant = await response.json() as { token: string };
    assert.equal((await post("synthesize", { ...ask, channel: "other" }, grant.token)).status, 401);
    const audio = await post("synthesize", ask, grant.token);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/pcm");
    assert.equal((await audio.arrayBuffer()).byteLength, 6);
    assert.equal((await post("synthesize", ask)).status, 401);
    assert.equal(remote.requests.length, 1);
    for (let i = 0; i < 9; i++) assert.equal((await post("grant", { channel: "ufc" }, "account")).status, 200);
    const limited = await post("grant", { channel: "ufc" }, "account");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

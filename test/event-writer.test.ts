import { test } from "node:test";
import assert from "node:assert/strict";
import { EventWriter, EventWriterError } from "../src/event-writer.ts";
import { createServer, EmptyEngine } from "../src/server.ts";
import type { Accounts } from "../src/accounts.ts";
import type { LiveEvents } from "../src/live-events.ts";

const input = {title: "Pair programming", description: "Learn with my agent fleet", topic: "Coding"};
const draft = {title: "Pair Programming with an Agent Fleet", description: "Learn how to manage software projects with a fleet of agents.", topic: "Software development"};
const openai = () => Response.json({status: "completed", output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(draft)}]}]});
const claude = () => Response.json({stop_reason: "end_turn", content: [{type: "text", text: JSON.stringify(draft)}]});
const errorStatus = (status: number) => (error: unknown) => error instanceof EventWriterError && error.status === status;

test("event writer uses OpenAI first, sends only form context, and requests a private structured draft", async () => {
  const writer = new EventWriter({openaiKey: "openai-key", anthropicKey: "claude-key", fetch: async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    const sent = JSON.parse(body.input[0].content);
    assert.equal(sent.description, input.description);
    assert.equal(sent.timezone, "America/Los_Angeles");
    assert.equal(sent.secret, undefined);
    assert.equal(sent.broadcastUrl, undefined);
    return openai();
  }});
  assert.deepEqual(await writer.draft("host", {...input, timezone: "America/Los_Angeles", secret: "private", broadcastUrl: "https://private.example"}), {provider: "openai", draft});
});

for (const failure of ["http", "network", "invalid", "truncated", "timeout"] as const) {
  test(`event writer falls back to Claude on ${failure} failure`, async () => {
    let count = 0;
    const writer = new EventWriter({openaiKey: "a", anthropicKey: "b", timeoutMs: 10, fetch: async (url, init) => {
      count++;
      if (count === 1) {
        if (failure === "http") return new Response("internal secret", {status: 429});
        if (failure === "network") throw new Error("network secret");
        if (failure === "timeout") return await new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {once: true});
        });
        return Response.json({status: failure === "truncated" ? "incomplete" : "completed", output: [{type: "message", content: [{type: "output_text", text: failure === "invalid" ? "not json" : JSON.stringify(draft)}]}]});
      }
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "b");
      assert.equal(JSON.parse(String(init?.body)).output_config.format.type, "json_schema");
      return claude();
    }});
    assert.deepEqual(await writer.draft("host", input), {provider: "claude", draft});
    assert.equal(count, 2);
  });
}

test("refusal is returned without asking a fallback provider to bypass it", async () => {
  let calls = 0;
  const writer = new EventWriter({openaiKey: "a", anthropicKey: "b", fetch: async () => {
    calls++;
    return Response.json({status: "completed", output: [{type: "message", content: [{type: "refusal", refusal: "No"}]}]});
  }});
  await assert.rejects(writer.draft("host", input), errorStatus(422));
  assert.equal(calls, 1);
});

test("invalid inputs cannot invoke a provider and provider errors do not leak", async () => {
  let calls = 0;
  const writer = new EventWriter({openaiKey: "a", fetch: async () => { calls++; return new Response("sk-secret sensitive details", {status: 500}); }});
  for (const value of [{}, {title: "x".repeat(161)}, {title: 12}, []]) await assert.rejects(writer.draft("host", value));
  await assert.rejects(writer.draft("", input), errorStatus(401));
  assert.equal(calls, 0);
  await assert.rejects(writer.draft("host", input), error => errorStatus(503)(error) && !String(error).includes("sk-secret"));
});

test("draft requests are bounded per account and missing providers fail clearly", async () => {
  await assert.rejects(new EventWriter({}).draft("host", input), errorStatus(503));
  const writer = new EventWriter({openaiKey: "a", fetch: async () => openai()});
  for (let n = 0; n < 6; n++) await writer.draft("host", input);
  await assert.rejects(writer.draft("host", input), error => errorStatus(429)(error) && (error as EventWriterError).retryAfter! > 0);
  assert.equal((await writer.draft("other-host", input)).provider, "openai");
});

test("cancellation stops fallback and releases account concurrency", async () => {
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const writer = new EventWriter({openaiKey: "a", anthropicKey: "b", fetch: async (_, init) => {
    calls++;
    if (calls > 1) return openai();
    started();
    return await new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {once: true}));
  }});
  const controller = new AbortController();
  const pending = writer.draft("host", input, controller.signal);
  await ready;
  await assert.rejects(writer.draft("host", input), errorStatus(429));
  controller.abort();
  await assert.rejects(pending, errorStatus(499));
  assert.equal(calls, 1);
  await writer.draft("host", input);
  assert.equal(calls, 2);
});

test("HTTP writer requires sign-in, validates input, and cannot mutate events", async () => {
  let calls = 0;
  const writer = new EventWriter({openaiKey: "a", fetch: async () => { calls++; return openai(); }});
  const server = createServer(new EmptyEngine(), {
    web: null, media: false, version: "test", load: async () => [],
    accounts: {whoIs: async (token: string) => token === "host" ? {id: "host", email: "test@example.com"} : null} as Accounts,
    events: new Proxy({}, {get: () => { throw new Error("Writer must never access the event store"); }}) as LiveEvents,
    eventWriter: writer,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v1/events/ai-draft`;
  const post = (value: unknown, token = "host") => fetch(url, {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: JSON.stringify(value)});
  try {
    assert.equal((await post(input, "anonymous")).status, 401);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await post({})).status, 422);
    assert.equal((await post({description: "a".repeat(13000)})).status, 413);
    assert.equal(calls, 0);
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {draft, provider: "openai"});
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { printed, readTranscript, transcript } from "../src/transcript.ts";
import { callTool } from "../src/mcp.ts";

const line = (at: number, text: string) => ({ channel: "tv", at, until: at + 5000, text });

/** A fetch that records the asks and answers in turn. */
function recorder(answers: { status?: number; body: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
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

test("a transcript is asked for with the share key, after a moment when given, and refusals keep their sentence", async () => {
  const { calls, fetcher } = recorder([{ body: { channel: "tv", backlog: 6, now: 10, on: true, lines: [line(1000, "hi")] } }]);
  const got = await readTranscript({ url: "https://box:4321/", key: "K" }, "tv", 500, fetcher);
  assert.ok(got.ok);
  assert.equal(got.answer.recent[0]?.text, "hi");
  assert.equal(got.answer.lines, 1);
  assert.equal(got.answer.on, true);
  const asked = new URL(calls[0]?.url ?? "");
  assert.equal(asked.pathname, "/api/channels/tv/transcript");
  assert.equal(asked.searchParams.get("after"), "500");
  assert.equal(calls[0]?.headers["x-nixamp-key"], "K");
  const refused = recorder([{ status: 503, body: { error: "this server cannot caption: it has no ffmpeg" } }]);
  const no = await readTranscript({ url: "https://box:4321", key: null }, "tv", 0, refused.fetcher);
  assert.ok(!no.ok);
  assert.equal(no.status, 503);
  assert.match(no.error, /no ffmpeg/);
  assert.equal(refused.calls[0]?.headers["x-nixamp-key"], undefined);
  assert.match(printed(line(1_700_000_000_000, "words")), /\d.*  words$/);
  assert.equal(printed(line(Number.NaN, "x")), "--:--:--  x");
});

test("`nixamp transcript` prints the lines, and --follow keeps asking after the last one it printed", async () => {
  const { calls, fetcher } = recorder([
    { body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [line(1000, "one"), line(6000, "two")] } },
    { body: { channel: "tv", backlog: 6, now: 2, on: true, lines: [] } },
    { body: { channel: "tv", backlog: 6, now: 3, on: true, lines: [line(11_000, "three")] } },
  ]);
  const once = await quietly(() => transcript(["--url", "https://box:4321", "--key", "K", "--channel", "tv"], { fetcher }));
  assert.equal(once.result, 0);
  assert.equal(once.out.length, 2);
  assert.match(once.out[1] ?? "", /two$/);

  const live = recorder([
    { body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [line(1000, "one"), line(6000, "two")] } },
    { body: { channel: "tv", backlog: 6, now: 2, on: true, lines: [] } },
    { body: { channel: "tv", backlog: 6, now: 3, on: true, lines: [line(11_000, "three")] } },
  ]);
  const followed = await quietly(() => transcript(["--url", "https://box:4321", "--key", "K", "--channel", "tv", "--follow"], {
    fetcher: live.fetcher, polls: 3, sleep: async () => undefined,
  }));
  assert.equal(followed.result, 0);
  assert.deepEqual(followed.out.map((one) => one.slice(-5).trim()), ["one", "two", "three"]);
  // The second and third asks carry the last line's time, so nothing is printed twice.
  assert.equal(new URL(live.calls[0]?.url ?? "").searchParams.has("after"), false);
  assert.equal(new URL(live.calls[1]?.url ?? "").searchParams.get("after"), "6000");
  assert.equal(new URL(live.calls[2]?.url ?? "").searchParams.get("after"), "6000");

  const nothing = recorder([{ body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [], error: "" } }]);
  const empty = await quietly(() => transcript(["--url", "https://box:4321", "--channel", "tv"], { fetcher: nothing.fetcher }));
  assert.equal(empty.result, 0);
  assert.match(empty.out[0] ?? "", /Nothing said yet/);
  const why = recorder([{ body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [], error: "this server is not signed in" } }]);
  const stuck = await quietly(() => transcript(["--url", "https://box:4321", "--channel", "tv"], { fetcher: why.fetcher }));
  assert.match(stuck.out[0] ?? "", /Nothing yet: this server is not signed in/);
  const two = recorder([{ body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [line(1000, "one"), line(6000, "two")] } }]);
  const asJson = await quietly(() => transcript(["--url", "https://box:4321", "--channel", "tv", "--json"], { fetcher: two.fetcher }));
  assert.equal(JSON.parse(asJson.out.join("\n")).length, 2);
  const help = await quietly(() => transcript(["--help"]));
  assert.equal(help.result, 0);
  assert.match(help.out[0] ?? "", /nixamp transcript/);
});

test("the MCP transcript_read tool reads a channel's lines by the server's address and key", async () => {
  const session = { site: "https://nixamp.test", token: "nxa_x" };
  const { calls, fetcher } = recorder([{ body: { channel: "tv", backlog: 6, now: 1, on: true, lines: [line(1_700_000_000_000, "hello there")] } }]);
  const read = await callTool("transcript_read", { url: "https://box:4321", key: "K", channel: "tv", after: 5 }, { fetcher, session });
  assert.equal(read.isError, undefined);
  assert.match(read.content[0]?.text ?? "", /^2023-11-14T22:13:20\.000Z  hello there$/);
  const asked = new URL(calls[0]?.url ?? "");
  assert.equal(asked.pathname, "/api/channels/tv/transcript");
  assert.equal(asked.searchParams.get("after"), "5");
  assert.equal(calls[0]?.headers["x-nixamp-key"], "K");
  const none = await callTool("transcript_read", {}, { fetcher, session });
  assert.equal(none.isError, true);
  const quiet = recorder([{ body: { channel: "main", lines: [] } }]);
  const empty = await callTool("transcript_read", { url: "https://box:4321" }, { fetcher: quiet.fetcher, session });
  assert.match(empty.content[0]?.text ?? "", /Nothing said yet/);
  assert.equal(new URL(quiet.calls[0]?.url ?? "").pathname, "/api/channels/main/transcript");
});

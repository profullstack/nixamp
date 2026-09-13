import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRecord, hash } from "../src/hash.ts";
import { describeFile, keepFile, refreshChanged, type Described } from "../src/media-local.ts";
import { readIndex } from "../src/media-index.ts";
import { callTool } from "../src/mcp.ts";

const session = { site: "https://nixamp.test", token: "nxa_x" };
const ID = "ab".repeat(32);

function recorder() {
  const calls: { url: string; method: string; body?: unknown; auth?: string }[] = [];
  const records = new Map<string, Record<string, unknown>>();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.toString(), method, body, auth: headers["authorization"] });
    const m = /^\/api\/v1\/media\/(.+)$/.exec(url.pathname);
    if (m && method === "PUT") {
      const id = m[1] as string;
      const had = records.get(id) ?? { id: `sha256:${id}`, url: `https://nixamp.test/hash/${id}`, holders: [], nixamp: {} };
      const kept = { ...had, ...(body.name ? { name: body.name } : {}), ...(body.size ? { size: body.size } : {}), nixamp: { ...(had["nixamp"] as object), ...(body.facts ?? {}) } };
      records.set(id, kept);
      return new Response(JSON.stringify(kept), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (m && method === "GET") {
      const record = records.get(m[1] as string);
      return new Response(JSON.stringify(record ?? { error: "nixamp.com does not know that file yet" }), { status: record ? 200 : 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
  }) as typeof fetch;
  return { calls, records, fetcher };
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

const described = (path: string, id = ID): Described => ({
  id, fingerprint: "file:v1:" + "cd".repeat(32), size: 10, mtimeMs: 1_700_000_000_000,
  keep: { name: path.split("/").pop() ?? path, size: 10, contentType: "video/mp4", updated: "2026-09-01T00:00:00.000Z", facts: { duration: 12, fingerprint: "file:v1:" + "cd".repeat(32) } },
});

test("`nixamp hash` prints the address, keeps the record with what is known, and can stay quiet or fetch one", async () => {
  const world = recorder();
  const dir = mkdtempSync(join(tmpdir(), "nixamp-hash-"));
  const index = join(dir, "media.json");
  const deps = { fetcher: world.fetcher, session, describe: async (path: string) => described(path), index, now: () => 1_700_000_100_000 };
  const kept = await quietly(() => hash(["/films/a.mp4"], deps));
  assert.equal(kept.result, 0, kept.err.join("\n"));
  assert.deepEqual(kept.out, [`sha256:${ID}  a.mp4\n  https://nixamp.test/hash/${ID}`]);
  const put = world.calls.find((call) => call.method === "PUT");
  assert.ok(put);
  assert.equal(put.url, `https://nixamp.test/api/v1/media/${ID}`);
  assert.equal(put.auth, "Bearer nxa_x");
  assert.equal((put.body as { name: string }).name, "a.mp4");
  assert.equal(((put.body as { facts: { duration: number } }).facts).duration, 12);
  // Remembered locally, with when to look again: changed a hundred seconds ago, so the quarter-hour floor.
  const indexed = readIndex(index).files["/films/a.mp4"];
  assert.equal(indexed?.id, ID);
  assert.equal(indexed?.checkAfter, 1_700_000_100_000 + 15 * 60 * 1000);

  const quiet = await quietly(() => hash(["/films/a.mp4", "--no-keep"], deps));
  assert.equal(quiet.result, 0);
  assert.match(quiet.out[0] ?? "", /\(not kept\)$/);
  assert.equal(world.calls.filter((call) => call.method === "PUT").length, 1);

  const asJson = await quietly(() => hash(["/films/a.mp4", "--json"], deps));
  assert.equal(asJson.result, 0);
  assert.equal(JSON.parse(asJson.out.join("\n")).id, `sha256:${ID}`);

  const got = await quietly(() => hash(["--get", `sha256:${ID}`], deps));
  assert.equal(got.result, 0);
  assert.match(got.out[0] ?? "", new RegExp(`a\\.mp4  sha256:${ID}`));
  const unknown = await quietly(() => hash(["--get", "ff".repeat(32)], deps));
  assert.equal(unknown.result, 1);

  const signedOut = await quietly(() => hash(["/films/a.mp4"], { ...deps, session: null }));
  assert.equal(signedOut.result, 0);
  assert.match(signedOut.err[0] ?? "", /not signed in/);
  assert.match(signedOut.out[0] ?? "", /nixamp\.com\/hash\//);
  const unreadable = await quietly(() => hash(["/nowhere.mp4"], { ...deps, describe: async () => { throw new Error("cannot read /nowhere.mp4"); } }));
  assert.equal(unreadable.result, 1);
  assert.equal((await quietly(() => hash([], deps))).result, 64);
  assert.equal((await quietly(() => hash(["--get"], deps))).result, 64);

  assert.match(describeRecord({ id: "sha256:x", name: "n", url: "u", size: 5, contentType: "t", nixamp: { duration: 61.4, enrichment: { title: "T", year: 2001 }, transcripts: [{ language: "en", translatedFrom: null, lines: 3, complete: true, url: "s" }] }, holders: [{ url: "h", channel: "c", seenAt: "w" }] }), /nichedb: T \(2001\)[\s\S]*carried by h as c at w[\s\S]*transcript en: 3 lines  s/);
});

test("the MCP tools hash a file and read a record", async () => {
  const world = recorder();
  const dir = mkdtempSync(join(tmpdir(), "nixamp-hash-mcp-"));
  process.env["NIXAMP_MEDIA_INDEX"] = join(dir, "media.json");
  try {
    const hashed = await callTool("media_hash", { path: "/films/b.mp4" }, { fetcher: world.fetcher, session, describe: async (path) => described(path, "ef".repeat(32)) });
    assert.equal(hashed.isError, undefined);
    assert.match(hashed.content[0]?.text ?? "", new RegExp(`sha256:${"ef".repeat(32)}\\nhttps://nixamp.test/hash/${"ef".repeat(32)}`));
    assert.equal(world.calls.filter((call) => call.method === "PUT").length, 1);
    const unkept = await callTool("media_hash", { path: "/films/b.mp4", keep: false }, { fetcher: world.fetcher, session, describe: async (path) => described(path) });
    assert.match(unkept.content[0]?.text ?? "", /\(not kept\)/);
    const read = await callTool("media_get", { id: "ef".repeat(32) }, { fetcher: world.fetcher, session });
    assert.match(read.content[0]?.text ?? "", /b\.mp4  sha256:efef/);
    const missing = await callTool("media_get", { id: "00".repeat(32) }, { fetcher: world.fetcher, session });
    assert.equal(missing.isError, true);
    assert.equal((await callTool("media_hash", {}, { fetcher: world.fetcher, session })).isError, true);
  } finally {
    delete process.env["NIXAMP_MEDIA_INDEX"];
  }
});

test("describing a file, keeping it, and refreshing one that changed: the new record says what it was, the old what it became", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-describe-"));
  const file = join(dir, "song.mp3");
  writeFileSync(file, "abc");
  const modified = 1_700_000_000_000;
  utimesSync(file, new Date(modified), new Date(modified));
  const now = modified + 24 * 60 * 60 * 1000;
  const enricher = { lookup: async (name: string) => (name === "song" ? { kind: "title" as const, title: "Song", year: 2020, image: null, summary: null, page: "p", score: 1, data: {}, tags: [] } : null) };
  const first = await describeFile(file, { tools: null, enricher, hash: async () => "11".repeat(32), fingerprint: () => "file:v1:" + "22".repeat(32), now: () => now, holder: { kind: "gateway", url: "https://s1", seenAt: "2026-09-13T09:00:00.000Z" } });
  assert.equal(first.id, "11".repeat(32));
  assert.equal(first.size, 3);
  assert.equal(first.keep.name, "song.mp3");
  assert.equal(first.keep.contentType, "audio/mpeg");
  assert.equal(first.keep.updated, new Date(modified).toISOString());
  const facts = first.keep.facts as Record<string, unknown>;
  assert.equal(facts["fingerprint"], "file:v1:" + "22".repeat(32));
  assert.equal((facts["enrichment"] as { title: string }).title, "Song");
  assert.equal(facts["checkAfter"], new Date(now + 6 * 60 * 60 * 1000).toISOString());
  assert.equal(first.keep.holder?.url, "https://s1");

  const world = recorder();
  const index = join(dir, "media.json");
  assert.equal(await keepFile(session, file, first, { fetcher: world.fetcher, index, now: () => now }), null);
  assert.equal(readIndex(index).files[file]?.id, "11".repeat(32));

  writeFileSync(file, "abcd");
  const fresh = await refreshChanged(session, file, { id: "11".repeat(32) }, {
    tools: null, enricher, hash: async () => "33".repeat(32), fingerprint: () => "file:v1:" + "44".repeat(32), now: () => now, fetcher: world.fetcher, index,
  });
  assert.deepEqual(fresh, { id: "33".repeat(32), fingerprint: "file:v1:" + "44".repeat(32) });
  const puts = world.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 3);
  assert.equal(((puts[1]?.body as { facts: { supersedes: string } }).facts).supersedes, `sha256:${"11".repeat(32)}`);
  assert.equal(puts[2]?.url, `https://nixamp.test/api/v1/media/${"11".repeat(32)}`);
  assert.equal(((puts[2]?.body as { facts: { supersededBy: string } }).facts).supersededBy, `sha256:${"33".repeat(32)}`);
  assert.equal(readIndex(index).files[file]?.id, "33".repeat(32));

  // Touched but the same bytes: kept again under the same id, no chain.
  const same = await refreshChanged(session, file, { id: "33".repeat(32) }, { tools: null, hash: async () => "33".repeat(32), fingerprint: () => "file:v1:" + "44".repeat(32), now: () => now, fetcher: world.fetcher, index });
  assert.equal(same?.id, "33".repeat(32));
  assert.equal(world.calls.filter((call) => call.method === "PUT").length, 4);
});

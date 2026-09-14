import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { UpgradeAllowances } from "../src/upgrade-allowance.ts";
import { TranslationPasses } from "../src/translation-passes.ts";
import { LiveVoice } from "../src/live-voice.ts";
import { encodeWav } from "../src/speech.ts";
import { createServer, EmptyEngine } from "../src/server.ts";
import type { Accounts } from "../src/accounts.ts";
import type { AddressInfo } from "node:net";

test("PostgreSQL: ten free panel sessions are atomic, shared across upgrades and reset at UTC midnight", { skip: !process.env["NIXAMP_TEST_DATABASE_URL"] }, async () => {
  const connectionString = process.env["NIXAMP_TEST_DATABASE_URL"]!;
  const admin = new pg.Pool({ connectionString }), schema = `free_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  let now = Date.parse("2026-09-14T12:00:00Z");
  const first = new UpgradeAllowances(db, () => now), second = new UpgradeAllowances(db, () => now);
  try {
    assert.equal((await first.access("alice")).remaining, 10);
    assert.equal((await first.access("alice")).remaining, 10, "polling does not claim free use");
    await second.ensure();
    const duplicate = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).begin("alice", "translation", "same-feed")));
    assert.ok(duplicate.every(Boolean));
    assert.equal((await first.access("alice")).remaining, 4, "tabs and replicas reuse the same active resource");
    const expiry = (await first.access("alice")).activeUntil;
    now += 60_000;
    await first.begin("alice", "translation", "same-feed");
    assert.ok(Date.parse((await first.access("alice")).activeUntil!) > Date.parse(expiry!), "active listening renews the lease without another free use");
    const raced = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).begin("alice", i % 2 ? "another-panel" : "translation", `resource-${i}`)));
    assert.equal(raced.filter(Boolean).length, 9, "all upgrades draw from the same ten-use pool");
    assert.equal((await first.access("alice")).remaining, 0);
    assert.equal(await first.begin("alice", "translation", "eleventh"), false);
    assert.equal(await first.begin("alice", "translation", "same-feed"), true, "an active tenth use is still accessible");
    assert.deepEqual(await first.active(["alice", "bob"], "translation", "same-feed"), ["alice"]);
    assert.deepEqual(await first.active(["alice"], "another-panel", "same-feed"), []);
    await assert.rejects(first.begin("", "translation", "resource"), /Sign in/);
    await assert.rejects(first.begin("bob", "translation", "bad/resource"), /Choose/);
    for (let minute = 0; minute < 120; minute++) {
      now += 60_000;
      assert.deepEqual(await first.active(["alice"], "translation", "same-feed", true), ["alice"]);
    }
    assert.equal((await first.access("alice")).remaining, 0, "hours of continuous listening still use one session");
    now += 90_001;
    assert.deepEqual(await first.active(["alice"], "translation", "same-feed"), []);
    assert.equal((await first.access("alice")).activeUntil, null);
    assert.equal(await first.begin("alice", "translation", "same-feed"), false, "expired windows cannot be revived after five uses");
    now = Date.parse("2026-09-14T23:59:00Z");
    await first.begin("bob", "translation", "late");
    assert.equal((await first.access("bob")).activeUntil, "2026-09-15T00:00:30.000Z");
    now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal((await first.access("alice")).remaining, 10);
    assert.ok((await first.access("bob")).activeUntil, "ongoing sessions continue across midnight");
    assert.equal(await second.begin("bob", "translation", "late"), true);
    assert.equal((await first.access("bob")).remaining, 10, "reconnecting an ongoing session after midnight is not a new start");
    assert.equal(await second.begin("alice", "another-panel", "eleventh"), true);
  } finally { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test("PostgreSQL: free speech has zero charge, paid fallback stays metered, and direct routes cannot bypass session ownership", { skip: !process.env["NIXAMP_TEST_DATABASE_URL"] }, async () => {
  const connectionString = process.env["NIXAMP_TEST_DATABASE_URL"]!;
  const admin = new pg.Pool({ connectionString }), schema = `free_meter_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  let now = Date.parse("2026-09-14T12:00:00Z"), calls = 0;
  const passes = new TranslationPasses({ db, now: () => now, key: "", site: "https://nixamp.com" });
  const voice = new LiveVoice({ db, billing: passes, now: () => now, apiKey: "fixture", fetcher: (async url => {
    if (String(url).includes("/voices?")) return Response.json({ voices: [{ voice_id: "one", name: "One" }] });
    calls++;
    return String(url).includes("speech-to-text") ? Response.json({ language_code: "es", words: [] }) : new Response(new Uint8Array([0, 0, 1, 0]));
  }) as typeof fetch });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    assert.equal((await passes.access("alice")).available, false, "free use works even if checkout is unavailable");
    await db.query("INSERT INTO translation_wallets VALUES ('alice', 1000000, $1)", [new Date(now + 86_400_000)]);
    await passes.begin("alice", "feed");
    await passes.begin("bob", "feed");
    const ids = await passes.reserveMany(["alice", "bob", "alice", "stranger"], "voice", 500, "feed");
    assert.deepEqual(ids.map(row => row.by).sort(), ["alice", "bob"]);
    assert.equal((await passes.access("alice")).balanceMicros, 1_000_000, "free allowance wins over purchased credit");
    const usage = (await db.query("SELECT charge_micros, cost_micros FROM translation_usage")).rows;
    assert.ok(usage.every(row => Number(row.charge_micros) === 0 && Number(row.cost_micros) === 25_000));
    await passes.refundMany(ids.map(row => row.id));
    assert.equal((await passes.access("alice")).balanceMicros, 1_000_000, "free refunds never mint paid credit");
    await assert.rejects(passes.require("bob", "other-feed"), /Buy/);
    assert.deepEqual((await passes.eligible(["alice", "bob", "stranger"], "feed")).sort(), ["alice", "bob"]);
    server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", translationPasses: passes, liveVoice: voice,
      accounts: { whoIs: async (token: string) => ["alice", "bob", "stranger"].includes(token) ? { id: token } : null } as unknown as Accounts });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = (account: string, resource: string) => fetch(`${base}/api/v1/translation-passes/session`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${account}` }, body: JSON.stringify({ resource, remaining: 999, by: "alice" }) });
    assert.equal((await session("anonymous", "feed")).status, 401);
    assert.equal((await session("bob", "feed")).status, 200);
    assert.equal((await passes.access("bob")).free.remaining, 4);
    const wav = new Uint8Array(encodeWav(new Float32Array(32000).fill(.1)));
    const hear = (account: string, resource: string) => fetch(`${base}/api/v1/speech/speakers`, { method: "POST", headers: { authorization: `Bearer ${account}`, "content-type": "audio/wav", "x-nixamp-translation-session": resource }, body: wav });
    assert.equal((await hear("stranger", "feed")).status, 402);
    assert.equal((await hear("bob", "feed")).status, 200);
    assert.equal(calls, 1);
    const grant = await voice.grant("bob", "feed");
    const synth = await fetch(`${base}/api/v1/speech/synthesize`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ text: "Hallo", language: "de", channel: "feed" }) });
    assert.equal(synth.status, 200); await synth.arrayBuffer();
    now += 90_001;
    await assert.rejects(passes.reserve("bob", "voice", 100, "feed"), /free session/);
    const paid = await passes.reserve("alice", "voice", 100, "feed"); await passes.commit(paid);
    assert.equal((await passes.access("alice")).balanceMicros, 975000, "an ended session falls back to existing 5x credit rate");
    for (let i = 0; i < 4; i++) { await passes.begin("bob", `more-${i}`); now += 90_001; }
    assert.equal((await session("bob", "sixth")).status, 402);
    const before = calls; assert.equal((await hear("bob", "feed")).status, 402); assert.equal(calls, before, "no provider call after free allowance is exhausted");
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

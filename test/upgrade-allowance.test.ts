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
    assert.equal((await first.access("alice")).remaining, 9, "tabs and replicas reuse the same active resource");
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

test("PostgreSQL: AI is pay as you go with no free sessions; only the admin is never charged", { skip: !process.env["NIXAMP_TEST_DATABASE_URL"] }, async () => {
  const connectionString = process.env["NIXAMP_TEST_DATABASE_URL"]!;
  const admin = new pg.Pool({ connectionString }), schema = `payg_meter_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  const now = Date.parse("2026-09-14T12:00:00Z");
  let calls = 0;
  const passes = new TranslationPasses({ db, now: () => now, key: "", site: "https://nixamp.com", admins: ["owner"] });
  const voice = new LiveVoice({ db, billing: passes, now: () => now, apiKey: "fixture", fetcher: (async url => {
    if (String(url).includes("/voices?")) return Response.json({ voices: [{ voice_id: "one", name: "One" }] });
    calls++;
    return String(url).includes("speech-to-text") ? Response.json({ language_code: "es", words: [] }) : new Response(new Uint8Array([0, 0, 1, 0]));
  }) as typeof fetch });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const balance = async (by: string) => (await passes.access(by)).balanceMicros;
    await passes.access();
    await db.query("INSERT INTO translation_wallets VALUES ('alice', 10000000, $1)", [new Date(now + 86_400_000)]);
    // No free sessions, for anybody: the page is never offered one.
    assert.equal((await passes.access("bob")).free.remaining, 0);
    await assert.rejects(passes.begin("bob", "feed"), /Buy AI credit/);
    await assert.rejects(passes.require("bob"), /Buy AI credit/);
    await passes.begin("alice", "feed");
    await passes.begin("owner", "feed");
    assert.equal((await passes.access("owner")).required, false);

    // Everybody but the admin pays, at five times the provider's cost; the admin's use costs nothing and is not recorded.
    const ids = await passes.reserveMany(["alice", "bob", "owner"], "voice", 500, "feed");
    assert.deepEqual(ids.map(row => row.by).sort(), ["alice", "owner"]);
    assert.equal(await balance("alice"), 9_875_000);
    const usage = (await db.query("SELECT by_account, charge_micros FROM translation_usage")).rows;
    assert.deepEqual(usage.map(row => [row.by_account, Number(row.charge_micros)]), [["alice", 125_000]]);
    await passes.refundMany(ids.map(row => row.id));
    assert.equal(await balance("alice"), 10_000_000);
    assert.deepEqual((await passes.eligible(["alice", "bob", "owner"])).sort(), ["alice", "owner"]);

    // The other AI: charged first, kept when the work is done, given back when it fails.
    assert.equal(await passes.spend("alice", "video", 8, async () => "clip"), "clip");
    assert.equal(await balance("alice"), 4_000_000, "8 s of Veo at $0.15/s, times five");
    await assert.rejects(passes.spend("bob", "translation_local", 1000, async () => "never"), /Buy AI credit/);
    const before = await balance("alice");
    await assert.rejects(passes.spend("alice", "translation_local", 1000, async () => { throw new Error("model down"); }), /model down/);
    assert.equal(await balance("alice"), before, "a failed job is refunded");
    await passes.spend("alice", "translation_local", 1000, async () => "ok");
    assert.equal(await balance("alice"), before - 10_000 * 5);
    assert.equal(await passes.spend("owner", "video", 8, async () => "free for the admin"), "free for the admin");
    assert.equal(TranslationPasses.price("video", 8).charge, 6_000_000);

    // Routes: nobody unfunded reaches the provider.
    server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", translationPasses: passes, liveVoice: voice,
      accounts: { whoIs: async (token: string) => ["alice", "bob", "owner"].includes(token) ? { id: token } : null } as unknown as Accounts });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = (account: string) => fetch(`${base}/api/v1/translation-passes/session`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${account}` }, body: JSON.stringify({ resource: "feed" }) });
    assert.equal((await session("anonymous")).status, 401);
    assert.equal((await session("bob")).status, 402);
    assert.equal((await session("owner")).status, 200);
    const wav = new Uint8Array(encodeWav(new Float32Array(32000).fill(.1)));
    const hear = (account: string) => fetch(`${base}/api/v1/speech/speakers`, { method: "POST", headers: { authorization: `Bearer ${account}`, "content-type": "audio/wav", "x-nixamp-translation-session": "feed" }, body: wav });
    assert.equal((await hear("bob")).status, 402);
    assert.equal(calls, 0, "no provider call for somebody without credit");
    assert.equal((await hear("owner")).status, 200);
    assert.equal((await hear("alice")).status, 200);
    assert.equal(calls, 2);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

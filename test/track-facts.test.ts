import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HolderStore, aiFromTags, factsFor, type Holder } from "../src/track-facts.ts";
import { Support, supportHoldersFrom } from "../src/support.ts";
import type { Station } from "../src/stations.ts";

const station = (over: Partial<Station> = {}): Station => ({
  id: "rvhmw2dwv3", name: "Þrøngva Radio", description: "", items: [], shuffle: true, repeat: true, visibility: "public", listed: true,
  desired: "running", listenToken: "t", bitrate: 192, video: false, breaksEvery: 0, auto: "",
  rights: { basis: "owned", note: "Original music by Profullstack, made with Suno", declaredAt: 0, declaredBy: "x" },
  owner: "", failures: {}, idempotencyKey: "", createdAt: 0, updatedAt: 0, ...over,
});
const profullstack: Holder = { id: "profullstack", name: "Profullstack", artists: ["profullstack", "Þrøngva"], stations: [], support: "https://nixamp.com/support/profullstack", label: "Support", license: "All rights reserved" };

test("AI is said only on evidence, and names what made it", () => {
  assert.deepEqual(aiFromTags({ comment: "made with suno; created=2026-07-22" })?.by, "Suno");
  assert.equal(aiFromTags({ comment: "Composed by elevenlabs/music_v1 from a brief" })?.by, "ElevenLabs Music");
  assert.equal(aiFromTags({ genre: "AI" })?.by, "AI");
  assert.equal(aiFromTags({ encoder: "Lavf61.7.100", comment: "ripped from my vinyl" }), null);
  assert.equal(aiFromTags({}), null);
});

test("a Suno track by a registered holder: AI, their copyright, their support link", () => {
  const facts = factsFor({ station: station(), file: "/m/a.mp3", tags: { title: "Frost on the Oar", artist: "profullstack", comment: "made with suno", date: "2026-07-22" }, holders: [profullstack] });
  assert.equal(facts.title, "Frost on the Oar");
  assert.equal(facts.year, "2026");
  assert.deepEqual(facts.ai, { generated: true, by: "Suno", evidence: 'comment tag: "made with suno"' });
  assert.equal(facts.rights.holder, "Profullstack");
  assert.equal(facts.rights.license, "All rights reserved");
  assert.deepEqual(facts.support, { holder: "Profullstack", url: "https://nixamp.com/support/profullstack", label: "Support" });
});

test("a copyright tag wins; a share says who shared it; nothing known is said as not known", () => {
  const tagged = factsFor({ station: station(), file: "/m/b.mp3", tags: { artist: "Someone", copyright: "© 2024 Indie Label" }, holders: [profullstack] });
  assert.equal(tagged.rights.holder, "2024 Indie Label");
  assert.equal(tagged.rights.source, "tag");
  assert.equal(tagged.ai.generated, null, "no evidence either way");
  assert.equal(tagged.support, null, "the holder link is for Profullstack's artists only");
  const shared = factsFor({ station: station({ rights: null }), file: "/s/c.mp3", tags: { artist: "Kevin MacLeod" }, holders: [], share: { basis: "creative-commons", note: "CC BY 3.0", by: "riotcoder" } });
  assert.deepEqual([shared.rights.holder, shared.rights.basis, shared.rights.license], ["riotcoder", "creative-commons", "CC BY 3.0"]);
  const composed = factsFor({ station: station({ auto: "ai:abc" }), file: "/ai/d.mp3", tags: {}, holders: [], aiTrack: { made: "gemini + elevenlabs/music_v1" } });
  assert.deepEqual([composed.ai.generated, composed.ai.by], [true, "elevenlabs/music_v1"]);
  const bare = factsFor({ station: station({ rights: null }), file: "/x.mp3", tags: {}, holders: [] });
  assert.deepEqual(bare.rights, { holder: "", basis: "", note: "", license: "", source: "" });
});

test("holders: made by name, matched by station, https-only support links", () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-holders-"));
  try {
    const store = new HolderStore(join(top, "h.json"));
    const made = store.set({ name: "Profullstack", artists: ["profullstack"], stations: ["rvhmw2dwv3", "bad id"], support: "https://nixamp.com/support/profullstack" });
    assert.equal(made.id, "profullstack");
    assert.deepEqual(made.stations, ["rvhmw2dwv3"]);
    assert.throws(() => store.set({ name: "X", support: "http://insecure.example" }), /https/);
    assert.equal(new HolderStore(join(top, "h.json")).list().length, 1, "kept on disk");
    const byStation = factsFor({ station: station(), file: "/m/a.mp3", tags: { artist: "Whoever" }, holders: store.list() });
    assert.equal(byStation.rights.holder, "Profullstack");
    assert.equal(store.remove("profullstack"), true);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("support: a one-time CoinPay hosted checkout on nixamp's business, for a known holder, any coin or PayPal", async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.endsWith("/api/supported-coins")) {
      return new Response(JSON.stringify({ success: true, business_id: "826b0d85-d0b8-4974-b78a-229b5fefc9c4", coins: [{ symbol: "SOL", is_active: true, has_wallet: true }, { symbol: "BTC", is_active: true, has_wallet: false }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, id: "cs_Abc123Abc123Abc123Abc123", url: "https://coinpayportal.com/checkout/cs_Abc123Abc123Abc123Abc123" }), { status: 201 });
  }) as unknown as typeof fetch;
  const support = new Support({ key: "cp_live_test", site: "https://nixamp.com", holders: supportHoldersFrom({}), fetcher });
  assert.deepEqual((await support.coins()).coins, ["SOL"], "only coins with a wallet");
  const { url } = await support.checkout({ holder: "profullstack", amountUsd: 5, email: "fan@example.com", station: "rvhmw2dwv3", track: "Frost on the Oar" });
  assert.equal(url, "https://coinpayportal.com/checkout/cs_Abc123Abc123Abc123Abc123");
  const created = sent.find((one) => one.url.endsWith("/api/checkout/sessions"))!.body!;
  assert.equal(created["amount"], 5);
  assert.equal(created["currency"], "USD");
  assert.equal(created["property"], "nixamp.com");
  assert.equal(created["customer_email"], "fan@example.com");
  assert.deepEqual((created["metadata"] as Record<string, unknown>)["holder"], "profullstack");
  await assert.rejects(support.checkout({ holder: "taylor-swift", amountUsd: 5, email: "fan@example.com" }), /Nobody by that name/);
  await assert.rejects(support.checkout({ holder: "profullstack", amountUsd: 0.5, email: "fan@example.com" }), /amount/);
  await assert.rejects(support.checkout({ holder: "profullstack", amountUsd: 5 }), /email/);
});
test("monthly support: month one at once, a link a month while paid, lapsed when not, cancel by link", async () => {
  const { SupportSubscriptions, nextMonth } = await import("../src/support.ts");
  assert.equal(new Date(nextMonth(Date.UTC(2026, 0, 31))).toISOString().slice(0, 10), "2026-02-28", "the 31st becomes the month's last day");
  // A table of rows and just the statements SupportSubscriptions sends.
  const rows: Array<Record<string, unknown>> = [];
  const db = { query: async (text: string, params: unknown[] = []) => {
    if (/^(CREATE|ALTER)/.test(text.trim())) return { rows: [] };
    if (text.includes("count(*)")) return { rows: [{ n: rows.filter((r) => r["email"] === params[0] && r["status"] === "active").length }] };
    if (text.startsWith("INSERT")) {
      const [id, token, holder, email, amount_cents, coin, last_payment_id, next_due, station, created_at] = params;
      rows.push({ id, token, holder, email, amount_cents, coin, status: "active", cycles: 1, last_payment_id, next_due, station, created_at, cycle_payment_ids: last_payment_id });
      return { rows: [] };
    }
    if (text.includes("WHERE status = 'active' AND next_due <=")) return { rows: rows.filter((r) => r["status"] === "active" && (r["next_due"] as Date).getTime() <= (params[0] as Date).getTime()) };
    if (text.includes("SET status = 'lapsed'")) { rows.filter((r) => r["id"] === params[0]).forEach((r) => { r["status"] = "lapsed"; }); return { rows: [] }; }
    if (text.includes("SET cycles")) { rows.filter((r) => r["id"] === params[0] && r["cycles"] === params[3]).forEach((r) => { r["cycles"] = params[1]; r["last_payment_id"] = null; r["cycle_payment_ids"] = ""; r["next_due"] = params[2]; }); return { rows: [] }; }
    if (text.includes("SET status = 'canceled'")) {
      const hit = rows.filter((r) => r["id"] === params[0] && r["token"] === params[1] && r["status"] !== "canceled");
      hit.forEach((r) => { r["status"] = "canceled"; });
      return { rows: hit.map((r) => ({ holder: r["holder"] })) };
    }
    if (text.startsWith("SELECT holder")) return { rows: rows.filter((r) => r["id"] === params[0] && r["token"] === params[1]).map((r) => ({ holder: r["holder"] })) };
    throw new Error(`unexpected SQL: ${text}`);
  } };
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const status: Record<string, string> = {};
  let made = 0;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/api/supported-coins")) return new Response(JSON.stringify({ success: true, business_id: "826b0d85-d0b8-4974-b78a-229b5fefc9c4", coins: [{ symbol: "SOL", is_active: true, has_wallet: true }] }), { status: 200 });
    if (url.endsWith("/api/checkout/sessions")) { made += 1; return new Response(JSON.stringify({ success: true, id: `cs_month${made}xxxxxxxxxxxxxxx` }), { status: 201 }); }
    if (url.includes("/api/checkout/sessions/")) { const id = url.split("/").pop()!; return new Response(JSON.stringify({ success: true, session: { id, status: status[id] ?? "open" } }), { status: 200 }); }
    if (url.includes("api.resend.com")) { const b = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string }; mails.push({ to: b.to[0]!, subject: b.subject, text: b.text }); return new Response("{}", { status: 200 }); }
    throw new Error(url);
  }) as unknown as typeof fetch;
  let now = Date.UTC(2026, 9, 17);
  const support = new Support({ key: "cp_live_test", site: "https://nixamp.com", holders: supportHoldersFrom({}), fetcher });
  const monthly = new SupportSubscriptions({ db, support, mail: { apiKey: "re_test", from: "nixamp <n@nixamp.com>" }, site: "https://nixamp.com", fetcher, now: () => now });
  await assert.rejects(monthly.start({ holder: "profullstack", amountUsd: 5, coin: "SOL", email: "nope" }), /email/);
  const started = await monthly.start({ holder: "profullstack", amountUsd: 5, coin: "SOL", email: "Fan@Example.com" });
  assert.equal(started.url, "https://coinpayportal.com/checkout/cs_month1xxxxxxxxxxxxxxx");
  assert.equal(rows[0]!["email"], "fan@example.com");
  const link = monthly.payLink(started.id, String(rows[0]!["token"]));
  assert.ok(mails[0]!.text.includes(link), "the stable pay link, not the session (which expires in an hour)");
  assert.match(mails[0]!.text, /support\/cancel\?s=/);
  assert.deepEqual(await monthly.renew(), { renewed: 0, lapsed: 0 }, "not due yet");
  now = Date.UTC(2026, 10, 18);
  status["cs_month1xxxxxxxxxxxxxxx"] = "paid";
  assert.deepEqual(await monthly.renew(), { renewed: 1, lapsed: 0 }, "month one paid: month two's link");
  assert.ok(mails.at(-1)!.text.includes(link), "month two: the same stable link");
  assert.equal(made, 1, "renewal opens no session until the link is followed");
  now = Date.UTC(2026, 11, 19);
  assert.deepEqual(await monthly.renew(), { renewed: 0, lapsed: 1 }, "month two unpaid: it stops");
  assert.match(mails.at(-1)!.subject, /has stopped/);
  const again = await monthly.start({ holder: "profullstack", amountUsd: 10, coin: "SOL", email: "fan@example.com" });
  const row = rows.find((r) => r["id"] === again.id)!;
  assert.equal((await monthly.cancel(again.id, String(row["token"]))).canceled, true);
  assert.equal(row["status"], "canceled");
  await assert.rejects(monthly.cancel(again.id, "wrong"), /not one of ours/);
});

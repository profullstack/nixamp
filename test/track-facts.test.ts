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

test("support: a one-time CoinPay checkout on nixamp's business, for a known holder, in a coin it has a wallet for", async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.endsWith("/api/supported-coins")) {
      return new Response(JSON.stringify({ success: true, business_id: "826b0d85-d0b8-4974-b78a-229b5fefc9c4", coins: [{ symbol: "SOL", is_active: true, has_wallet: true }, { symbol: "BTC", is_active: true, has_wallet: false }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, payment: { id: "pay_abc123" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const support = new Support({ key: "cp_live_test", site: "https://nixamp.com", holders: supportHoldersFrom({}), fetcher });
  assert.deepEqual((await support.coins()).coins, ["SOL"], "only coins with a wallet");
  const { url } = await support.checkout({ holder: "profullstack", amountUsd: 5, coin: "sol", station: "rvhmw2dwv3", track: "Frost on the Oar" });
  assert.equal(url, "https://coinpayportal.com/pay/pay_abc123");
  const created = sent.find((one) => one.url.endsWith("/api/payments/create"))!.body!;
  assert.equal(created["amount_usd"], 5);
  assert.equal(created["currency"], "sol");
  assert.equal(created["business_id"], "826b0d85-d0b8-4974-b78a-229b5fefc9c4");
  assert.deepEqual((created["metadata"] as Record<string, unknown>)["holder"], "profullstack");
  await assert.rejects(support.checkout({ holder: "taylor-swift", amountUsd: 5, coin: "SOL" }), /Nobody by that name/);
  await assert.rejects(support.checkout({ holder: "profullstack", amountUsd: 0.5, coin: "SOL" }), /amount/);
  await assert.rejects(support.checkout({ holder: "profullstack", amountUsd: 5, coin: "BTC" }), /Pay with one of: SOL/);
});

test("Mozart AI is named from its album tag, and the cover's address rides along", () => {
  assert.equal(aiFromTags({ album: "Made with Mozart", artist: "chovy" })?.by, "Mozart AI");
  assert.equal(aiFromTags({ album: "Mozart: Requiem" }), null, "a Mozart album is not AI");
  const facts = factsFor({ station: station(), file: "/m/a.mp3", tags: { title: "Valhalla Bounce" }, holders: [], art: "/api/v1/stations/rvhmw2dwv3/art?t=x&f=abc" });
  assert.equal(facts.art, "/api/v1/stations/rvhmw2dwv3/art?t=x&f=abc");
  assert.equal(factsFor({ station: station(), file: "/m/b.mp3", tags: {}, holders: [] }).art, "");
});

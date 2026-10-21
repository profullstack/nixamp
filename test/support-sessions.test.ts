/**
 * CoinPay hosted checkout sessions on nixamp: the body CoinPay gets for a store
 * purchase, a licence or a tip, how a session is asked whether it is paid, and
 * that a session payment's webhook reaches the purchase that holds the session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Support, SupportSubscriptions, coinOf, paidIn, payUrl, propertyOf } from "../src/support.ts";
import { EmptyEngine, createServer } from "../src/server.ts";
import type { Accounts } from "../src/accounts.ts";

const SESSION = "cs_AbCdEfGhIjKlMnOpQrStUvWx";

function coinpay(status = "open") {
  const calls: { url: string; method: string; body: Record<string, unknown> | null; auth: string }[] = [];
  const state = { status };
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, auth: String((init.headers as Record<string, string> | undefined)?.["authorization"] ?? "") });
    if (url.endsWith("/api/checkout/sessions")) return Response.json({ success: true, id: SESSION, url: `https://coinpayportal.com/checkout/${SESSION}`, methods: [] }, { status: 201 });
    if (url.endsWith(`/api/checkout/sessions/${SESSION}`)) return Response.json({ success: true, session: { id: SESSION, status: state.status, amount: 1, currency: "USD" } });
    if (url.endsWith("/api/payments/legacy-payment-1")) return Response.json({ success: true, payment: { id: "legacy-payment-1", status: "confirmed" } });
    if (url.includes("api.resend.com")) return Response.json({ id: "mail" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher, state };
}

const holders = [{ id: "profullstack", name: "Profullstack" }];

test("a store purchase opens one hosted session filed under nixamp.com, the account and its email", async () => {
  const fake = coinpay();
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher });
  const made = await support.pay({ amountUsd: 0.99, coin: "USDC_POL", email: "Buyer@Example.com", accountId: "user-1", order: "music-o1",
    description: "Song by Band (song, MP3)", metadata: { product: "music", purchase: "o1", kind: "song" }, redirect: "https://nixamp.com/purchases/o1?t=x" });
  assert.deepEqual(made, { url: `https://coinpayportal.com/checkout/${SESSION}`, paymentId: SESSION });
  assert.equal(fake.calls.length, 1, "no supported-coins call: the payer picks on CoinPay");
  assert.equal(fake.calls[0]!.auth, "Bearer cp_live_x");
  assert.deepEqual(fake.calls[0]!.body, {
    amount: 0.99, currency: "USD", description: "Song by Band (song, MP3)",
    customer_email: "buyer@example.com", account_id: "user-1", property: "nixamp.com",
    metadata: { app: "nixamp", order: "music-o1", product: "music", purchase: "o1", kind: "song" },
    success_url: "https://nixamp.com/purchases/o1?t=x", cancel_url: "https://nixamp.com/purchases/o1?t=x", expires_in_minutes: 60,
  });
});

test("a guest's tip is filed under their email; a tip without an email is refused before CoinPay", async () => {
  const fake = coinpay();
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher });
  await support.checkout({ holder: "profullstack", amountUsd: 5, email: "fan@example.org", station: "radio" });
  const body = fake.calls[0]!.body!;
  assert.equal(body["account_id"], "fan@example.org");
  assert.equal(body["customer_email"], "fan@example.org");
  assert.equal(body["amount"], 5);
  assert.equal(body["success_url"], "https://nixamp.com/support/profullstack?thanks=1");
  assert.equal(body["cancel_url"], "https://nixamp.com/support/profullstack");
  assert.equal((body["metadata"] as Record<string, unknown>)["product"], "support");
  await assert.rejects(support.checkout({ holder: "profullstack", amountUsd: 5 }), /email/);
  assert.equal(fake.calls.length, 1);
});

test("a session is asked as a session; an older one-coin payment as a payment", async () => {
  const fake = coinpay("open");
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher });
  assert.equal(await support.isPaid(SESSION), false);
  fake.state.status = "paid";
  assert.equal(await support.isPaid(SESSION), true);
  assert.equal(await support.isPaid("legacy-payment-1"), true);
  assert.equal(await support.isPaid("cs_missingmissingmissing00"), null, "CoinPay did not know it: ask again later");
});

test("monthly support starts on a session and stores no coin", async () => {
  const fake = coinpay();
  const rows: unknown[][] = [];
  const db = { query: async (text: string, params?: unknown[]) => {
    if (/^INSERT INTO support_subscriptions/.test(text.trim())) rows.push(params ?? []);
    return { rows: /count\(\*\)/.test(text) ? [{ n: 0 }] : [] };
  } };
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher });
  const monthly = new SupportSubscriptions({ db, support, mail: { apiKey: "re_x", from: "n@nixamp.com" }, site: "https://nixamp.com", fetcher: fake.fetcher });
  const started = await monthly.start({ holder: "profullstack", amountUsd: 3, email: "fan@example.org" });
  assert.equal(started.url, `https://coinpayportal.com/checkout/${SESSION}`);
  assert.equal(rows[0]![5], "ANY");
  assert.equal(rows[0]![6], SESSION);
  const mail = fake.calls.find((call) => call.url.includes("resend"))!.body!;
  assert.match(String(mail["text"]), /\$3\.00 a month\./);
});

test("helpers: the hosted page for a stored ref, the coin a session stores, the property", () => {
  assert.equal(payUrl(SESSION), `https://coinpayportal.com/checkout/${SESSION}`);
  assert.equal(payUrl("abc-123"), "https://coinpayportal.com/pay/abc-123");
  assert.equal(coinOf(undefined), "ANY");
  assert.equal(coinOf("usdc_pol"), "USDC_POL");
  assert.equal(paidIn("ANY"), "");
  assert.equal(paidIn("BTC"), " in BTC");
  assert.equal(propertyOf("https://www.nixamp.com"), "nixamp.com");
});

test("a signed session webhook reaches the purchase that holds the session id", async () => {
  const settled: string[] = [];
  const musicStore = { owns: async (ref: string) => ref === SESSION, settle: async (ref: string) => { settled.push(ref); return { settled: true, purchase: "o1" }; } };
  const server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", coinpayWebhookSecret: "whsec",
    musicStore, accounts: { whoIs: async () => null } as unknown as Accounts } as unknown as Parameters<typeof createServer>[1]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const raw = JSON.stringify({ id: "evt_1", type: "payment.confirmed", data: { payment_id: "11111111-2222-4333-8444-555555555555", status: "confirmed",
      checkout_session_id: SESSION, customer_email: "a@b.co", account_id: "u1", property: "nixamp.com", metadata: { app: "nixamp", product: "music" } } });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${createHmac("sha256", "whsec").update(`${t}.${raw}`).digest("hex")}`;
    const answer = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/webhooks/coinpay`, { method: "POST", headers: { "content-type": "application/json", "x-coinpay-signature": signature }, body: raw });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { settled: true, purchase: "o1" });
    assert.deepEqual(settled, [SESSION]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

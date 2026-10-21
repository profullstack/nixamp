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

/** support_subscriptions in memory: just the statements SupportSubscriptions sends. */
function subscriptionsDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/^(CREATE|ALTER)/.test(sql)) return { rows: [] };
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    if (sql.startsWith("INSERT INTO support_subscriptions")) {
      const [id, token, holder, email, amount_cents, coin, last_payment_id, next_due, station, created_at] = params;
      rows.set(String(id), { id, token, holder, email, amount_cents, coin, status: "active", cycles: 1, last_payment_id, next_due, station, created_at, cycle_payment_ids: last_payment_id });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM support_subscriptions WHERE id = $1 AND token = $2")) {
      const row = rows.get(String(params[0]));
      return { rows: row && row["token"] === params[1] ? [{ ...row }] : [] };
    }
    if (sql.startsWith("SELECT * FROM support_subscriptions WHERE status = 'active' AND next_due <= $1")) {
      return { rows: [...rows.values()].filter((row) => row["status"] === "active" && (row["next_due"] as Date).getTime() <= (params[0] as Date).getTime()).map((row) => ({ ...row })) };
    }
    if (sql.startsWith("UPDATE support_subscriptions SET last_payment_id = $3")) {
      const row = rows.get(String(params[0]));
      if (row && row["cycles"] === params[1]) { row["last_payment_id"] = params[2]; row["cycle_payment_ids"] = `${row["cycle_payment_ids"] ?? ""} ${params[2]}`.trim(); }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE support_subscriptions SET cycles = $2, last_payment_id = NULL")) {
      const row = rows.get(String(params[0]));
      if (row && row["cycles"] === params[3]) Object.assign(row, { cycles: params[1], last_payment_id: null, cycle_payment_ids: "", next_due: params[2] });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE support_subscriptions SET status = 'lapsed'")) {
      const row = rows.get(String(params[0]));
      if (row) row["status"] = "lapsed";
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { rows, query };
}

/** CoinPay with many sessions: each create makes a new id, each with its own status and expiry. */
function coinpaySessions(now: () => number) {
  const sessions = new Map<string, { status: string; expiresAt: number }>();
  const created: Record<string, unknown>[] = [];
  const mails: string[] = [];
  let n = 0;
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/api/checkout/sessions") && init.method === "POST") {
      n += 1;
      const id = `cs_${String(n).padStart(24, "A")}`;
      sessions.set(id, { status: "open", expiresAt: now() + 60 * 60_000 });
      created.push(JSON.parse(String(init.body)));
      return Response.json({ success: true, id, url: `https://coinpayportal.com/checkout/${id}` }, { status: 201 });
    }
    const one = /\/api\/checkout\/sessions\/(cs_[A-Za-z0-9]+)$/.exec(url);
    if (one) {
      const state = sessions.get(one[1]!);
      if (!state) return new Response("{}", { status: 404 });
      return Response.json({ success: true, session: { id: one[1], status: state.status, expires_at: new Date(state.expiresAt).toISOString() } });
    }
    if (url.includes("api.resend.com")) { mails.push(String(JSON.parse(String(init.body))["text"])); return Response.json({ id: "mail" }); }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { sessions, created, mails, fetcher };
}

test("the emailed pay link opens a fresh session however late, reuses an open one, and says when the month is paid", async () => {
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const now = () => clock;
  const db = subscriptionsDb();
  const fake = coinpaySessions(now);
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher, now });
  const monthly = new SupportSubscriptions({ db, support, mail: { apiKey: "re_x", from: "n@nixamp.com" }, site: "https://nixamp.com", fetcher: fake.fetcher, now });
  const started = await monthly.start({ holder: "profullstack", amountUsd: 5, email: "fan@example.org" });
  const row = db.rows.get(started.id)!;
  const link = monthly.payLink(started.id, String(row["token"]));
  assert.match(link, /^https:\/\/nixamp\.com\/support\/pay\/[0-9a-f-]{36}\/[0-9a-f]{32}$/);
  assert.ok(fake.mails[0]!.includes(link), "the first email carries the stable link, not the session");
  assert.ok(!fake.mails[0]!.includes("/checkout/cs_"));

  // Followed at once: the first month's session is still open, so it is reused.
  assert.deepEqual(await monthly.open(started.id, String(row["token"])), { state: "redirect", url: started.url });
  assert.equal(fake.created.length, 1);

  // Three hours later the session has expired: a new one, for the same amount, payer and month.
  clock += 3 * 3600_000;
  fake.sessions.get(started.url.split("/").at(-1)!)!.status = "expired";
  const late = await monthly.open(started.id, String(row["token"]));
  assert.equal(late.state, "redirect");
  assert.notEqual((late as { url: string }).url, started.url);
  assert.equal(fake.created.length, 2);
  assert.equal(fake.created[1]!["amount"], 5);
  assert.equal(fake.created[1]!["customer_email"], "fan@example.org");
  assert.deepEqual((fake.created[1]!["metadata"] as Record<string, unknown>)["subscription"], started.id);
  assert.equal(String(db.rows.get(started.id)!["cycle_payment_ids"]).split(" ").length, 2);

  // The FIRST (expired) session turns out paid (a late chain confirmation): the month is paid.
  fake.sessions.get(started.url.split("/").at(-1)!)!.status = "paid";
  assert.equal((await monthly.open(started.id, String(row["token"]))).state, "paid");
  assert.equal(fake.created.length, 2, "no checkout opened for a paid month");

  // A wrong token is refused before CoinPay is asked.
  await assert.rejects(monthly.open(started.id, "0".repeat(32)), /not one of ours/);
});

test("renewal emails the stable link and opens no session; an unpaid month lapses", async () => {
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const now = () => clock;
  const db = subscriptionsDb();
  const fake = coinpaySessions(now);
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher, now });
  const monthly = new SupportSubscriptions({ db, support, mail: { apiKey: "re_x", from: "n@nixamp.com" }, site: "https://nixamp.com", fetcher: fake.fetcher, now });
  const started = await monthly.start({ holder: "profullstack", amountUsd: 3, email: "fan@example.org" });
  const token = String(db.rows.get(started.id)!["token"]);
  fake.sessions.get(started.url.split("/").at(-1)!)!.status = "paid";

  clock = Date.parse("2026-11-01T13:00:00Z");
  assert.deepEqual(await monthly.renew(), { renewed: 1, lapsed: 0 });
  assert.equal(fake.created.length, 1, "renewal opens no session: the link does, when followed");
  assert.ok(fake.mails.at(-1)!.includes(monthly.payLink(started.id, token)));
  assert.equal(db.rows.get(started.id)!["cycles"], 2);
  assert.equal(db.rows.get(started.id)!["cycle_payment_ids"], "");

  // Followed 20 days later: a session for month two.
  clock = Date.parse("2026-11-21T09:00:00Z");
  const opened = await monthly.open(started.id, token);
  assert.equal(opened.state, "redirect");
  assert.equal((fake.created[1]!["metadata"] as Record<string, unknown>)["cycle"], 2);

  // Never paid: at the next due date it lapses, and the link says so.
  clock = Date.parse("2026-12-01T13:00:00Z");
  assert.deepEqual(await monthly.renew(), { renewed: 0, lapsed: 1 });
  assert.equal((await monthly.open(started.id, token)).state, "lapsed");
});

test("an existing subscriber's row (one session in last_payment_id, no cycle list) still counts as paid", async () => {
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const now = () => clock;
  const db = subscriptionsDb();
  const fake = coinpaySessions(now);
  const support = new Support({ key: "cp_live_x", site: "https://nixamp.com", holders, fetcher: fake.fetcher, now });
  const monthly = new SupportSubscriptions({ db, support, mail: { apiKey: "re_x", from: "n@nixamp.com" }, site: "https://nixamp.com", fetcher: fake.fetcher, now });
  const started = await monthly.start({ holder: "profullstack", amountUsd: 3, email: "fan@example.org" });
  db.rows.get(started.id)!["cycle_payment_ids"] = ""; // as the column's default fills an older row
  fake.sessions.get(started.url.split("/").at(-1)!)!.status = "paid";
  clock = Date.parse("2026-11-01T13:00:00Z");
  assert.deepEqual(await monthly.renew(), { renewed: 1, lapsed: 0 });
});

test("GET /support/pay/<id>/<token> redirects to the checkout; HEAD opens nothing; a bad link is 404", async () => {
  const opened: string[] = [];
  const supportSubscriptions = {
    open: async (id: string, token: string) => {
      opened.push(id);
      if (token !== "a".repeat(32)) throw new (await import("../src/support.ts")).SupportError("That payment link is not one of ours.", 404, "not_found");
      return { state: "redirect", url: `https://coinpayportal.com/checkout/${SESSION}` };
    },
  };
  const server = createServer(new EmptyEngine(), { web: null, media: false, version: "test", supportSubscriptions,
    accounts: { whoIs: async () => null } as unknown as Accounts } as unknown as Parameters<typeof createServer>[1]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/support/pay/11111111-2222-4333-8444-555555555555`;
    const go = await fetch(`${base}/${"a".repeat(32)}`, { redirect: "manual" });
    assert.equal(go.status, 303);
    assert.equal(go.headers.get("location"), `https://coinpayportal.com/checkout/${SESSION}`);
    const head = await fetch(`${base}/${"a".repeat(32)}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(opened.length, 1, "HEAD opened no checkout");
    const bad = await fetch(`${base}/${"b".repeat(32)}`, { redirect: "manual" });
    assert.equal(bad.status, 404);
    assert.match(await bad.text(), /not one of ours/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

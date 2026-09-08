import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  DEFAULT_PAYWALL,
  FREE_LISTENERS,
  applyRemoteConfig,
  isGated,
  paywallFromEnv,
  shouldCharge,
  rewrite,
  toRequest,
} from "../src/paywall.ts";
import { Connections } from "../src/connections.ts";

const paying = { ...DEFAULT_PAYWALL, enabled: true, payTo: "0xabc" };

test("only the audio is behind the gate", () => {
  assert.equal(isGated("/api/stream/0"), true);
  assert.equal(isGated("/api/media/3"), true);
  // A 402 here would break the page that has to render the offer.
  assert.equal(isGated("/api/state"), false);
  assert.equal(isGated("/api/events"), false);
  assert.equal(isGated("/api/health"), false);
  assert.equal(isGated("/"), false);
});

test("the sixth listener is the one who pays", () => {
  for (let listeners = 0; listeners <= FREE_LISTENERS; listeners++) {
    assert.equal(shouldCharge(paying, "/api/stream/0", listeners), false);
  }
  assert.equal(shouldCharge(paying, "/api/stream/0", FREE_LISTENERS + 1), true);
});

test("a paywall that is off, or has nowhere to pay, never charges", () => {
  const busy = FREE_LISTENERS + 10;
  assert.equal(shouldCharge({ ...paying, enabled: false }, "/api/stream/0", busy), false);
  // Enabled with no address would be a 402 nobody could satisfy.
  assert.equal(shouldCharge({ ...paying, payTo: "" }, "/api/stream/0", busy), false);
  assert.equal(shouldCharge(paying, "/api/state", busy), false);
});

test("only listeners count towards busy, not the state feed", () => {
  const set = new Connections();
  const request = { socket: { remoteAddress: "10.0.0.5" }, headers: {} } as unknown as IncomingMessage;

  for (let i = 0; i < 10; i++) set.open(request, "events", "");
  assert.equal(set.active, 10);
  // Ten browsers watching the state would otherwise put a silent stream over
  // the allowance.
  assert.equal(set.listening, 0);

  const a = set.open(request, "stream", "one");
  set.open(request, "media", "two");
  assert.equal(set.listening, 2);

  set.close(a.id);
  assert.equal(set.listening, 1);
});

test("the environment configures a paywall, and a bad number keeps the default", () => {
  assert.deepEqual(paywallFromEnv({}), DEFAULT_PAYWALL);

  const set = paywallFromEnv({
    NIXAMP_X402: "1",
    NIXAMP_PAY_TO: "0xdead",
    COINPAY_X402_KEY: "cp_live_x",
    NIXAMP_PRICE_CENTS: "250",
    NIXAMP_PASS_MINUTES: "60",
  });
  assert.deepEqual(set, {
    enabled: true,
    payTo: "0xdead",
    coinpayKey: "cp_live_x",
    priceCents: 250,
    passMinutes: 60,
  });

  const nonsense = paywallFromEnv({ NIXAMP_PRICE_CENTS: "free", NIXAMP_PASS_MINUTES: "-5" });
  assert.equal(nonsense.priceCents, DEFAULT_PAYWALL.priceCents);
  assert.equal(nonsense.passMinutes, DEFAULT_PAYWALL.passMinutes);
  // Anything but "1" leaves it off, so a stray "true" cannot start charging.
  assert.equal(paywallFromEnv({ NIXAMP_X402: "true" }).enabled, false);
});

test("remote configuration can switch it on and off, and cannot invent a payee", () => {
  const off = { ...DEFAULT_PAYWALL, payTo: "0xmine" };

  assert.equal(applyRemoteConfig(off, { enabled: true }).enabled, true);
  assert.equal(applyRemoteConfig({ ...off, enabled: true }, { enabled: false }).enabled, false);

  // A field the directory did not send keeps what it had.
  assert.equal(applyRemoteConfig(off, { enabled: true }).payTo, "0xmine");
  assert.equal(applyRemoteConfig(off, {}).enabled, false);
  assert.deepEqual(applyRemoteConfig(off, null), off);
  assert.deepEqual(applyRemoteConfig(off, "nonsense"), off);

  // An empty payTo does not wipe the operator's own.
  assert.equal(applyRemoteConfig(off, { payTo: "" }).payTo, "0xmine");
  assert.equal(applyRemoteConfig(off, { payTo: "0xtheirs" }).payTo, "0xtheirs");

  assert.equal(applyRemoteConfig(off, { priceCents: 500 }).priceCents, 500);
  assert.equal(applyRemoteConfig(off, { priceCents: 0 }).priceCents, off.priceCents);
  assert.equal(applyRemoteConfig(off, { priceCents: "lots" }).priceCents, off.priceCents);
});

test("a node request becomes a Fetch request the gateway can read", () => {
  const node = {
    url: "/api/stream/0?k=abc",
    method: "GET",
    headers: { "user-agent": "curl/8", "x-nixamp-pass": "cp_x.y", accept: undefined },
  } as unknown as IncomingMessage;

  const request = toRequest(node, "https://nixamp.example.com");
  assert.equal(request.url, "https://nixamp.example.com/api/stream/0?k=abc");
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("x-nixamp-pass"), "cp_x.y");
  // An undefined header value must not become the string "undefined".
  assert.equal(request.headers.get("accept"), null);
});

test("the 402 talks about listening, not about crawlers", async () => {
  const gatewayBody = JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: "exact" }],
    pass: { price: "1.00 USD", minutes: 1440 },
    error: "Payment required for training crawlers. Read http://x/listen/pay for how.",
  });
  const answer = new Response(gatewayBody, {
    status: 402,
    headers: { "content-type": "application/json" },
  });

  const out = JSON.parse((await rewrite(answer, "http://x")).toString("utf8")) as Record<string, unknown>;
  assert.match(String(out["error"]), /people listening/);
  assert.doesNotMatch(String(out["error"]), /crawler/);
  assert.match(String(out["error"]), /1\.00 USD for a day/);
  // The offer itself must survive: only the sentence is ours.
  assert.deepEqual(out["accepts"], [{ scheme: "exact" }]);
  assert.equal(out["x402Version"], 2);
});

test("anything that is not a JSON 402 passes through untouched", async () => {
  const html = new Response("<h1>pay up</h1>", { status: 402, headers: { "content-type": "text/html" } });
  assert.equal((await rewrite(html, "http://x")).toString("utf8"), "<h1>pay up</h1>");

  const ok = new Response('{"fine":true}', { status: 200, headers: { "content-type": "application/json" } });
  assert.equal((await rewrite(ok, "http://x")).toString("utf8"), '{"fine":true}');

  const broken = new Response("not json", { status: 402, headers: { "content-type": "application/json" } });
  assert.equal((await rewrite(broken, "http://x")).toString("utf8"), "not json");
});

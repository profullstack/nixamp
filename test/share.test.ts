import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  KEY_COOKIE,
  firewallHint,
  keyCookie,
  keyFrom,
  keysMatch,
  classify,
  newKey,
  reachableAddresses,
  shareLink,
} from "../src/share.ts";
import { parseServeArgs } from "../src/server.ts";

const request = (headers: Record<string, string>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

test("a key is 128 bits of base64url, and two are never the same", () => {
  const a = newKey();
  const b = newKey();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
});

test("keys compare without throwing on a length mismatch", () => {
  const key = newKey();
  assert.equal(keysMatch(key, key), true);
  assert.equal(keysMatch(key, `${key}x`), false);
  assert.equal(keysMatch(key, ""), false);
  assert.equal(keysMatch("", ""), true);
});

test("a key is accepted from the query, a header, or the cookie", () => {
  const url = new URL("http://host/api/state?k=from-query");
  assert.equal(keyFrom(request({}), url), "from-query");

  const plain = new URL("http://host/api/state");
  assert.equal(keyFrom(request({ "x-nixamp-key": "from-header" }), plain), "from-header");
  assert.equal(keyFrom(request({ cookie: `${KEY_COOKIE}=from-cookie` }), plain), "from-cookie");
  assert.equal(
    keyFrom(request({ cookie: `other=x; ${KEY_COOKIE}=from-cookie; more=y` }), plain),
    "from-cookie",
  );
  assert.equal(keyFrom(request({ cookie: "other=x" }), plain), null);
  assert.equal(keyFrom(request({}), plain), null);
});

test("a base64url key survives the cookie round trip", () => {
  // base64url has no characters a cookie minds, but the encode/decode pair is
  // what guarantees that rather than the alphabet happening to be safe today.
  const key = newKey();
  const cookie = keyCookie(key);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const value = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
  assert.equal(keyFrom(request({ cookie: `${KEY_COOKIE}=${value}` }), new URL("http://host/")), key);
});

test("a pinned host is the only address offered", () => {
  assert.deepEqual(reachableAddresses("127.0.0.1", 4321), [
    { label: "here", url: "http://127.0.0.1:4321" },
  ]);
});

test("binding everything offers localhost first, then real addresses", () => {
  const found = reachableAddresses("0.0.0.0", 4321);
  assert.equal(found[0]?.url, "http://localhost:4321");
  for (const { url } of found) assert.match(url, /^http:\/\/[^/]+:4321$/);
});

test("an address is classified by where it actually goes", () => {
  assert.equal(classify("10.10.0.6"), "private");
  assert.equal(classify("192.168.1.42"), "private");
  assert.equal(classify("172.17.0.1"), "private");
  assert.equal(classify("172.32.0.1"), "public");
  assert.equal(classify("169.254.1.1"), "private");
  assert.equal(classify("100.65.178.123"), "cgnat");
  assert.equal(classify("100.128.0.1"), "public");
  // The one that matters: a cloud box's own address is not "your network".
  assert.equal(classify("67.205.189.229"), "public");
});

test("the share link carries the key, and without one is just the address", () => {
  assert.equal(shareLink("http://10.0.0.5:4321", "abc"), "http://10.0.0.5:4321/s/abc");
  assert.equal(shareLink("http://10.0.0.5:4321", null), "http://10.0.0.5:4321");
});

test("serve listens on every interface and wants a key, unless told otherwise", () => {
  const fallback = parseServeArgs([]);
  assert.equal(fallback.host, "0.0.0.0");
  assert.equal(fallback.key, true);

  const opened = parseServeArgs(["--no-key"]);
  assert.equal(opened.key, false);

  const pinned = parseServeArgs(["--host", "127.0.0.1"]);
  assert.equal(pinned.host, "127.0.0.1");
  assert.equal(pinned.key, true);
});

test("ufw and firewalld are reported, and a quiet machine says nothing", () => {
  if (process.platform !== "linux") return;
  const nothing = () => null;
  const inactive = () => ({ status: 3, stdout: "inactive\n" });

  assert.equal(firewallHint(nothing, inactive), null);
  assert.match(
    firewallHint(() => "ENABLED=yes\n", inactive) ?? "",
    /ufw is enabled/,
  );
  assert.equal(firewallHint(() => "ENABLED=no\n", inactive), null);
  assert.match(
    firewallHint(nothing, () => ({ status: 0, stdout: "active\n" })) ?? "",
    /firewalld is running/,
  );
});

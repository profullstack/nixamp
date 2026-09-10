import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryZone, Porkbun, isIPv4, isIPv6 } from "../src/dns.ts";

test("an address is one family or the other, and both count", () => {
  assert.equal(isIPv4("152.53.47.37"), true);
  assert.equal(isIPv4("2a01:4f8::1"), false);
  assert.equal(isIPv6("2a01:4f8::1"), true);
  assert.equal(isIPv6("152.53.47.37"), false);
  assert.equal(isIPv4("999.1.1.1"), false);
  assert.equal(isIPv6("not-an-address"), false);
  assert.equal(isIPv4(42), false);
  assert.equal(isIPv6(null), false);
});

test("a memory zone sets, adds and removes the way the registrar does", async () => {
  const zone = new MemoryZone("nixamp.com");
  await zone.set("server2.chovy.nixamp.com", "A", "1.1.1.1");
  await zone.set("server2.chovy.nixamp.com", "A", "2.2.2.2");
  // set replaces: one record, the latest content.
  assert.deepEqual((await zone.list("server2.chovy.nixamp.com", "A")).map((r) => r.content), ["2.2.2.2"]);

  // add appends, which a wildcard order's two TXT challenges need.
  await zone.add("_acme-challenge.chovy.nixamp.com", "TXT", "one");
  await zone.add("_acme-challenge.chovy.nixamp.com", "TXT", "two");
  assert.equal((await zone.list("_acme-challenge.chovy.nixamp.com", "TXT")).length, 2);

  // remove by content leaves the other; remove without content clears the lot.
  await zone.remove("_acme-challenge.chovy.nixamp.com", "TXT", "one");
  assert.deepEqual((await zone.list("_acme-challenge.chovy.nixamp.com", "TXT")).map((r) => r.content), ["two"]);
  await zone.remove("_acme-challenge.chovy.nixamp.com", "TXT");
  assert.equal((await zone.list("_acme-challenge.chovy.nixamp.com", "TXT")).length, 0);
  // Other types at the same host are untouched.
  assert.equal((await zone.list("server2.chovy.nixamp.com", "A")).length, 1);
  // The floor on TTL is the registrar's, applied here so nobody is surprised later.
  await zone.set("x.nixamp.com", "A", "3.3.3.3", 60);
  assert.equal((await zone.list("x.nixamp.com", "A"))[0]?.ttl, 600);
});

/** A Porkbun that answers from a script and remembers every request. */
function porkbun(answers: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const send = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.porkbun.com/api/json/v3", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = answers(path, body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, zone: new Porkbun("nixamp.com", "pk1_key", "sk1_secret", send) };
}

test("Porkbun is spoken to with both halves of the key, and the subdomain without the zone", async () => {
  const { calls, zone } = porkbun((path) => {
    if (path.startsWith("/dns/retrieveByNameType/")) return { status: "SUCCESS", records: [] };
    return { status: "SUCCESS", id: 1 };
  });
  await zone.set("server2.chovy.nixamp.com", "A", "152.53.47.37");
  assert.equal(calls[0]?.path, "/dns/retrieveByNameType/nixamp.com/A/server2.chovy");
  assert.equal(calls[1]?.path, "/dns/create/nixamp.com");
  assert.deepEqual(calls[1]?.body, {
    apikey: "pk1_key",
    // The field the API names as the usual mistake.
    secretapikey: "sk1_secret",
    name: "server2.chovy",
    type: "A",
    content: "152.53.47.37",
    ttl: "600",
  });

  // The apex is asked for with nothing after the slash, and created with an empty name.
  calls.length = 0;
  await zone.add("nixamp.com", "TXT", "v=spf1 -all");
  assert.equal(calls[0]?.path, "/dns/create/nixamp.com");
  assert.equal(calls[0]?.body["name"], "");
  await zone.list("nixamp.com", "TXT");
  assert.equal(calls[1]?.path, "/dns/retrieveByNameType/nixamp.com/TXT/");

  // A host outside the zone is refused before the network is touched.
  await assert.rejects(zone.list("example.org", "A"), /not in nixamp\.com/);
});

test("set edits the record that is there and deletes the extras", async () => {
  const { calls, zone } = porkbun((path) => {
    if (path.startsWith("/dns/retrieveByNameType/")) {
      return {
        status: "SUCCESS",
        records: [
          { id: "11", name: "server2.chovy.nixamp.com", type: "A", content: "1.1.1.1", ttl: "600" },
          { id: "12", name: "server2.chovy.nixamp.com", type: "A", content: "9.9.9.9", ttl: "600" },
        ],
      };
    }
    return { status: "SUCCESS" };
  });
  await zone.set("server2.chovy.nixamp.com", "A", "2.2.2.2", 3600);
  assert.deepEqual(calls.map((c) => c.path), [
    "/dns/retrieveByNameType/nixamp.com/A/server2.chovy",
    "/dns/edit/nixamp.com/11",
    "/dns/delete/nixamp.com/12",
  ]);
  assert.equal(calls[1]?.body["content"], "2.2.2.2");
  assert.equal(calls[1]?.body["ttl"], "3600");

  // remove by content deletes only the matching one.
  calls.length = 0;
  await zone.remove("server2.chovy.nixamp.com", "A", "9.9.9.9");
  assert.deepEqual(calls.map((c) => c.path), [
    "/dns/retrieveByNameType/nixamp.com/A/server2.chovy",
    "/dns/delete/nixamp.com/12",
  ]);
});

test("what the registrar says when it refuses reaches the caller", async () => {
  const { zone } = porkbun(() => ({ status: "ERROR", message: "Invalid domain." }));
  await assert.rejects(zone.list("x.nixamp.com", "A"), /Porkbun refused: Invalid domain\./);

  const { zone: down } = porkbun(() => new Response("gateway timeout", { status: 504 }));
  await assert.rejects(down.list("x.nixamp.com", "A"), /504/);

  const { zone: unreachable } = porkbun(() => {
    throw new Error("ECONNRESET");
  });
  await assert.rejects(unreachable.list("x.nixamp.com", "A"), /did not answer: ECONNRESET/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryZone } from "../src/dns.ts";
import { NameError, Names, validLabel } from "../src/names.ts";
import type { Queryable } from "../src/follows.ts";

/** A database that remembers what it was asked and answers from a script. */
function db(answers: Record<string, Record<string, unknown>[]> = {}) {
  const asked: { text: string; values: unknown[] }[] = [];
  const queryable: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows };
      }
      return { rows: [] };
    },
  };
  return { asked, queryable, sql: () => asked.map((a) => a.text).join("\n") };
}

test("a label is what a server may be called", () => {
  assert.equal(validLabel("server2"), "server2");
  assert.equal(validLabel("  Living-Room  "), "living-room");
  assert.equal(validLabel("a1"), "a1");
  // Too short, too long, the wrong characters, a hyphen at either end.
  assert.equal(validLabel("a"), "");
  assert.equal(validLabel("a".repeat(31)), "");
  assert.equal(validLabel("my server"), "");
  assert.equal(validLabel("café"), "");
  assert.equal(validLabel("-server"), "");
  assert.equal(validLabel("server-"), "");
  // Reserved: the mail and protocol names, the handles nobody may take, and
  // anything an underscore or punycode marks as not a machine.
  assert.equal(validLabel("www"), "");
  assert.equal(validLabel("mail"), "");
  assert.equal(validLabel("api"), "");
  assert.equal(validLabel("_dmarc"), "");
  assert.equal(validLabel("_acme-challenge"), "");
  assert.equal(validLabel("xn--caf-dma"), "");
  assert.equal(validLabel(42), "");
  assert.equal(validLabel(undefined), "");
});

const ROW = (over: Record<string, unknown> = {}) => ({
  account_id: "acct-1",
  handle: "chovy",
  label: "server2",
  a: "152.53.47.37",
  aaaa: "",
  ttl: 600,
  created_at: "2026-09-10T10:00:00Z",
  updated_at: "2026-09-10T10:00:00Z",
  ...over,
});

test("setting a name writes both families into the zone and then the row", async () => {
  const zone = new MemoryZone("nixamp.com");
  const { asked, queryable, sql } = db({
    RETURNING: [ROW({ aaaa: "2a01:4f8::1" })],
  });
  const names = new Names(queryable, zone);

  const made = await names.set("acct-1", "chovy", "Server2", { a: "152.53.47.37", aaaa: "2a01:4f8::1" });
  assert.match(sql(), /CREATE TABLE IF NOT EXISTS dns_names/);
  assert.equal(made.host, "server2.chovy.nixamp.com");
  assert.equal(made.label, "server2");
  assert.deepEqual(
    zone.records.map((r) => [r.host, r.type, r.content]),
    [["server2.chovy.nixamp.com", "A", "152.53.47.37"], ["server2.chovy.nixamp.com", "AAAA", "2a01:4f8::1"]],
  );
  const insert = asked.find((a) => a.text.includes("INSERT INTO dns_names"));
  assert.deepEqual(insert?.values, ["acct-1", "chovy", "server2", "152.53.47.37", "2a01:4f8::1", 600]);
  assert.match(insert?.text ?? "", /ON CONFLICT \(handle, label\) DO UPDATE/);
  assert.equal(made.aaaa, "2a01:4f8::1");
  assert.ok(made.createdAt > 0);
});

test("a name that belongs to somebody else is refused, and so is a name past the limit", async () => {
  const zone = new MemoryZone("nixamp.com");
  const { queryable } = db({ "WHERE handle = $1 AND label = $2": [ROW({ account_id: "acct-2" })] });
  const names = new Names(queryable, zone);
  await assert.rejects(
    names.set("acct-1", "chovy", "server2", { a: "1.1.1.1" }),
    (error: unknown) => error instanceof NameError && error.status === 409,
  );
  assert.equal(zone.records.length, 0, "nothing touched the zone");

  const { queryable: full } = db({ "count(*)": [{ n: 20 }] });
  await assert.rejects(
    new Names(full, zone).set("acct-1", "chovy", "server3", { a: "1.1.1.1" }),
    (error: unknown) => error instanceof NameError && error.status === 422,
  );
  // The limit is the account's own to set.
  const { queryable: two } = db({ "count(*)": [{ n: 2 }] });
  await assert.rejects(
    new Names(two, zone, { perAccount: 2 }).set("acct-1", "chovy", "server3", { a: "1.1.1.1" }),
    /2 names/,
  );
});

test("what is not an address, and what is not a name, is a 400 before the zone is touched", async () => {
  const zone = new MemoryZone("nixamp.com");
  const { queryable } = db();
  const names = new Names(queryable, zone);
  await assert.rejects(
    names.set("acct-1", "chovy", "server2", { a: "2a01:4f8::1" }),
    (error: unknown) => error instanceof NameError && error.status === 400 && /IPv4/.test(error.message),
  );
  await assert.rejects(
    names.set("acct-1", "chovy", "server2", { aaaa: "1.1.1.1" }),
    (error: unknown) => error instanceof NameError && error.status === 400 && /IPv6/.test(error.message),
  );
  await assert.rejects(
    names.set("acct-1", "chovy", "www", { a: "1.1.1.1" }),
    (error: unknown) => error instanceof NameError && error.status === 400 && /not a name/.test(error.message),
  );
  // A new name with nothing to point at is not a name.
  await assert.rejects(
    names.set("acct-1", "chovy", "server2", {}),
    (error: unknown) => error instanceof NameError && error.status === 400 && /give an address/.test(error.message),
  );
  assert.equal(zone.records.length, 0);
});

test("null takes a family away, undefined leaves it, and the ttl is clamped", async () => {
  const zone = new MemoryZone("nixamp.com");
  await zone.set("server2.chovy.nixamp.com", "A", "152.53.47.37");
  await zone.set("server2.chovy.nixamp.com", "AAAA", "2a01:4f8::1");
  const { asked, queryable } = db({
    "WHERE handle = $1 AND label = $2": [ROW({ aaaa: "2a01:4f8::1" })],
  });
  const names = new Names(queryable, zone);

  // Only the ttl said: both addresses stay, the ttl is raised to the floor.
  await names.set("acct-1", "chovy", "server2", { ttl: 60 });
  let insert = asked.findLast((a) => a.text.includes("INSERT INTO dns_names"));
  assert.deepEqual(insert?.values, ["acct-1", "chovy", "server2", "152.53.47.37", "2a01:4f8::1", 600]);

  // The AAAA taken away: the zone loses it, the row records it gone.
  await names.set("acct-1", "chovy", "server2", { aaaa: null, ttl: 999_999 });
  assert.deepEqual(zone.records.map((r) => r.type), ["A"]);
  insert = asked.findLast((a) => a.text.includes("INSERT INTO dns_names"));
  assert.deepEqual(insert?.values, ["acct-1", "chovy", "server2", "152.53.47.37", "", 86_400]);
});

test("a registrar that refuses is a 502, and nothing is stored", async () => {
  const zone = new MemoryZone("nixamp.com");
  zone.set = async () => {
    throw new Error("Porkbun refused: Invalid domain.");
  };
  const { asked, queryable } = db();
  const names = new Names(queryable, zone);
  await assert.rejects(
    names.set("acct-1", "chovy", "server2", { a: "1.1.1.1" }),
    (error: unknown) => error instanceof NameError && error.status === 502 && /did not take that record/.test(error.message),
  );
  assert.equal(asked.some((a) => a.text.includes("INSERT INTO dns_names")), false);
});

test("removing a name clears the zone and the row, and only for its owner", async () => {
  const zone = new MemoryZone("nixamp.com");
  await zone.set("server2.chovy.nixamp.com", "A", "152.53.47.37");
  await zone.set("server2.chovy.nixamp.com", "AAAA", "2a01:4f8::1");

  const { asked, queryable } = db({ "WHERE handle = $1 AND label = $2": [ROW()] });
  const names = new Names(queryable, zone);
  assert.equal(await names.remove("acct-2", "chovy", "server2"), false, "not theirs");
  assert.equal(zone.records.length, 2);

  assert.equal(await names.remove("acct-1", "chovy", "server2"), true);
  assert.equal(zone.records.length, 0);
  const gone = asked.find((a) => a.text.includes("DELETE FROM dns_names"));
  assert.deepEqual(gone?.values, ["acct-1", "chovy", "server2"]);

  // Nothing there, or not a name at all, is false rather than an error.
  const { queryable: empty } = db();
  assert.equal(await new Names(empty, zone).remove("acct-1", "chovy", "nope"), false);
  assert.equal(await new Names(empty, zone).remove("acct-1", "chovy", "www"), false);
});

test("an account's names come back as hostnames, in the order they were made", async () => {
  const zone = new MemoryZone("nixamp.com");
  const { asked, queryable } = db({
    "ORDER BY created_at": [ROW(), ROW({ label: "server1", a: "104.152.209.195" })],
  });
  const names = new Names(queryable, zone);
  const list = await names.list("acct-1", "chovy");
  assert.deepEqual(list.map((n) => [n.host, n.a]), [
    ["server2.chovy.nixamp.com", "152.53.47.37"],
    ["server1.chovy.nixamp.com", "104.152.209.195"],
  ]);
  const query = asked.find((a) => a.text.includes("ORDER BY created_at"));
  assert.deepEqual(query?.values, ["acct-1", "chovy"]);
});

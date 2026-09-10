import { test } from "node:test";
import assert from "node:assert/strict";
import { Favorites, favoriteUrl } from "../src/favorites.ts";
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

test("a favourite is a server address, and only an address a browser can open", () => {
  assert.equal(favoriteUrl("https://server1.chovy.nixamp.com:4321"), "https://server1.chovy.nixamp.com:4321");
  assert.equal(favoriteUrl("  http://192.168.1.7:4321/view/abc  "), "http://192.168.1.7:4321/view/abc");
  assert.equal(favoriteUrl("ftp://x"), "");
  assert.equal(favoriteUrl("not a url"), "");
  assert.equal(favoriteUrl(42), "");
  assert.equal(favoriteUrl(`https://x.test/${"a".repeat(600)}`).length <= 500, true);
});

test("hearting keeps the address and the name, and hearting again keeps the newer name", async () => {
  const { asked, queryable, sql } = db();
  const favorites = new Favorites(queryable);
  assert.equal(await favorites.add("acct-1", "https://a.test:4321", "ubuntu"), true);
  assert.match(sql(), /CREATE TABLE IF NOT EXISTS favorites/);
  const insert = asked.find((a) => a.text.includes("INSERT INTO favorites"));
  assert.deepEqual(insert?.values, ["acct-1", "https://a.test:4321", "ubuntu"]);
  assert.match(insert?.text ?? "", /ON CONFLICT \(account_id, url\) DO UPDATE SET name/);

  // Nothing to heart with: no account, or not an address.
  assert.equal(await favorites.add("", "https://a.test", "x"), false);
  assert.equal(await favorites.add("acct-1", "nope", "x"), false);
});

test("the list comes back as names and addresses, oldest first, and one can be let go", async () => {
  const { asked, queryable } = db({
    "SELECT url, name, created_at": [
      { url: "https://a.test:4321", name: "ubuntu", created_at: "2026-09-10T09:00:00Z" },
      { url: "https://b.test:4321", name: "", created_at: "2026-09-10T09:05:00Z" },
    ],
  });
  const favorites = new Favorites(queryable);
  const list = await favorites.list("acct-1");
  assert.deepEqual(list.map((f) => [f.url, f.name]), [
    ["https://a.test:4321", "ubuntu"],
    ["https://b.test:4321", ""],
  ]);
  assert.ok(list[0]!.addedAt < list[1]!.addedAt);

  await favorites.remove("acct-1", "https://a.test:4321");
  const gone = asked.find((a) => a.text.includes("DELETE FROM favorites"));
  assert.deepEqual(gone?.values, ["acct-1", "https://a.test:4321"]);
});

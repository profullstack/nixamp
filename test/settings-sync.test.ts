import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, isSyncable } from "@profullstack/synconfig";
import { SettingsSync, SETTINGS_BODY_LIMIT } from "../src/settings-sync.ts";
import { SYNC_POLICY } from "../src/sync.ts";
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

test("what syncs is what you decided; credentials, the library path and one box's state never do", () => {
  assert.equal(isSyncable(SYNC_POLICY, "compression.json"), true);
  assert.equal(isSyncable(SYNC_POLICY, "channels.json"), true);
  for (const never of ["config.json", "session.json", "keys.json", "cookies.txt", "daemon.json", "tls/cert.pem", "catalogs/4321-abc.json", "relay-cache/x", "daemon.log", "../session.json"]) {
    assert.equal(isSyncable(SYNC_POLICY, never), false, `${never} must never sync`);
  }

  const dir = mkdtempSync(join(tmpdir(), "nixamp-sync-"));
  writeFileSync(join(dir, "compression.json"), '{"enabled":true}');
  writeFileSync(join(dir, "channels.json"), "[]");
  writeFileSync(join(dir, "session.json"), '{"token":"nxa_secret"}');
  mkdirSync(join(dir, "tls"));
  writeFileSync(join(dir, "tls", "key.pem"), "PRIVATE");
  const { snapshot, skipped } = collectSnapshot(dir, SYNC_POLICY, { host: "laptop", app: "nixamp 0.23.0" });
  assert.deepEqual(Object.keys(snapshot.files).sort(), ["channels.json", "compression.json"]);
  assert.deepEqual(skipped, []);
  assert.ok(!JSON.stringify(snapshot).includes("nxa_secret"), "the session reached the snapshot");
  assert.ok(existsSync(join(dir, "tls", "key.pem")));
});

test("the store keeps revisions against the account, and one statement picks the next one", async () => {
  const { asked, queryable, sql } = db({ "RETURNING revision": [{ revision: 1, created_at: "2026-09-13T02:00:00.000Z" }] });
  const sync = new SettingsSync(queryable);
  const body = { version: 1 as const, host: "laptop", app: "nixamp 0.23.0", files: { "compression.json": { content: "{}" } } };
  const put = await sync.handle("PUT", "/api/v1/settings", "acct-1", { snapshot: body, ifRevision: null });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body["revision"], 1);
  assert.match(sql(), /CREATE TABLE IF NOT EXISTS settings_snapshots/);
  const insert = asked.find((a) => a.text.includes("INSERT INTO settings_snapshots"));
  assert.ok(insert, "an insert went to the database");
  assert.match(insert!.text, /COALESCE\(MAX\(revision\), 0\) \+ 1/);
  assert.match(insert!.text, /HAVING \$7::int IS NULL OR COALESCE\(MAX\(revision\), 0\) = \$7::int/);
  assert.equal(insert!.values[0], "acct-1");
  assert.equal(insert!.values[6], null, "a first save carries no precondition");
  const prune = asked.find((a) => a.text.includes("DELETE FROM settings_snapshots"));
  assert.deepEqual(prune?.values, ["acct-1", 1 - 10]);
});

test("an empty account is a 200 with empty: true, a stale save a 409 with the current revision, a bad body a 400", async () => {
  const empty = new SettingsSync(db().queryable);
  const got = await empty.handle("GET", "/api/v1/settings", "acct-1", undefined);
  assert.equal(got.status, 200);
  assert.equal(got.body["empty"], true);

  // The account is at revision 2; a save that last saw 1 is refused, and the insert answers no row.
  const stale = new SettingsSync(
    db({
      "ORDER BY revision DESC LIMIT 1": [{ revision: 2, digest: "d2", host: "desktop", version: "nixamp 0.23.0", size: 10, body: { version: 1, files: {} }, created_at: "2026-09-13T02:00:00.000Z" }],
    }).queryable,
  );
  const refused = await stale.handle("PUT", "/api/v1/settings", "acct-1", { snapshot: { version: 1, host: "laptop", app: "n", files: { "channels.json": { content: "[]" } } }, ifRevision: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body["revision"], 2);

  const bad = await empty.handle("PUT", "/api/v1/settings", "acct-1", { snapshot: { version: 1, files: { "../x": { content: "" } } } });
  assert.equal(bad.status, 400);
  assert.equal((await empty.handle("DELETE", "/api/v1/settings", "acct-1", undefined)).status, 405);
  assert.equal((await empty.handle("GET", "/api/v1/settings/revisions", "acct-1", undefined)).status, 200);
  assert.ok(SETTINGS_BODY_LIMIT > 64 * 1024, "a snapshot is bigger than the API's usual body");
});

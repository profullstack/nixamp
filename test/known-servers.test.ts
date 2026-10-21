import { test } from "node:test";
import assert from "node:assert/strict";
import { KnownServers } from "../src/known-servers.ts";

test("listed servers are remembered across a restart, for a day", async () => {
  const table = new Map<string, { owner_id: string; seen_at: Date }>();
  let now = Date.UTC(2026, 9, 21, 12);
  const db = {
    async query(text: string, params: unknown[] = []) {
      if (text.startsWith("CREATE")) return { rows: [] };
      if (text.startsWith("INSERT")) { table.set(String(params[0]), { owner_id: String(params[1]), seen_at: new Date(now) }); return { rows: [] }; }
      if (text.startsWith("SELECT")) {
        const since = (params[0] as Date).getTime();
        return { rows: [...table].filter(([, row]) => row.seen_at.getTime() > since).map(([base, row]) => ({ base, ...row })) };
      }
      throw new Error(`unexpected ${text}`);
    },
  };
  await new KnownServers(db, () => now).sync([{ base: "https://a.example:4321", ownerId: "u1" }, { base: "", ownerId: "u2" }]);
  const after = new KnownServers(db, () => now);
  assert.deepEqual(after.list(), []);
  await after.load();
  assert.deepEqual(after.list().map((one) => [one.base, one.ownerId]), [["https://a.example:4321", "u1"]]);
  now += 25 * 60 * 60 * 1000;
  assert.deepEqual(after.list(), [], "gone after a day unseen");
});

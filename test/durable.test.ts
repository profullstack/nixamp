import { test } from "node:test";
import assert from "node:assert/strict";
import { Durable, type StoredEnded } from "../src/durable.ts";
import { Directory, type Ended } from "../src/directory.ts";
import { PartyLine } from "../src/partyline.ts";
import type { Queryable } from "../src/follows.ts";

/** A database that records what it was asked, and can be told to break. */
function db(
  answers: Record<string, Record<string, unknown>[]> = {},
  breaks: string[] = [],
) {
  const asked: { text: string; values: unknown[] }[] = [];
  const queryable: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      for (const needle of breaks) {
        if (text.includes(needle)) throw new Error("the database is having a moment");
      }
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows };
      }
      return { rows: [] };
    },
  };
  return { asked, queryable };
}

const NOW = 1_788_928_020_000;

const stored = (over: Partial<StoredEnded> = {}): StoredEnded => ({
  id: "s1",
  code: "482917",
  name: "Chovy",
  ownerId: "owner-1",
  url: "https://a.example/listen",
  nowPlaying: "Top Gun: Maverick",
  startedAt: NOW - 3_600_000,
  endedAt: NOW,
  ...over,
});

test("taking reminders deletes and returns in one statement", async () => {
  const { asked, queryable } = db({
    "DELETE FROM stream_reminders": [{ phone: "+14155550123" }, { phone: "+14155550124" }],
  });

  const phones = await new Durable(queryable).takeReminders("482917");
  assert.deepEqual(phones, ["+14155550123", "+14155550124"]);

  // A select and then a delete would let two goings-live read the same list
  // and text everybody twice.
  const take = asked.find((a) => a.text.includes("DELETE FROM stream_reminders"));
  assert.match(take?.text ?? "", /RETURNING phone/);
  assert.deepEqual(take?.values, ["482917"]);
});

test("a database having a moment costs the durability, not the feature", async () => {
  const { queryable } = db({}, ["INSERT INTO stream_reminders", "INSERT INTO ended_streams"]);
  const said: string[] = [];
  const durable = new Durable(queryable, (m) => said.push(m));

  // Neither throws: the request is answered from memory, so a write that
  // cannot land should not take the call down with it.
  await durable.addReminder("482917", "+14155550123");
  await durable.saveEnded(stored());
  assert.equal(said.length, 2, "but it does say so");
  assert.match(said[0] ?? "", /did not persist/);
});

test("a big number comes back as a number, not the string pg hands over", async () => {
  // BIGINT arrives as a string, which sorts and compares nothing like a number
  // -- and these are timestamps every "did it end before X" decision reads.
  const { queryable } = db({
    "SELECT * FROM ended_streams": [{
      id: "s1", code: "482917", name: "Chovy", owner_id: "o1",
      url: "u", now_playing: "x",
      started_at: String(NOW - 1000), ended_at: String(NOW),
    }],
  });

  const [item] = await new Durable(queryable).loadEnded(0);
  assert.equal(typeof item?.endedAt, "number");
  assert.equal(item?.endedAt, NOW);
  assert.ok((item?.endedAt ?? 0) > (item?.startedAt ?? 0));
});

test("reminders come back grouped by the code they were left on", async () => {
  const { queryable } = db({
    "SELECT code, phone": [
      { code: "482917", phone: "+14155550123" },
      { code: "482917", phone: "+14155550124" },
      { code: "111111", phone: "+14155550125" },
      { code: "", phone: "+14155550126" },
    ],
  });

  const waiting = await new Durable(queryable).loadReminders();
  assert.equal(waiting.get("482917")?.size, 2);
  assert.equal(waiting.get("111111")?.size, 1);
  assert.equal(waiting.has(""), false, "a row with no code is not a reminder");
});

// --- what the restart actually costs, and no longer does -------------------

test("an ended stream is echoed as it is remembered, and dropped when it returns", () => {
  const saved: Ended[] = [];
  const dropped: string[] = [];
  let at = NOW;
  const dir = new Directory(4 * 60 * 1000, () => at, () => "482917");
  dir.persistTo({ save: (i) => void saved.push(i), drop: (id) => void dropped.push(id) });

  const live = dir.announce(
    { name: "Chovy", url: "https://a.example/v/1", tracks: () => 1, nowPlaying: "x" },
    "owner-1",
  );

  at += 5 * 60 * 1000;
  dir.list(); // the sweep is what notices it stopped
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.code, live.code);
  assert.equal(saved[0]?.ownerId, "owner-1");

  // It came back, so the row is no longer something to tell a caller about.
  dir.announce({ name: "Chovy", url: "https://a.example/v/1", tracks: () => 1, nowPlaying: "x" }, "owner-1");
  assert.deepEqual(dropped, [live.id]);
});

test("a restarted process remembers the streams that had ended", () => {
  const dir = new Directory(4 * 60 * 1000, () => NOW, () => "999999");

  // What a previous process wrote, read back at boot.
  dir.seedEnded([{
    id: "s-old", code: "482917", name: "Chovy", url: "https://a.example/v/1",
    ownerId: "owner-1", nowPlaying: "Top Gun: Maverick",
    startedAt: NOW - 3_600_000, endedAt: NOW - 60_000,
  }]);

  // The phone line can answer again, and the directory has somebody to follow.
  assert.equal(dir.endedByCode("482917")?.name, "Chovy");
  assert.equal(dir.recentlyEnded().length, 1);
  assert.equal(dir.nameOf("owner-1"), "Chovy");
});

test("seeding never overwrites what this process already knows", () => {
  let at = NOW;
  const dir = new Directory(4 * 60 * 1000, () => at, () => "482917");
  dir.announce({ name: "Fresh", url: "https://a.example/v/1", tracks: () => 1, nowPlaying: "" }, "o1");
  at += 5 * 60 * 1000;
  dir.list();

  const before = dir.endedByCode("482917")?.name;
  dir.seedEnded([{
    id: dir.recentlyEnded()[0]!.id, code: "482917", name: "Stale", url: "https://a.example/v/1",
    ownerId: "o1", nowPlaying: "", startedAt: 1, endedAt: 2,
  }]);
  assert.equal(dir.endedByCode("482917")?.name, before, "a row from before the restart is older");
});

test("a caller promised a text before a restart is still texted after one", async () => {
  const sent: { to: string; text: string }[] = [];
  const taken: string[] = [];
  const party = new PartyLine({
    apiKey: "k",
    publicKey: "",
    now: () => NOW,
    fetch: (async () => ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response) as unknown as typeof globalThis.fetch,
    sms: { send: async (to, text) => (sent.push({ to, text }), true) },
  });

  // This process never heard the call. The promise was made by the one before.
  party.persistRemindersTo(
    {
      add: () => {},
      take: async (code) => (taken.push(code), ["+14155550199"]),
    },
    new Map([["482917", new Set(["+14155550123"])]]),
  );
  assert.equal(party.waitingOn("482917"), 1, "the seeded one is waiting");

  const count = await party.wentLive({ code: "482917", name: "Chovy", nowPlaying: "Top Gun" });

  // Both: the one seeded at boot and the one the store still held.
  assert.equal(count, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ["+14155550123", "+14155550199"]);
  assert.deepEqual(taken, ["482917"]);
  assert.equal(party.waitingOn("482917"), 0, "and nobody is owed it twice");
});

test("pressing 1 echoes the number somewhere it will survive", async () => {
  const added: { code: string; phone: string }[] = [];
  const calls: string[] = [];
  const party = new PartyLine({
    apiKey: "k",
    publicKey: "",
    now: () => NOW,
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof globalThis.fetch,
    streams: {
      liveByCode: () => undefined,
      endedByCode: () => ({ name: "Chovy", nowPlaying: "x", startedAt: 1, endedAt: NOW }),
    },
  });
  party.persistRemindersTo({
    add: (code, phone) => void added.push({ code, phone }),
    take: async () => [],
  });

  await party.handle({
    event_type: "call.initiated",
    payload: { call_control_id: "leg-1", direction: "incoming", from: "+14155550123" },
  });
  await party.handle({ event_type: "call.gather.ended", payload: { call_control_id: "leg-1", digits: "482917" } });
  await party.handle({ event_type: "call.gather.ended", payload: { call_control_id: "leg-1", digits: "1" } });

  assert.deepEqual(added, [{ code: "482917", phone: "+14155550123" }]);
});

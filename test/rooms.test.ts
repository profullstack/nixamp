import { test } from "node:test";
import assert from "node:assert/strict";
import type { Queryable } from "../src/follows.ts";
import { RoomError, Rooms } from "../src/rooms.ts";

function roomDatabase() {
  const asked: Array<{ text: string; values: unknown[] }> = [];
  const database: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      if (text.includes("INSERT INTO live_event_chat")) {
        return { rows: [{
          id: values[0], event_id: values[1], author_id: values[2], author_name: values[3], body: values[4],
          created_at: "2026-09-11T12:00:00.000Z", deleted_at: null,
        }] };
      }
      if (text.includes("INSERT INTO live_event_hand_raises")) {
        return { rows: [{
          event_id: values[0], account_id: values[1], display_name: values[2], state: "raised",
          raised_at: "2026-09-11T12:00:00.000Z", updated_at: "2026-09-11T12:00:00.000Z",
        }] };
      }
      return { rows: [] };
    },
  };
  return { asked, database };
}

test("chat is durable room state with bounded, cleaned messages", async () => {
  const { asked, database } = roomDatabase();
  const rooms = new Rooms(database);
  const message = await rooms.post("event-1", "user-1", "Sarah", "  hello\nclass  ");
  assert.equal(message.body, "hello class");
  assert.equal(message.authorName, "Sarah");
  assert.equal(asked.filter((query) => query.text.includes("CREATE TABLE")).length, 1);
  await assert.rejects(() => rooms.post("event-1", "user-1", "Sarah", "x".repeat(1001)), /too long/);
});

test("raising a hand is idempotent and returns it to the queue", async () => {
  const { asked, database } = roomDatabase();
  const rooms = new Rooms(database);
  const raised = await rooms.raiseHand("event-1", "user-1", "James");
  assert.equal(raised.state, "raised");
  const insert = asked.find((query) => query.text.includes("INSERT INTO live_event_hand_raises"));
  assert.match(insert?.text ?? "", /ON CONFLICT \(event_id, account_id\) DO UPDATE/);
});

test("participation requires a NixAmp identity", async () => {
  const { database } = roomDatabase();
  const rooms = new Rooms(database);
  await assert.rejects(
    () => rooms.raiseHand("event-1", "", "Anonymous"),
    (error: unknown) => error instanceof RoomError && error.status === 401,
  );
});

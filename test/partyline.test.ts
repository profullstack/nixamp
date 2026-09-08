import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { PartyLine, roomNameFrom, sameSecret } from "../src/partyline.ts";

/** An ed25519 pair standing in for the account's, so a test can sign. */
function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, publicKey: raw.toString("base64") };
}

function signed(privateKey: ReturnType<typeof keys>["privateKey"], body: string, timestamp: string) {
  return signMessage(null, Buffer.from(`${timestamp}|${body}`, "utf8"), privateKey).toString("base64");
}

/** A fetch that records what Telnyx was asked and answers however a test says. */
function recorder(reply: (path: string, body: unknown) => { ok: boolean; json?: unknown } = () => ({ ok: true })) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.telnyx.com/v2", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = reply(path, body);
    return {
      ok: answer.ok,
      status: answer.ok ? 200 : 422,
      text: async () => JSON.stringify(answer.json ?? {}),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

/** Telnyx answers a conference creation with its id; everything else is empty. */
const conferenceReplies = (id = "conf-1") => (path: string) =>
  path === "/conferences" ? { ok: true, json: { data: { id } } } : { ok: true };

const NOW = 1_700_000_000_000;

function line(fetch: typeof globalThis.fetch, publicKey = "", extra: Record<string, unknown> = {}) {
  return new PartyLine({ apiKey: "KEY_test", publicKey, fetch, now: () => NOW, ...extra });
}

test("what a caller said becomes one room name however they said it", () => {
  assert.equal(roomNameFrom("blue"), "blue");
  // The filler around a name is not part of it, or two people meaning the
  // same room would land in two.
  assert.equal(roomNameFrom("uh, the blue room please"), "blue");
  assert.equal(roomNameFrom("I want to join the green room"), "green");
  assert.equal(roomNameFrom("Blue!"), "blue");
  assert.equal(roomNameFrom("late night radio"), "late-night-radio");
  // A dialled 818 and a spoken "818" have to be the same place.
  assert.equal(roomNameFrom("818"), "818");
  assert.equal(roomNameFrom("a".repeat(80)).length, 40);
  // Nothing usable is nothing, not an empty room called "".
  assert.equal(roomNameFrom("the room"), "");
  assert.equal(roomNameFrom(""), "");
  assert.equal(roomNameFrom(undefined), "");
  assert.equal(roomNameFrom(42), "");
  assert.equal(roomNameFrom(null, "lobby"), "lobby");
});

test("a webhook is only believed when Telnyx signed it", () => {
  const { privateKey, publicKey } = keys();
  const party = line(recorder().fetch, publicKey);
  const body = JSON.stringify({ data: { event_type: "call.answered" } });
  const ts = String(Math.floor(NOW / 1000));

  assert.equal(party.armed, true);
  assert.equal(party.verify(body, signed(privateKey, body, ts), ts), true);

  // A body edited after signing is the attack this exists to stop.
  assert.equal(party.verify(body + " ", signed(privateKey, body, ts), ts), false);
  // Somebody else's key.
  assert.equal(party.verify(body, signed(keys().privateKey, body, ts), ts), false);
  // Missing pieces.
  assert.equal(party.verify(body, undefined, ts), false);
  assert.equal(party.verify(body, signed(privateKey, body, ts), undefined), false);
  assert.equal(party.verify(body, "not-base64-64-bytes", ts), false);
  assert.equal(party.verify(body, signed(privateKey, body, ts), "nonsense"), false);
});

test("a signature from too long ago is a replay, in either direction", () => {
  const { privateKey, publicKey } = keys();
  const party = line(recorder().fetch, publicKey);
  const body = JSON.stringify({ data: {} });

  const old = String(Math.floor((NOW - 10 * 60 * 1000) / 1000));
  assert.equal(party.verify(body, signed(privateKey, body, old), old), false);

  // A forgery with a clock ahead of ours is no better than one behind.
  const ahead = String(Math.floor((NOW + 10 * 60 * 1000) / 1000));
  assert.equal(party.verify(body, signed(privateKey, body, ahead), ahead), false);

  const fresh = String(Math.floor((NOW - 60 * 1000) / 1000));
  assert.equal(party.verify(body, signed(privateKey, body, fresh), fresh), true);
});

test("without a public key nothing is believed", () => {
  const party = line(recorder().fetch, "");
  assert.equal(party.armed, false);
  assert.equal(party.verify("{}", "x", "1"), false);
  // A key of the wrong size is a misconfiguration, not a usable key.
  assert.equal(line(recorder().fetch, Buffer.alloc(16).toString("base64")).armed, false);
});

test("an inbound call is answered and asked which room, by voice", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch);

  await party.handle({
    event_type: "call.initiated",
    payload: { call_control_id: "leg-1", direction: "incoming" },
  });
  assert.deepEqual(calls.map((c) => c.path), ["/calls/leg-1/actions/answer"]);

  await party.handle({ event_type: "call.answered", payload: { call_control_id: "leg-1" } });
  const ask = calls[1];
  assert.equal(ask?.path, "/calls/leg-1/actions/gather_using_ai");
  // Speech, not the keypad: gather_using_speak would read the prompt aloud
  // and then wait for digits.
  assert.match(String(ask?.body["greeting"]), /room/i);
  assert.deepEqual((ask?.body["parameters"] as Record<string, unknown>)["required"], ["room"]);
});

test("an outbound leg is not somebody calling in", async () => {
  const { calls, fetch } = recorder();
  await line(fetch).handle({
    event_type: "call.initiated",
    payload: { call_control_id: "leg-1", direction: "outgoing" },
  });
  assert.deepEqual(calls, []);
});

test("the first caller opens the room and the second joins it", async () => {
  const { calls, fetch } = recorder(conferenceReplies("conf-blue"));
  const party = line(fetch);

  await party.handle({
    event_type: "call.ai_gather.ended",
    payload: { call_control_id: "leg-1", result: { room: "the blue room" } },
  });
  const created = calls.find((c) => c.path === "/conferences");
  assert.ok(created, "the first caller creates the conference");
  assert.equal(created?.body["call_control_id"], "leg-1");
  assert.match(String(created?.body["name"]), /^partyline-blue-/);
  assert.deepEqual(party.list(), [
    { name: "blue", conferenceId: "conf-blue", callers: 1, startedAt: NOW },
  ]);

  await party.handle({
    event_type: "call.ai_gather.ended",
    payload: { call_control_id: "leg-2", result: { room: "blue" } },
  });
  assert.ok(
    calls.some((c) => c.path === "/conferences/conf-blue/actions/join" && c.body["call_control_id"] === "leg-2"),
    "the second caller joins rather than opening a second room",
  );
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 1);
  assert.equal(party.list()[0]?.callers, 2);
});

test("two names are two rooms", async () => {
  let n = 0;
  const { fetch } = recorder((path) =>
    path === "/conferences" ? { ok: true, json: { data: { id: `conf-${++n}` } } } : { ok: true },
  );
  const party = line(fetch);

  await party.handle({ event_type: "call.gather.ended", payload: { call_control_id: "a", digits: "818" } });
  await party.handle({ event_type: "call.gather.ended", payload: { call_control_id: "b", digits: "909" } });

  assert.deepEqual(party.list().map((r) => r.name).sort(), ["818", "909"]);
  assert.deepEqual(party.list().map((r) => r.callers), [1, 1]);
});

test("hanging up empties the room, and an empty room stops existing", async () => {
  const { fetch } = recorder(conferenceReplies());
  const party = line(fetch);

  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-1", result: { room: "blue" } } });
  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-2", result: { room: "blue" } } });
  assert.equal(party.list()[0]?.callers, 2);

  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "leg-2" } });
  assert.equal(party.list()[0]?.callers, 1);

  await party.handle({ event_type: "conference.participant.left", payload: { call_control_id: "leg-1" } });
  // Telnyx ends an empty conference itself, so keeping the name would only
  // hand the next caller a dead id.
  assert.deepEqual(party.list(), []);

  // A leg we never placed is not an error.
  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "never-seen" } });
  assert.deepEqual(party.list(), []);
});

test("the same leg twice is still one caller", async () => {
  const { fetch } = recorder(conferenceReplies());
  const party = line(fetch);
  const event = { event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-1", result: { room: "blue" } } };
  await party.handle(event);
  await party.handle(event);
  assert.equal(party.list()[0]?.callers, 1);
});

test("a room that did not catch the name asks again instead of guessing", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch);

  await party.handle({
    event_type: "call.ai_gather.ended",
    payload: { call_control_id: "leg-1", result: { room: "uh, the room" } },
  });

  assert.equal(calls[0]?.path, "/calls/leg-1/actions/speak");
  assert.equal(calls[1]?.path, "/calls/leg-1/actions/gather_using_ai");
  // Nothing was opened on a name we could not read.
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 0);
});

test("an account without AI gather still answers, on the keypad", async () => {
  const { calls, fetch } = recorder((path) => ({ ok: !path.endsWith("gather_using_ai") }));
  await line(fetch).handle({ event_type: "call.answered", payload: { call_control_id: "leg-1" } });

  assert.equal(calls[0]?.path, "/calls/leg-1/actions/gather_using_ai");
  const fallback = calls[1];
  assert.equal(fallback?.path, "/calls/leg-1/actions/gather_using_speak");
  assert.equal(fallback?.body["terminating_digit"], "#");
});

test("a full room turns a caller away rather than billing for them", async () => {
  const { calls, fetch } = recorder(conferenceReplies());
  const party = line(fetch, "", { maxParticipants: 1 });

  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-1", result: { room: "blue" } } });
  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-2", result: { room: "blue" } } });

  assert.equal(party.list()[0]?.callers, 1);
  assert.ok(calls.some((c) => c.path === "/calls/leg-2/actions/hangup"));
  assert.ok(calls.some((c) => c.path === "/conferences" && c.body["max_participants"] === 1));
});

test("a conference Telnyx has already discarded is remade, not joined forever", async () => {
  let n = 0;
  // The join fails the way a four-hour-old conference does.
  const { calls, fetch } = recorder((path) =>
    path === "/conferences"
      ? { ok: true, json: { data: { id: `conf-${++n}` } } }
      : { ok: !path.includes("/actions/join") },
  );
  const party = line(fetch);

  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-1", result: { room: "blue" } } });
  assert.equal(party.list()[0]?.conferenceId, "conf-1");

  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-2", result: { room: "blue" } } });
  // It tried the id it had, was told no, and opened a new one rather than
  // dropping the caller.
  assert.ok(calls.some((c) => c.path === "/conferences/conf-1/actions/join"));
  assert.equal(party.list()[0]?.conferenceId, "conf-2");
  assert.equal(party.list()[0]?.callers, 2);
});

test("a caller is not left on a silent line when the room cannot be opened", async () => {
  const { calls, fetch } = recorder((path) => ({ ok: path !== "/conferences" }));
  const party = line(fetch);

  await party.handle({ event_type: "call.ai_gather.ended", payload: { call_control_id: "leg-1", result: { room: "blue" } } });

  assert.ok(calls.some((c) => c.path === "/calls/leg-1/actions/speak"));
  assert.ok(calls.some((c) => c.path === "/calls/leg-1/actions/hangup"));
  assert.deepEqual(party.list(), []);
});

test("an event without a leg, or of a kind we do not run, does nothing", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch);
  await party.handle({ event_type: "call.answered", payload: {} });
  await party.handle({ event_type: "call.machine.detection.ended", payload: { call_control_id: "leg-1" } });
  await party.handle({});
  assert.deepEqual(calls, []);
});

test("a secret is compared without leaking how much of it matched", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), true);
});

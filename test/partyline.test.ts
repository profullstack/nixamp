import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { CODE_LENGTH, PartyLine, roomCodeFrom, sameSecret, spokenCode } from "../src/partyline.ts";

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

/** Keying a code, as Telnyx reports it. */
const keyed = (leg: string, digits: string) => ({
  event_type: "call.gather.ended",
  payload: { call_control_id: leg, digits },
});

test("a room code is exactly six digits or it is not a code", () => {
  assert.equal(CODE_LENGTH, 6);
  assert.equal(roomCodeFrom("482917"), "482917");
  // Leading zeros survive: 048291 is a room, not the number 48291.
  assert.equal(roomCodeFrom("048291"), "048291");
  // What a keypad or a URL might wrap around it.
  assert.equal(roomCodeFrom("482-917"), "482917");
  assert.equal(roomCodeFrom(" 482 917 "), "482917");
  assert.equal(roomCodeFrom("#482917#"), "482917");
  assert.equal(roomCodeFrom(482917), "482917");

  // Five digits is a different room, not this one missing a digit. Guessing
  // which they meant would put somebody in a stranger's conversation.
  assert.equal(roomCodeFrom("48291"), "");
  assert.equal(roomCodeFrom("4829177"), "");
  assert.equal(roomCodeFrom(""), "");
  assert.equal(roomCodeFrom("abcdef"), "");
  assert.equal(roomCodeFrom(undefined), "");
  assert.equal(roomCodeFrom(null), "");
  assert.equal(roomCodeFrom({}), "");
});

test("a code is read back one digit at a time", () => {
  // "482917" spoken as a number is four hundred eighty-two thousand…, which is
  // not a code anybody can write down.
  assert.equal(spokenCode("482917"), "4, 8, 2, 9, 1, 7");
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
  assert.equal(party.verify(body, signed(keys().privateKey, body, ts), ts), false);
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

  const ahead = String(Math.floor((NOW + 10 * 60 * 1000) / 1000));
  assert.equal(party.verify(body, signed(privateKey, body, ahead), ahead), false);

  const fresh = String(Math.floor((NOW - 60 * 1000) / 1000));
  assert.equal(party.verify(body, signed(privateKey, body, fresh), fresh), true);
});

test("without a public key nothing is believed", () => {
  const party = line(recorder().fetch, "");
  assert.equal(party.armed, false);
  assert.equal(party.verify("{}", "x", "1"), false);
  assert.equal(line(recorder().fetch, Buffer.alloc(16).toString("base64")).armed, false);
});

test("an inbound call is answered and asked for a code, on the keypad", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch);

  await party.handle({
    event_type: "call.initiated",
    payload: { call_control_id: "leg-1", direction: "incoming" },
  });
  assert.deepEqual(calls.map((c) => c.path), ["/calls/leg-1/actions/answer"]);

  await party.handle({ event_type: "call.answered", payload: { call_control_id: "leg-1" } });
  const ask = calls[1];
  // The keypad, not speech. One digit misheard is a different room that also
  // exists, and nothing would tell the caller they went wrong.
  assert.equal(ask?.path, "/calls/leg-1/actions/gather_using_speak");
  assert.equal(ask?.body["minimum_digits"], 6);
  assert.equal(ask?.body["maximum_digits"], 6);
  assert.equal(ask?.body["valid_digits"], "0123456789");
  assert.match(String(ask?.body["payload"]), /six digit/i);
  assert.ok(!calls.some((c) => c.path.endsWith("gather_using_ai")));
});

test("an outbound leg is not somebody calling in", async () => {
  const { calls, fetch } = recorder();
  await line(fetch).handle({
    event_type: "call.initiated",
    payload: { call_control_id: "leg-1", direction: "outgoing" },
  });
  assert.deepEqual(calls, []);
});

test("the first caller opens the room and the second lands in it", async () => {
  const { calls, fetch } = recorder(conferenceReplies("conf-482917"));
  const party = line(fetch);

  await party.handle(keyed("leg-1", "482917"));
  const created = calls.find((c) => c.path === "/conferences");
  assert.ok(created, "the first caller creates the conference");
  assert.equal(created?.body["call_control_id"], "leg-1");
  assert.deepEqual(party.list(), [{ callers: 1, startedAt: NOW }]);

  await party.handle(keyed("leg-2", "482917"));
  assert.ok(
    calls.some(
      (c) => c.path === "/conferences/conf-482917/actions/join" && c.body["call_control_id"] === "leg-2",
    ),
    "the second caller joins rather than opening a second room",
  );
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 1);
  assert.equal(party.list()[0]?.callers, 2);
});

test("the code never appears in what Telnyx or the public can see", async () => {
  const { calls, fetch } = recorder(conferenceReplies());
  const party = line(fetch);
  await party.handle(keyed("leg-1", "482917"));

  // The rooms listing is served to anyone who asks. A live code in it would be
  // a door with the key taped to it.
  assert.deepEqual(Object.keys(party.list()[0] ?? {}).sort(), ["callers", "startedAt"]);
  assert.ok(!JSON.stringify(party.list()).includes("482917"));

  // Telnyx lists conferences in a dashboard we do not control, so the code is
  // not the conference name either.
  const created = calls.find((c) => c.path === "/conferences");
  assert.ok(!String(created?.body["name"]).includes("482917"));
});

test("two codes are two rooms", async () => {
  let n = 0;
  const { fetch } = recorder((path) =>
    path === "/conferences" ? { ok: true, json: { data: { id: `conf-${++n}` } } } : { ok: true },
  );
  const party = line(fetch);

  await party.handle(keyed("a", "111111"));
  await party.handle(keyed("b", "222222"));
  assert.deepEqual(party.list().map((r) => r.callers), [1, 1]);
});

test("a code that is not six digits is re-asked, never guessed at", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch);

  await party.handle(keyed("leg-1", "4829"));

  const reask = calls.find((c) => c.path === "/calls/leg-1/actions/gather_using_speak");
  assert.ok(reask, "it asks again");
  assert.match(String(reask?.body["payload"]), /not a six digit code/i);
  // Nothing was opened on a code we could not read.
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 0);
  assert.deepEqual(party.list(), []);
});

test("hanging up empties the room, and an empty room stops existing", async () => {
  const { fetch } = recorder(conferenceReplies());
  const party = line(fetch);

  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-2", "482917"));
  assert.equal(party.list()[0]?.callers, 2);

  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "leg-2" } });
  assert.equal(party.list()[0]?.callers, 1);

  await party.handle({ event_type: "conference.participant.left", payload: { call_control_id: "leg-1" } });
  assert.deepEqual(party.list(), []);

  // A leg we never placed is not an error.
  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "never-seen" } });
  assert.deepEqual(party.list(), []);
});

test("the same leg twice is still one caller", async () => {
  const { fetch } = recorder(conferenceReplies());
  const party = line(fetch);
  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-1", "482917"));
  assert.equal(party.list()[0]?.callers, 1);
});

test("a full room turns a caller away rather than billing for them", async () => {
  const { calls, fetch } = recorder(conferenceReplies());
  const party = line(fetch, "", { maxParticipants: 1 });

  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-2", "482917"));

  assert.equal(party.list()[0]?.callers, 1);
  assert.ok(calls.some((c) => c.path === "/calls/leg-2/actions/hangup"));
  assert.ok(calls.some((c) => c.path === "/conferences" && c.body["max_participants"] === 1));
});

test("a conference Telnyx has already discarded is remade, not joined forever", async () => {
  let n = 0;
  const { calls, fetch } = recorder((path) =>
    path === "/conferences"
      ? { ok: true, json: { data: { id: `conf-${++n}` } } }
      : { ok: !path.includes("/actions/join") },
  );
  const party = line(fetch);

  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-2", "482917"));

  assert.ok(calls.some((c) => c.path === "/conferences/conf-1/actions/join"));
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 2);
  assert.equal(party.list()[0]?.callers, 2);
});

test("a caller is not left on a silent line when the room cannot be opened", async () => {
  const { calls, fetch } = recorder((path) => ({ ok: path !== "/conferences" }));
  const party = line(fetch);

  await party.handle(keyed("leg-1", "482917"));

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import {
  CODE_LENGTH,
  pacificTime,
  PartyLine,
  roomCodeFrom,
  sameSecret,
  spokenCode,
  telnyxSms,
} from "../src/partyline.ts";
import { optInPage } from "../src/optin.ts";

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
  assert.deepEqual(party.list(), [{ code: "482917", callers: 1, startedAt: NOW }]);

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

test("the listing publishes the code, because a listing you cannot dial is nothing", async () => {
  const { calls, fetch } = recorder(conferenceReplies());
  const party = line(fetch);
  await party.handle(keyed("leg-1", "482917"));

  // This is a public call-in line, not a private room. The code is how you
  // join, so withholding it would leave a list nobody can act on.
  assert.deepEqual(Object.keys(party.list()[0] ?? {}).sort(), ["callers", "code", "startedAt"]);
  assert.equal(party.list()[0]?.code, "482917");

  // Still not the Telnyx conference name, which is a different concern: that
  // is a label in somebody else's dashboard, and it should not be load-bearing.
  const created = calls.find((c) => c.path === "/conferences");
  assert.ok(!String(created?.body["name"]).includes("482917"));
});

test("phone listeners on a stream are counted, so the directory can say how many", async () => {
  const { fetch } = recorder();
  const live = {
    name: "Chovy",
    url: "https://chovy.example/listen.mp3",
    nowPlaying: "Top Gun: Maverick",
    startedAt: NINE_TWENTY_SEVEN,
  };
  const party = line(fetch, "", { streams: streams({ "482917": live }) });

  assert.equal(party.listenersOn("482917"), 0);
  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-2", "482917"));
  assert.equal(party.listenersOn("482917"), 2);

  // A listener is a leg with audio playing, not a conference member, so
  // nothing else was counting them.
  assert.deepEqual(party.list(), [], "a stream is not a room");

  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "leg-1" } });
  assert.equal(party.listenersOn("482917"), 1);
  await party.handle({ event_type: "call.hangup", payload: { call_control_id: "leg-2" } });
  assert.equal(party.listenersOn("482917"), 0);
});

test("a leg that never started playing is not counted as listening", async () => {
  // Telnyx refused the playback: nobody is hearing anything, and the directory
  // would be lying if it said somebody was.
  const { fetch } = recorder((path) => ({ ok: !path.endsWith("playback_start") }));
  const party = line(fetch, "", {
    streams: streams({
      "482917": { name: "Chovy", url: "https://x.example/a.mp3", nowPlaying: "", startedAt: 1 },
    }),
  });
  await party.handle(keyed("leg-1", "482917"));
  assert.equal(party.listenersOn("482917"), 0);
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


// --- the phone line as a way into a stream ---------------------------------

/** 9:27 PM Pacific, the time in the line this was built to say. */
const NINE_TWENTY_SEVEN = 1_788_928_020_000;

/** A directory of exactly the streams a test describes. */
function streams(
  live: Record<string, { name: string; url: string; nowPlaying: string; startedAt: number }> = {},
  ended: Record<string, { name: string; nowPlaying: string; startedAt: number; endedAt: number }> = {},
) {
  return {
    liveByCode: (code: string) => live[code],
    endedByCode: (code: string) => ended[code],
  };
}

/** An SMS gateway that keeps what it was asked to send. */
function texter(ok = true) {
  const sent: { to: string; text: string }[] = [];
  return { sent, send: async (to: string, text: string) => (sent.push({ to, text }), ok) };
}

const called = (leg: string, from: string) => ({
  event_type: "call.initiated",
  payload: { call_control_id: leg, direction: "incoming", from },
});

test("a time is read in Pacific, spelled out", () => {
  assert.equal(pacificTime(NINE_TWENTY_SEVEN), "9:27 PM Pacific");
});

test("a code that is a live stream plays the stream", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({
      "482917": {
        name: "Chovy",
        url: "https://chovy.example/listen.mp3",
        nowPlaying: "Top Gun: Maverick",
        startedAt: NINE_TWENTY_SEVEN,
      },
    }),
  });

  await party.handle(keyed("leg-1", "482917"));

  const spoke = calls.find((c) => c.path === "/calls/leg-1/actions/speak");
  assert.match(String(spoke?.body["payload"]), /Welcome to Chovy's live stream of Top Gun: Maverick/);
  assert.match(String(spoke?.body["payload"]), /started at 9:27 PM Pacific/);

  const play = calls.find((c) => c.path === "/calls/leg-1/actions/playback_start");
  assert.equal(play?.body["audio_url"], "https://chovy.example/listen.mp3");
  // A stream is not a conference; nothing should have been opened.
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 0);
});

test("a code whose stream has ended says when, and offers a text", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({}, {
      "482917": {
        name: "Chovy",
        nowPlaying: "Top Gun: Maverick",
        startedAt: NINE_TWENTY_SEVEN - 3_600_000,
        endedAt: NINE_TWENTY_SEVEN,
      },
    }),
  });

  await party.handle(keyed("leg-1", "482917"));

  const ask = calls.find((c) => c.path === "/calls/leg-1/actions/gather_using_speak");
  const said = String(ask?.body["payload"]);
  assert.match(said, /Welcome to Chovy's live stream of Top Gun: Maverick/);
  assert.match(said, /ended at 9:27 PM Pacific/);
  assert.match(said, /Call back later when they stream again/);
  assert.match(said, /Press 1 to get a text message/);
  // Only 1 is worth pressing, so only 1 is accepted.
  assert.equal(ask?.body["valid_digits"], "1");
  assert.equal(calls.filter((c) => c.path === "/conferences").length, 0);
});

test("pressing 1 signs the caller up, and their number comes from the call", async () => {
  const { calls, fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({}, {
      "482917": { name: "Chovy", nowPlaying: "Top Gun", startedAt: 1, endedAt: NINE_TWENTY_SEVEN },
    }),
  });

  await party.handle(called("leg-1", "+14155550123"));
  await party.handle(keyed("leg-1", "482917"));
  assert.equal(party.waitingOn("482917"), 0);

  await party.handle(keyed("leg-1", "1"));
  assert.equal(party.waitingOn("482917"), 1);
  assert.ok(calls.some((c) => /We will text you/.test(String(c.body["payload"]))));
  assert.ok(calls.some((c) => c.path === "/calls/leg-1/actions/hangup"));
});

test("not pressing 1 signs nobody up", async () => {
  const { fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({}, {
      "482917": { name: "Chovy", nowPlaying: "", startedAt: 1, endedAt: NINE_TWENTY_SEVEN },
    }),
  });

  await party.handle(called("leg-1", "+14155550123"));
  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-1", ""));
  assert.equal(party.waitingOn("482917"), 0);
});

test("a caller with no caller id is not signed up for a text we cannot send", async () => {
  const { fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({}, {
      "482917": { name: "Chovy", nowPlaying: "", startedAt: 1, endedAt: NINE_TWENTY_SEVEN },
    }),
  });

  // No call.initiated, so no from was ever seen.
  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-1", "1"));
  assert.equal(party.waitingOn("482917"), 0);
});

test("when the stream comes back, everyone waiting is texted once", async () => {
  const { fetch } = recorder();
  const sms = texter();
  const party = line(fetch, "", {
    sms,
    streams: streams({}, {
      "482917": { name: "Chovy", nowPlaying: "Top Gun", startedAt: 1, endedAt: NINE_TWENTY_SEVEN },
    }),
  });

  for (const [leg, from] of [["a", "+14155550123"], ["b", "+14155550124"]] as const) {
    await party.handle(called(leg, from));
    await party.handle(keyed(leg, "482917"));
    await party.handle(keyed(leg, "1"));
  }
  assert.equal(party.waitingOn("482917"), 2);

  const sent = await party.wentLive({ code: "482917", name: "Chovy", nowPlaying: "Top Gun" });
  assert.equal(sent, 2);
  assert.deepEqual(sms.sent.map((m) => m.to).sort(), ["+14155550123", "+14155550124"]);
  assert.match(sms.sent[0]!.text, /Chovy is live now of Top Gun on nixamp/);
  assert.match(sms.sent[0]!.text, /key 482917/);
  // The text tells them to call the cheap line, the same one /sms names.
  assert.match(sms.sent[0]!.text, /408-357-2326/);
  // An automated text to a US number has to say how to stop it.
  assert.match(sms.sent[0]!.text, /Reply STOP to opt out/);

  // Asked once, told once. Going live again does not text them a second time.
  assert.equal(party.waitingOn("482917"), 0);
  assert.equal(await party.wentLive({ code: "482917", name: "Chovy", nowPlaying: "Top Gun" }), 0);
  assert.equal(sms.sent.length, 2);
});

test("with no way to send a text, nothing is sent and nothing throws", async () => {
  const { fetch } = recorder();
  const party = line(fetch, "", {
    streams: streams({}, {
      "482917": { name: "Chovy", nowPlaying: "", startedAt: 1, endedAt: NINE_TWENTY_SEVEN },
    }),
  });
  await party.handle(called("leg-1", "+14155550123"));
  await party.handle(keyed("leg-1", "482917"));
  await party.handle(keyed("leg-1", "1"));
  assert.equal(await party.wentLive({ code: "482917", name: "Chovy", nowPlaying: "" }), 0);
});

test("a code that is nobody's stream is still an ordinary room", async () => {
  const { calls, fetch } = recorder(conferenceReplies());
  const party = line(fetch, "", { streams: streams() });

  await party.handle(keyed("leg-1", "482917"));
  // This line was a party line before it was a way into a broadcast.
  assert.ok(calls.some((c) => c.path === "/conferences"));
  assert.equal(party.list()[0]?.callers, 1);
});

test("a text is sent from the number that can send one", async () => {
  const { calls, fetch } = recorder();
  const sms = telnyxSms({ apiKey: "KEY_test", from: "+14084269127", fetch });
  assert.equal(await sms.send("+14155550123", "hello"), true);

  const sent = calls[0];
  assert.equal(sent?.path, "/messages");
  // Not the toll-free line the call came in on: unverified toll-free A2P is
  // filtered by carriers.
  assert.equal(sent?.body["from"], "+14084269127");
  assert.equal(sent?.body["to"], "+14155550123");
});

test("a text that will not send is reported as not sent", async () => {
  const { fetch } = recorder(() => ({ ok: false }));
  const sms = telnyxSms({ apiKey: "KEY_test", from: "+14084269127", fetch });
  assert.equal(await sms.send("+14155550123", "hello"), false);
});

test("the opt-in page says the things a carrier and a recipient both need", () => {
  const page = optInPage();
  // The consent, quoted as the caller actually hears it.
  assert.match(page, /Press&nbsp;1 to get a text message when they do/);
  // The local line, not the toll-free one: it is the number we publish because
  // it is the only one that can reach channel billing.
  assert.match(page, /408-357-2326/);
  // The number that sends is not the number you call, and the page says so.
  assert.match(page, /408-426-9127/);
  assert.ok(!page.includes("888-766-6818"), "the vanity toll-free is not what we publish");
  // The four lines a US A2P programme is required to carry.
  assert.match(page, /Reply <strong>STOP<\/strong>/);
  assert.match(page, /Reply <strong>HELP<\/strong>/);
  assert.match(page, /Message and data rates may apply/);
  assert.match(page, /Once per stream you asked about/);
});

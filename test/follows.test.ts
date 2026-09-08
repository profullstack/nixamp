import { test } from "node:test";
import assert from "node:assert/strict";
import { Follows, phoneFrom, type Queryable, type Reachable } from "../src/follows.ts";
import { notifyAll, resendEmail, type Notification } from "../src/notify.ts";

/**
 * A database that records what it was asked and answers what a test says.
 *
 * The point is to assert the SQL is shaped right -- which columns, which
 * conflict clause -- without a Postgres to run it against.
 */
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

const NOTE: Notification = {
  title: "Chovy is live",
  body: "Playing Top Gun: Maverick.",
  url: "https://nixamp.com/directory",
};

test("a phone number is stored only when we could actually dial it", () => {
  assert.equal(phoneFrom("+14155550123"), "+14155550123");
  // The two shapes people actually type.
  assert.equal(phoneFrom("4155550123"), "+14155550123");
  assert.equal(phoneFrom("(415) 555-0123"), "+14155550123");
  assert.equal(phoneFrom("1-415-555-0123"), "+14155550123");

  // A number we cannot dial is worse than none: it is a text that silently
  // goes nowhere until somebody checks.
  assert.equal(phoneFrom("555-0123"), "");
  assert.equal(phoneFrom("not a phone"), "");
  assert.equal(phoneFrom(""), "");
  assert.equal(phoneFrom(undefined), "");
  assert.equal(phoneFrom(12345), "");
});

test("the tables are made once, not on every call", async () => {
  const { asked, queryable } = db();
  const follows = new Follows(queryable);

  await follows.follow("a", "b");
  await follows.follow("a", "c");
  await follows.following("a");

  const creates = asked.filter((a) => a.text.includes("CREATE TABLE"));
  assert.equal(creates.length, 1, "schema is ensured once per process");
});

test("following is idempotent, and you cannot follow yourself", async () => {
  const { asked, queryable } = db();
  const follows = new Follows(queryable);

  assert.equal(await follows.follow("me", "them"), true);
  const insert = asked.find((a) => a.text.includes("INSERT INTO follows"));
  // Following twice is a no-op rather than a duplicate to clean up later.
  assert.match(insert?.text ?? "", /ON CONFLICT DO NOTHING/);
  assert.deepEqual(insert?.values, ["me", "them"]);

  // You do not need telling that you went live.
  assert.equal(await follows.follow("me", "me"), false);
  assert.equal(await follows.follow("", "them"), false);
  assert.equal(await follows.follow("me", ""), false);
});

test("a browser re-subscribing replaces its row rather than adding one", async () => {
  const { asked, queryable } = db();
  const follows = new Follows(queryable);

  await follows.addPush("me", { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
  const insert = asked.find((a) => a.text.includes("INSERT INTO push_subscriptions"));
  // The endpoint is the key: it is already unique per browser, and signing in
  // again should not leave a second copy behind.
  assert.match(insert?.text ?? "", /ON CONFLICT \(endpoint\) DO UPDATE/);
  assert.deepEqual(insert?.values, ["https://push.example/abc", "me", "k", "a"]);

  // A subscription with no endpoint is not a subscription.
  asked.length = 0;
  await follows.addPush("me", { endpoint: "", p256dh: "k", auth: "a" });
  assert.equal(asked.filter((a) => a.text.includes("INSERT")).length, 0);
});

test("somebody who has never opened the settings still has sensible defaults", async () => {
  const { queryable } = db();
  const follows = new Follows(queryable);
  const prefs = await follows.prefs("nobody");

  // Mail and web yes, texts no: a text is the most intrusive of the three and
  // the one you should have to ask for.
  assert.deepEqual(prefs, { phone: "", wantsEmail: true, wantsSms: false, wantsWeb: true });
});

test("stored preferences win over the defaults", async () => {
  const { queryable } = db({
    "FROM notify_prefs": [{ phone: "+14155550123", want_email: false, want_sms: true, want_web: false }],
  });
  const follows = new Follows(queryable);
  assert.deepEqual(await follows.prefs("me"), {
    phone: "+14155550123",
    wantsEmail: false,
    wantsSms: true,
    wantsWeb: false,
  });
});

test("the audience comes back in one query, with every device attached", async () => {
  const { asked, queryable } = db({
    "FROM follows f": [
      {
        account_id: "u1",
        email: "a@example.com",
        phone: "+14155550123",
        want_email: true,
        want_sms: true,
        want_web: true,
        push: [
          { endpoint: "https://push.example/laptop", p256dh: "k1", auth: "a1" },
          { endpoint: "https://push.example/phone", p256dh: "k2", auth: "a2" },
        ],
      },
    ],
  });
  const follows = new Follows(queryable);
  const audience = await follows.audience("streamer");

  // One person with a laptop and a phone is one account and two subscriptions.
  assert.equal(audience.length, 1);
  assert.equal(audience[0]?.push.length, 2);
  assert.equal(audience[0]?.email, "a@example.com");

  // One query for everybody, not one per follower: a broadcaster with a
  // thousand followers must not be a thousand round trips.
  const selects = asked.filter((a) => a.text.includes("FROM follows f"));
  assert.equal(selects.length, 1);

  assert.deepEqual(await follows.audience(""), [], "no streamer, no audience");
});

test("push rows survive arriving as a JSON string", async () => {
  const { queryable } = db({
    "FROM follows f": [
      {
        account_id: "u1", email: "a@example.com", phone: "",
        want_email: true, want_sms: false, want_web: true,
        push: JSON.stringify([{ endpoint: "https://push.example/x", p256dh: "k", auth: "a" }]),
      },
    ],
  });
  const audience = await new Follows(queryable).audience("s");
  assert.equal(audience[0]?.push[0]?.endpoint, "https://push.example/x");
});

// --- the fan-out -----------------------------------------------------------

const person = (over: Partial<Reachable> = {}): Reachable => ({
  accountId: "u1",
  email: "a@example.com",
  phone: "+14155550123",
  wantsEmail: true,
  wantsSms: true,
  wantsWeb: true,
  push: [{ endpoint: "https://push.example/a", p256dh: "k", auth: "a" }],
  ...over,
});

test("a follower is told on every channel they asked for", async () => {
  const emails: string[] = [];
  const texts: { to: string; text: string }[] = [];
  const pushes: string[] = [];

  const report = await notifyAll([person()], NOTE, {
    email: async (to) => (emails.push(to), true),
    sms: { send: async (to, text) => (texts.push({ to, text }), true) },
    push: async (target) => (pushes.push(target.endpoint), "sent"),
  });

  assert.deepEqual(report, { email: 1, sms: 1, push: 1, dropped: 0 });
  assert.deepEqual(emails, ["a@example.com"]);
  assert.deepEqual(pushes, ["https://push.example/a"]);
  // An automated text to a US number has to say how to stop it.
  assert.match(texts[0]!.text, /Reply STOP to opt out/);
  assert.match(texts[0]!.text, /Chovy is live/);
});

test("a channel switched off is a channel not used", async () => {
  let emailed = 0;
  let texted = 0;
  let pushed = 0;

  const report = await notifyAll(
    [person({ wantsEmail: false, wantsSms: false, wantsWeb: true })],
    NOTE,
    {
      email: async () => (emailed += 1, true),
      sms: { send: async () => (texted += 1, true) },
      push: async () => (pushed += 1, "sent"),
    },
  );

  assert.deepEqual([emailed, texted, pushed], [0, 0, 1]);
  assert.equal(report.push, 1);
});

test("a follower with no phone is not texted, however willing", async () => {
  let texted = 0;
  await notifyAll([person({ phone: "", wantsSms: true, push: [] })], NOTE, {
    sms: { send: async () => (texted += 1, true) },
  });
  assert.equal(texted, 0);
});

test("a channel the operator never configured sends nothing and throws nothing", async () => {
  const report = await notifyAll([person()], NOTE, {});
  assert.deepEqual(report, { email: 0, sms: 0, push: 0, dropped: 0 });
});

test("every device gets its own push", async () => {
  const sent: string[] = [];
  const report = await notifyAll(
    [person({
      push: [
        { endpoint: "https://push.example/laptop", p256dh: "k", auth: "a" },
        { endpoint: "https://push.example/phone", p256dh: "k", auth: "a" },
        { endpoint: "https://push.example/desktop", p256dh: "k", auth: "a" },
      ],
    })],
    NOTE,
    { push: async (t) => (sent.push(t.endpoint), "sent") },
  );
  assert.equal(report.push, 3);
  assert.equal(sent.length, 3, "one person, three devices, three pushes");
});

test("a subscription the vendor retired is dropped, not retried forever", async () => {
  const dropped: string[] = [];
  const report = await notifyAll(
    [person({
      push: [
        { endpoint: "https://push.example/alive", p256dh: "k", auth: "a" },
        { endpoint: "https://push.example/dead", p256dh: "k", auth: "a" },
      ],
    })],
    NOTE,
    {
      push: async (t) => (t.endpoint.endsWith("dead") ? "gone" : "sent"),
      onGone: async (endpoint) => void dropped.push(endpoint),
    },
  );

  assert.equal(report.push, 1);
  assert.equal(report.dropped, 1);
  assert.deepEqual(dropped, ["https://push.example/dead"]);
});

test("one bad address does not cancel everybody else", async () => {
  const told: string[] = [];
  const report = await notifyAll(
    [person({ accountId: "u1", email: "bad@example.com" }), person({ accountId: "u2", email: "good@example.com" })],
    NOTE,
    {
      email: async (to) => {
        if (to.startsWith("bad")) throw new Error("bounced");
        told.push(to);
        return true;
      },
    },
  );
  assert.deepEqual(told, ["good@example.com"]);
  assert.equal(report.email, 1);
});

test("mail goes out over HTTP, with the unsubscribe reason in it", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok: true } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  const send = resendEmail({ apiKey: "k", from: "nixamp <n@nixamp.com>", fetch });
  assert.equal(await send("a@example.com", NOTE), true);

  assert.equal(calls[0]?.url, "https://api.resend.com/emails");
  assert.equal(calls[0]?.body["subject"], "Chovy is live");
  assert.deepEqual(calls[0]?.body["to"], ["a@example.com"]);
  assert.match(String(calls[0]?.body["text"]), /because you follow them/);
});

test("mail that will not send is reported as not sent", async () => {
  const fetch = (async () => ({ ok: false, status: 422 }) as unknown as Response) as unknown as typeof globalThis.fetch;
  const send = resendEmail({ apiKey: "k", from: "n@nixamp.com", fetch });
  assert.equal(await send("a@example.com", NOTE), false);
});

test("html in a stream name cannot become html in an inbox", async () => {
  const calls: Record<string, unknown>[] = [];
  const fetch = (async (_u: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return { ok: true } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  const send = resendEmail({ apiKey: "k", from: "n@nixamp.com", fetch });
  await send("a@example.com", { ...NOTE, body: '<img src=x onerror="alert(1)">' });
  assert.ok(!String(calls[0]?.["html"]).includes("<img"));
  assert.match(String(calls[0]?.["html"]), /&lt;img/);
});

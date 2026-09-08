import { test } from "node:test";
import assert from "node:assert/strict";
import { Directory, ENDED_TTL_MS, clean, parseAnnouncement, publishable } from "../src/directory.ts";
import { Publisher, confirm } from "../src/publish.ts";
import { allowedForListening, scopeOf } from "../src/share.ts";

test("a listing has to point somewhere a stranger can actually go", () => {
  assert.notEqual(publishable("https://nixamp.example.com/s/abc"), null);
  assert.notEqual(publishable("http://67.205.189.229:4321/s/abc"), null);

  // Reachable only from the machine that published it, so listing it is an
  // entry nobody else can ever open.
  assert.equal(publishable("http://localhost:4321/s/abc"), null);
  assert.equal(publishable("http://127.0.0.1:4321/s/abc"), null);
  assert.equal(publishable("http://[::1]:4321/s/abc"), null);
  assert.equal(publishable("http://169.254.1.1:4321/s/abc"), null);
  // Not something a browser opens.
  assert.equal(publishable("file:///etc/passwd"), null);
  assert.equal(publishable("javascript:alert(1)"), null);
  assert.equal(publishable("not a url"), null);
});

test("text from a publisher cannot draw in someone's terminal", () => {
  assert.equal(clean("Meshuggah — Bleed", 60), "Meshuggah — Bleed");
  assert.equal(clean("\u001b[31mred\u001b[0m", 60), "[31mred [0m");
  assert.equal(clean("two\nlines", 60), "two lines");
  assert.equal(clean("  padded  ", 60), "padded");
  assert.equal(clean("x".repeat(100), 10), "x".repeat(10));
  assert.equal(clean(42, 10), "");
  // A hyphen is not a control character, whatever the first draft thought.
  assert.equal(clean("post-rock", 60), "post-rock");
});

test("an announcement is sanitised, and a nameless one still gets a name", () => {
  const ok = parseAnnouncement({
    name: "  Anthony's box  ",
    url: "https://nixamp.example.com/s/abc",
    tracks: 12.7,
    nowPlaying: "A Song",
  });
  assert.equal(ok?.name, "Anthony's box");
  assert.equal(ok?.tracks, 12);

  assert.equal(parseAnnouncement({ name: "x", url: "http://127.0.0.1/s/a", tracks: 1, nowPlaying: "" }), null);
  assert.equal(parseAnnouncement(null), null);
  assert.equal(parseAnnouncement({ name: "x" }), null);

  const nameless = parseAnnouncement({ url: "https://a.example.com/s/a", tracks: -5, nowPlaying: "" });
  assert.equal(nameless?.name, "a nixamp");
  assert.equal(nameless?.tracks, 0);
});

test("the directory forgets what stops renewing", () => {
  let now = 1_000_000;
  const dir = new Directory(1000, () => now);
  const a = dir.announce({ name: "A", url: "https://a.example.com/s/1", tracks: 1, nowPlaying: "" });
  assert.equal(dir.list().length, 1);

  now += 500;
  dir.announce({ id: a.id, name: "A", url: "https://a.example.com/s/1", tracks: 1, nowPlaying: "still here" });
  now += 800;
  // Renewed at 500, so at 1300 it is 800 old and still inside the TTL.
  assert.equal(dir.list().length, 1);
  assert.equal(dir.list()[0]?.nowPlaying, "still here");

  now += 500;
  assert.equal(dir.list().length, 0);
});

test("announcing the same URL twice replaces the entry rather than doubling it", () => {
  const dir = new Directory();
  const first = dir.announce({ name: "A", url: "https://a.example.com/s/1", tracks: 1, nowPlaying: "one" });
  const again = dir.announce({ name: "A restarted", url: "https://a.example.com/s/1", tracks: 2, nowPlaying: "two" });

  assert.equal(dir.list().length, 1);
  assert.equal(first.id, again.id);
  assert.equal(dir.list()[0]?.name, "A restarted");
});

test("a publisher cannot claim an id that is not its own", () => {
  const dir = new Directory();
  const mine = dir.announce({ name: "Mine", url: "https://a.example.com/s/1", tracks: 1, nowPlaying: "" });
  // Someone else announces a different URL while quoting my id.
  const theirs = dir.announce({ id: mine.id, name: "Theirs", url: "https://b.example.com/s/2", tracks: 1, nowPlaying: "" });

  assert.notEqual(theirs.id, mine.id);
  assert.equal(dir.list().length, 2);
  assert.equal(dir.list().find((l) => l.id === mine.id)?.name, "Mine");
});

test("withdrawing takes it out at once", () => {
  const dir = new Directory();
  const listing = dir.announce({ name: "A", url: "https://a.example.com/s/1", tracks: 1, nowPlaying: "" });
  dir.withdraw(listing.id);
  assert.equal(dir.list().length, 0);
  // Withdrawing something already gone is not an error.
  dir.withdraw(listing.id);
});

test("the listen key may hear but not drive", () => {
  assert.equal(scopeOf("control-key", "control-key", "listen-key"), "control");
  assert.equal(scopeOf("listen-key", "control-key", "listen-key"), "listen");
  assert.equal(scopeOf("neither", "control-key", "listen-key"), null);
  assert.equal(scopeOf(null, "control-key", "listen-key"), null);

  assert.equal(allowedForListening("/api/state"), true);
  assert.equal(allowedForListening("/api/stream/0"), true);
  assert.equal(allowedForListening("/api/media/0"), true);
  assert.equal(allowedForListening("/api/events"), true);
  assert.equal(allowedForListening("/api/command"), false);
  assert.equal(allowedForListening("/api/source"), false);
});

test("nobody to ask is not consent", async () => {
  assert.equal(await confirm("list it?", false), false);
});

test("a publisher keeps the id the directory gave it, and leaves on stop", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: true,
      json: async () => ({ id: "assigned-id", name: "n", url: "u", tracks: 0, nowPlaying: "", updatedAt: 0 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const publisher = new Publisher(
    { directory: "https://d.example", name: "n", url: "https://a.example/s/1", tracks: 3, nowPlaying: () => "song" },
    fake,
  );

  const first = await publisher.start();
  assert.equal(first?.id, "assigned-id");
  assert.equal(calls[0]?.method, "POST");
  assert.equal((calls[0]?.body as { id?: string }).id, undefined);

  await publisher.announce();
  // The second announcement quotes the id, so it renews rather than duplicates.
  assert.equal((calls[1]?.body as { id?: string }).id, "assigned-id");

  await publisher.stop();
  assert.equal(calls[2]?.method, "DELETE");
  assert.match(calls[2]?.url ?? "", /id=assigned-id/);
});

test("a directory that is down does not stop the music", async () => {
  const failing = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;

  const publisher = new Publisher(
    { directory: "https://d.example", name: "n", url: "https://a.example/s/1", tracks: 0, nowPlaying: () => "" },
    failing,
  );
  assert.equal(await publisher.start(), null);
  await publisher.stop();
});


// --- codes, and remembering a stream long enough to say when it stopped -----

/** A directory whose clock and codes a test decides. */
function dated() {
  let at = 1_788_928_020_000; // 9:27 PM Pacific
  let n = 0;
  const dir = new Directory(4 * 60 * 1000, () => at, () => String(100000 + ++n));
  return { dir, tick: (ms: number) => (at += ms), at: () => at };
}

const stream = (url: string, name = "Chovy", nowPlaying = "Top Gun: Maverick") =>
  ({ name, url, tracks: 1, nowPlaying });

test("a stream gets a six digit code, and keeps it while it runs", () => {
  const { dir, tick } = dated();
  const first = dir.announce(stream("https://a.example/listen"));
  assert.match(first.code, /^\d{6}$/);
  assert.equal(first.startedAt, 1_788_928_020_000);

  // A heartbeat is the same stream, so the code a caller was given still works.
  tick(60_000);
  const again = dir.announce(stream("https://a.example/listen"));
  assert.equal(again.code, first.code);
  assert.equal(again.id, first.id);
  assert.equal(again.startedAt, first.startedAt, "the start does not move on a heartbeat");

  assert.equal(dir.liveByCode(first.code)?.name, "Chovy");
  assert.equal(dir.endedByCode(first.code), undefined);
});

test("two streams get two codes", () => {
  const { dir } = dated();
  const a = dir.announce(stream("https://a.example/listen"));
  const b = dir.announce(stream("https://b.example/listen", "Someone"));
  assert.notEqual(a.code, b.code);
  assert.equal(dir.liveByCode(b.code)?.name, "Someone");
});

test("a stream that stops is remembered, with the time it stopped", () => {
  const { dir, tick } = dated();
  const live = dir.announce(stream("https://a.example/listen"));
  const startedAt = live.startedAt;

  // Past the TTL: it falls out of the list, which is what the list is for.
  tick(5 * 60 * 1000);
  assert.deepEqual(dir.list(), []);
  assert.equal(dir.liveByCode(live.code), undefined);

  // But the phone line can still say who it was and when it ended, which is
  // the whole reason this is kept.
  const ended = dir.endedByCode(live.code);
  assert.equal(ended?.name, "Chovy");
  assert.equal(ended?.nowPlaying, "Top Gun: Maverick");
  assert.equal(ended?.endedAt, startedAt, "the last heartbeat is when it ended");
});

test("withdrawing is stopping, and is remembered the same way", () => {
  const { dir } = dated();
  const live = dir.announce(stream("https://a.example/listen"));
  dir.withdraw(live.id);
  assert.deepEqual(dir.list(), []);
  assert.equal(dir.endedByCode(live.code)?.name, "Chovy");
});

test("a stream that comes back keeps the code it was given", () => {
  const { dir, tick, at } = dated();
  const first = dir.announce(stream("https://a.example/listen"));

  tick(5 * 60 * 1000);
  assert.ok(dir.endedByCode(first.code), "it stopped");

  // Somebody was told to call back later and key those six digits. They have
  // to still work, or the reminder was a lie.
  const back = dir.announce(stream("https://a.example/listen"));
  assert.equal(back.code, first.code);
  assert.equal(dir.liveByCode(first.code)?.name, "Chovy");
  assert.equal(dir.endedByCode(first.code), undefined, "it is not both live and ended");
  // A second run is a new run: the caller is told when *this* one started.
  assert.equal(back.startedAt, at());
  assert.notEqual(back.startedAt, first.startedAt);
});

test("a stream nobody has seen for a day is forgotten entirely", () => {
  const { dir, tick } = dated();
  const live = dir.announce(stream("https://a.example/listen"));

  tick(5 * 60 * 1000);
  assert.ok(dir.endedByCode(live.code));

  tick(ENDED_TTL_MS);
  assert.equal(dir.endedByCode(live.code), undefined);
});


test("a publisher signs its announcements, because the directory now asks who", async () => {
  const calls: { url: string; method: string; auth: string | undefined }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: headers["authorization"] });
    return {
      ok: true,
      json: async () => ({
        id: "assigned-id", code: "482917", name: "n", url: "u",
        tracks: 0, nowPlaying: "", updatedAt: 0, startedAt: 0,
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const publisher = new Publisher(
    {
      directory: "https://d.example",
      name: "n",
      url: "https://a.example/s/1",
      tracks: 1,
      nowPlaying: () => "",
      token: "tok-from-nixamp-login",
    },
    fake,
  );

  await publisher.start();
  assert.equal(calls[0]?.auth, "Bearer tok-from-nixamp-login");

  // Leaving the list is the same claim as joining it.
  await publisher.stop();
  assert.equal(calls[1]?.method, "DELETE");
  assert.equal(calls[1]?.auth, "Bearer tok-from-nixamp-login");
});

test("a publisher with no account is told once, not every heartbeat", async () => {
  let refusals = 0;
  const fake = (async () =>
    ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;

  const publisher = new Publisher(
    {
      directory: "https://d.example",
      name: "n",
      url: "https://a.example/s/1",
      tracks: 1,
      nowPlaying: () => "",
      onRefused: () => (refusals += 1),
    },
    fake,
  );

  assert.equal(await publisher.announce(), null);
  assert.equal(refusals, 1);

  // A heartbeat every 90 seconds must not print this every 90 seconds.
  await publisher.announce();
  await publisher.announce();
  assert.equal(refusals, 1);
});

test("a directory being down is not the same as a directory saying no", async () => {
  let refusals = 0;
  const fake = (async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;

  const publisher = new Publisher(
    {
      directory: "https://d.example",
      name: "n",
      url: "https://a.example/s/1",
      tracks: 1,
      nowPlaying: () => "",
      onRefused: () => (refusals += 1),
    },
    fake,
  );

  assert.equal(await publisher.announce(), null);
  assert.equal(refusals, 0, "a 503 is not a missing account");
});


// --- going live is a transition, not a heartbeat ---------------------------

test("followers are told once when a stream starts, not every ninety seconds", () => {
  let at = 1_788_928_020_000;
  const live: string[] = [];
  const dir = new Directory(4 * 60 * 1000, () => at, () => "482917", (l) => live.push(l.name));

  dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" }, "owner-1");
  assert.deepEqual(live, ["Chovy"]);

  // The publisher renews every 90 seconds for as long as it is up. Telling
  // followers on each of those would be telling them forty times an hour.
  for (let beat = 0; beat < 5; beat += 1) {
    at += 90_000;
    dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "x" }, "owner-1");
  }
  assert.deepEqual(live, ["Chovy"], "five heartbeats, still one notification");
});

test("a stream that stopped and came back is a new thing to be told about", () => {
  let at = 1_788_928_020_000;
  const live: string[] = [];
  const dir = new Directory(4 * 60 * 1000, () => at, () => "482917", (l) => live.push(l.name));

  dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" }, "owner-1");
  at += 5 * 60 * 1000;            // past the TTL: it stopped
  dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" }, "owner-1");

  assert.equal(live.length, 2, "a second run is a second broadcast");
});

test("the owner comes from the token and survives a heartbeat that omits it", () => {
  let at = 1_788_928_020_000;
  const dir = new Directory(4 * 60 * 1000, () => at, () => "482917");

  const first = dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" }, "owner-1");
  assert.equal(first.ownerId, "owner-1");

  // A heartbeat with no owner must not orphan a listing people follow.
  at += 90_000;
  const beat = dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" });
  assert.equal(beat.ownerId, "owner-1");

  // And it survives the stream stopping and returning.
  at += 5 * 60 * 1000;
  const back = dir.announce({ name: "Chovy", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" });
  assert.equal(back.ownerId, "owner-1");
});

test("an unowned listing notifies nobody, because there is nobody to follow", () => {
  const live: { ownerId: string }[] = [];
  const dir = new Directory(4 * 60 * 1000, () => 1, () => "482917", (l) => live.push(l));
  dir.announce({ name: "anon", url: "https://a.example/s/1", tracks: 1, nowPlaying: "" });
  // It still fires; the caller is what declines to send, because an empty
  // owner has no audience to look up.
  assert.equal(live[0]?.ownerId, "");
});


// --- who is there to follow when nobody is on ------------------------------

test("a stream that stopped is still somebody you can follow", () => {
  const { dir, tick } = dated();
  dir.announce(stream("https://a.example/listen"), "owner-1");

  tick(5 * 60 * 1000);
  assert.deepEqual(dir.list(), [], "nothing is on");

  // The whole point: an empty directory used to mean nobody to follow, which
  // made following useless exactly when it was most useful.
  const recent = dir.recentlyEnded();
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.name, "Chovy");
  assert.equal(recent[0]?.ownerId, "owner-1");
});

test("a stream that is on is not also listed as recently off", () => {
  const { dir, tick } = dated();
  dir.announce(stream("https://a.example/listen"), "owner-1");
  tick(5 * 60 * 1000);
  assert.equal(dir.recentlyEnded().length, 1);

  // It came back. Listing it in both places would offer a follow button beside
  // a listen button for the same person.
  dir.announce(stream("https://a.example/listen"), "owner-1");
  assert.equal(dir.list().length, 1);
  assert.deepEqual(dir.recentlyEnded(), []);
});

test("recently ended is most recent first", () => {
  const { dir, tick } = dated();
  dir.announce(stream("https://a.example/listen", "First"), "o1");
  tick(60_000);
  dir.announce(stream("https://b.example/listen", "Second"), "o2");
  tick(5 * 60 * 1000);

  assert.deepEqual(dir.recentlyEnded().map((r) => r.name), ["Second", "First"]);
});

test("an account can be named and located whether it is on or off", () => {
  const { dir, tick } = dated();
  dir.announce(stream("https://a.example/listen"), "owner-1");

  // An id is not a name, and a follow list of bare ids is unreadable.
  assert.equal(dir.nameOf("owner-1"), "Chovy");
  assert.equal(dir.isLive("owner-1"), true);

  tick(5 * 60 * 1000);
  assert.equal(dir.nameOf("owner-1"), "Chovy", "the name outlives the stream");
  assert.equal(dir.isLive("owner-1"), false);

  // Somebody who never streamed has no name we know, and saying nothing is
  // better than inventing one.
  assert.equal(dir.nameOf("nobody"), "");
  assert.equal(dir.nameOf(""), "");
  assert.equal(dir.isLive("nobody"), false);
});

test("a forgotten stream is nobody to follow either", () => {
  const { dir, tick } = dated();
  dir.announce(stream("https://a.example/listen"), "owner-1");
  tick(5 * 60 * 1000);
  assert.equal(dir.recentlyEnded().length, 1);

  tick(ENDED_TTL_MS);
  assert.deepEqual(dir.recentlyEnded(), []);
  assert.equal(dir.nameOf("owner-1"), "");
});

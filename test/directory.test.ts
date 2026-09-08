import { test } from "node:test";
import assert from "node:assert/strict";
import { Directory, clean, parseAnnouncement, publishable } from "../src/directory.ts";
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

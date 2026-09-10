import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, Enricher, fresh, FIXTURE_TTL_MS, HIT_TTL_MS, MISS_TTL_MS, pickBest, whereToAsk } from "../src/enrich.ts";

/** nichedb's answer for a film, as /api/v1/match returns it. */
const TOP_GUN = {
  parsed: { name: "Top Gun Maverick", year: 2022, kind: "movie" },
  items: [
    {
      kind: "title", title: "Top Gun: Maverick", summary: "After thirty years, Maverick is still pushing the envelope.",
      image_url: "https://image.tmdb.org/t/p/w500/topgun.jpg", published_at: "2022-05-27T00:00:00.000Z",
      page: "https://nichedb.dev/i/101", score: 0.62, tags: ["title", "film", "genre:action"],
      data: { year: 2022, rating: 8.2, ratingCount: 700000, genres: ["Action", "Drama"], imdbId: "tt1745960" },
    },
    { kind: "title", title: "Top Gun", published_at: "1986-05-16T00:00:00.000Z", page: "https://nichedb.dev/i/100", score: 0.5, data: { year: 1986 } },
  ],
};

/** A fetch that answers with whatever the test says, and remembers what was asked. */
function site(answers: Record<string, unknown> | ((url: string) => unknown)) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    asked.push(u);
    const body = typeof answers === "function" ? answers(u) : answers;
    return { ok: body !== null, status: body === null ? 503 : 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

test("a name is asked about where its kind lives", () => {
  assert.deepEqual(whereToAsk("channel"), { collection: "channels", kind: "channel" });
  assert.deepEqual(whereToAsk("fixture"), { collection: "sports", kind: "fixture" });
  assert.deepEqual(whereToAsk("title"), { collection: "screen", kind: "title" });
  assert.deepEqual(whereToAsk("auto", "series"), { collection: "screen", kind: "title" });
  assert.deepEqual(whereToAsk("auto", "channel"), { collection: "channels", kind: "channel" });
  // A song has no poster in nichedb yet, and a guess is worse than nothing.
  assert.equal(whereToAsk("auto", "music"), null);
  assert.equal(whereToAsk("auto", undefined), null);
});

test("the best answer is the exact title, else the highest score above the floor", () => {
  const best = pickBest(TOP_GUN, "Top Gun Maverick");
  assert.equal(best?.title, "Top Gun: Maverick");
  assert.equal(best?.year, 2022);
  assert.equal(best?.image, "https://image.tmdb.org/t/p/w500/topgun.jpg");
  assert.equal(best?.data["rating"], 8.2);
  // Asked for "Top Gun" exactly, the 1986 film wins over the higher-scoring sequel.
  assert.equal(pickBest(TOP_GUN, "Top Gun")?.year, 1986);
  // Nothing above the floor is nothing, not a wrong poster. Measured live:
  // "Severance" against a channel called "Sever" scored 0.45.
  assert.equal(pickBest({ items: [{ kind: "title", title: "Something Else", score: 0.2 }] }, "Top Gun"), null);
  assert.equal(pickBest({ items: [{ kind: "channel", title: "Sever", score: 0.45 }] }, "Severance"), null);
  assert.equal(pickBest({ items: [{ kind: "fixture", title: "Rangers at Celtic", score: 0.44 }] }, "Lakers at Celtics"), null);
  // But a weaker score is taken when one name plainly begins with the other.
  assert.equal(pickBest({ items: [{ kind: "title", title: "Top Gun: Maverick", score: 0.45 }] }, "Top Gun Maverick Extended")?.title, "Top Gun: Maverick");
  assert.equal(pickBest({ items: [] }, "x"), null);
  // A year falls back to the date when the data has none.
  const dated = pickBest({ items: [{ kind: "title", title: "A", score: 0.9, published_at: "1999-03-31T00:00:00Z" }] }, "A");
  assert.equal(dated?.year, 1999);
});

test("a file is asked about twice: once to be read, once where it lives", async () => {
  const { asked, fetch } = site((url) => (url.includes("collection=") ? TOP_GUN : { parsed: TOP_GUN.parsed, items: [] }));
  const enricher = new Enricher({ site: "https://ndb.test", fetch });
  const hit = await enricher.lookup("Top.Gun.Maverick.2022.1080p.WEB-DL.x265-FLUX.mkv");
  assert.equal(hit?.title, "Top Gun: Maverick");
  assert.equal(asked.length, 2);
  assert.match(asked[0] ?? "", /^https:\/\/ndb\.test\/api\/v1\/match\?q=Top\.Gun/);
  assert.ok(!asked[0]?.includes("collection="));
  assert.match(asked[1] ?? "", /collection=screen&kind=title/);
  // The year the name carried narrows the question.
  assert.match(asked[1] ?? "", /year=2022/);
});

test("a channel is asked about once, where channels live, and remembered", async () => {
  const answer = {
    parsed: { name: "ESPN2", kind: "channel" },
    items: [{ kind: "channel", title: "ESPN2", image_url: "https://logos/espn2.png", score: 0.9, page: "p", data: { country: "US" }, tags: ["channel", "sports", "country:us"] }],
  };
  const { asked, fetch } = site(answer);
  const enricher = new Enricher({ site: "https://ndb.test", fetch });
  const first = await enricher.lookup("US: ESPN2 HD", "channel");
  assert.equal(first?.kind, "channel");
  assert.equal(first?.image, "https://logos/espn2.png");
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /collection=channels&kind=channel/);
  // Again, differently spaced and cased: the cache answers.
  const again = await enricher.lookup("us:  espn2 hd", "channel");
  assert.equal(again?.title, "ESPN2");
  assert.equal(asked.length, 1);
  assert.equal(enricher.size, 1);
});

test("a miss is remembered for a while, a hit for longer, a fixture hardly at all", () => {
  const now = 1_700_000_000_000;
  const miss = { at: now, hit: null };
  const title = { at: now, hit: { kind: "title" as const, title: "x", year: null, image: null, summary: null, page: "", score: 1, data: {}, tags: [] } };
  const fixture = { at: now, hit: { ...title.hit, kind: "fixture" as const } };
  assert.equal(fresh(miss, now + MISS_TTL_MS - 1), true);
  assert.equal(fresh(miss, now + MISS_TTL_MS + 1), false);
  assert.equal(fresh(title, now + HIT_TTL_MS - 1), true);
  assert.equal(fresh(title, now + HIT_TTL_MS + 1), false);
  assert.equal(fresh(fixture, now + FIXTURE_TTL_MS + 1), false);
  assert.equal(cacheKey(" Top  Gun ", "auto", null), cacheKey("top gun", "auto", null));
  assert.notEqual(cacheKey("top gun", "auto", 1986), cacheKey("top gun", "auto", 2022));
});

test("nichedb being down is not a miss: nothing is remembered, and the last answer stands", async () => {
  let up = true;
  const { asked, fetch } = site(() => (up ? { parsed: { kind: "channel" }, items: [{ kind: "channel", title: "TF1", score: 0.9, page: "p" }] } : null));
  const said: string[] = [];
  const enricher = new Enricher({ site: "https://ndb.test", fetch, onEvent: (m) => said.push(m), now: () => 1 });
  assert.equal((await enricher.lookup("TF1", "channel"))?.title, "TF1");
  up = false;
  // Nothing new is asked while the answer is fresh; force a fresh key instead.
  assert.equal(await enricher.lookup("France 2", "channel"), null);
  assert.equal(enricher.size, 1, "the failure was not written down as a miss");
  assert.equal(asked.length, 2);
  assert.match(said[0] ?? "", /did not answer/);
});

test("two askers for the same name share one request", async () => {
  const { asked, fetch } = site({ parsed: { kind: "channel" }, items: [{ kind: "channel", title: "CNN", score: 1, page: "p" }] });
  const enricher = new Enricher({ site: "https://ndb.test", fetch });
  const [a, b] = await Promise.all([enricher.lookup("CNN", "channel"), enricher.lookup("CNN", "channel")]);
  assert.equal(a?.title, "CNN");
  assert.equal(b?.title, "CNN");
  assert.equal(asked.length, 1);
});

test("answers survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-enrich-"));
  const file = join(dir, "enrich.json");
  const { fetch } = site({ parsed: { kind: "channel" }, items: [{ kind: "channel", title: "BBC One", score: 1, page: "p" }] });
  const first = new Enricher({ site: "https://ndb.test", fetch, cacheFile: file });
  await first.lookup("BBC One", "channel");
  first.save();
  assert.ok(readFileSync(file, "utf8").includes("BBC One"));
  const { asked, fetch: dead } = site(null);
  const second = new Enricher({ site: "https://ndb.test", fetch: dead, cacheFile: file });
  assert.equal((await second.lookup("BBC One", "channel"))?.title, "BBC One");
  assert.equal(asked.length, 0, "answered from disk, nothing asked");
});

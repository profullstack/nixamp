import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheKey, Enricher, fresh, FIXTURE_TTL_MS, HIT_TTL_MS, isMatchupName, MISS_TTL_MS, pickBest, whereToAsk,
} from "../src/enrich.ts";

/** nichedb's answer for a game, as /api/v1/match returns it from the sports collection. */
const CHIEFS_BILLS = {
  parsed: { name: "Chiefs vs Bills", kind: "title" },
  items: [
    {
      kind: "fixture", title: "Buffalo Bills at Kansas City Chiefs", summary: "BUF @ KC",
      image_url: "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png", published_at: "2026-09-14T00:20:00.000Z",
      page: "https://nichedb.dev/i/3599999", score: 0.81, tags: ["fixture", "football", "league:nfl", "state:in"],
      data: {
        state: "in", statusDetail: "Q3 4:12", broadcast: "NBC", sport: "football",
        league: { name: "NFL", abbreviation: "NFL", slug: "nfl" },
        away: { name: "Bills", displayName: "Buffalo Bills", abbreviation: "BUF", score: 17, record: "1-0", logoUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/buf.png" },
        home: { name: "Chiefs", displayName: "Kansas City Chiefs", abbreviation: "KC", score: 21, record: "1-0", logoUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png" },
        homeScore: 21, awayScore: 17,
      },
    },
  ],
};

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
  // Two exact rows -- IMDb's and TMDB's Oppenheimer -- and only one has the poster.
  const twins = pickBest({
    items: [
      { kind: "title", title: "Oppenheimer", score: 1, page: "imdb", data: { year: 2023, rating: 8.2 } },
      { kind: "title", title: "Oppenheimer", score: 1, page: "tmdb", image_url: "https://i/poster.jpg", data: { year: 2023, rating: 8.0 } },
    ],
  }, "Oppenheimer");
  assert.equal(twins?.page, "tmdb");
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

test("two sides with vs, v, at or @ between them read as a game; a concert at Wembley does not", () => {
  for (const name of ["NFL: Chiefs vs Bills", "Lakers @ Celtics", "Arsenal v Chelsea", "Rangers at Celtic 19:45",
    "Chiefs vs. Bills - 7:30 PM EDT", "EPL - Man City vs Liverpool", "Boise State Broncos at Fresno State Bulldogs"]) {
    assert.equal(isMatchupName(name), true, name);
  }
  for (const name of ["Live at Wembley", "Oppenheimer (2023)", "CNN", "US: ESPN2 HD", "Dinner at Eight",
    "Meet Me at the Fountain", "Chiefs vs", "", "vs Bills"]) {
    assert.equal(isMatchupName(name), false, name);
  }
});

test("a name that reads as a game is asked about where fixtures live first, and that answer is kept for a minute", async () => {
  const { asked, fetch } = site((url) => (url.includes("collection=sports") ? CHIEFS_BILLS : { parsed: { kind: "title" }, items: [] }));
  let now = 1_700_000_000_000;
  const enricher = new Enricher({ site: "https://ndb.test", fetch, now: () => now });
  const hit = await enricher.lookup("NFL: Chiefs vs Bills", "auto");
  assert.equal(hit?.kind, "fixture");
  assert.equal(hit?.title, "Buffalo Bills at Kansas City Chiefs");
  assert.equal((hit?.data["home"] as { score: number }).score, 21);
  // One question, to the sports collection, before nichedb's parser is asked to read the name.
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? "", /collection=sports&kind=fixture/);
  assert.match(asked[0] ?? "", /q=NFL%3A\+Chiefs\+vs\+Bills/);
  // Half a minute on: the score is still believed. A minute on: asked again.
  now += FIXTURE_TTL_MS / 2;
  await enricher.lookup("NFL: Chiefs vs Bills", "auto");
  assert.equal(asked.length, 1);
  now += FIXTURE_TTL_MS;
  await enricher.lookup("NFL: Chiefs vs Bills", "auto");
  assert.equal(asked.length, 2);
  // Not a game after all -- "Kramer vs. Kramer" -- and the usual questions follow.
  const film = site((url) => (url.includes("collection=sports")
    ? { items: [] }
    : url.includes("collection=screen") ? { items: [{ kind: "title", title: "Kramer vs. Kramer", score: 0.9, data: { year: 1979 } }] } : { parsed: { kind: "movie" }, items: [] }));
  const other = new Enricher({ site: "https://ndb.test", fetch: film.fetch });
  assert.equal((await other.lookup("Kramer vs. Kramer", "auto"))?.kind, "title");
  assert.equal(film.asked.length, 3);
  // nichedb itself reads "Alien vs Predator" as a game now. The sports
  // collection said no already, so the title question follows, not a second no.
  const alien = site((url) => (url.includes("collection=sports")
    ? { items: [] }
    : url.includes("collection=screen") ? { items: [{ kind: "title", title: "Alien vs Predator", score: 0.9, data: { year: 2004 } }] } : { parsed: { kind: "fixture", teams: ["Alien", "Predator"] }, items: [] }));
  const avp = new Enricher({ site: "https://ndb.test", fetch: alien.fetch });
  assert.equal((await avp.lookup("Alien vs Predator", "auto"))?.kind, "title");
  assert.equal(alien.asked.length, 3);
  assert.match(alien.asked[2] ?? "", /collection=screen&kind=title/);
  // Asked as a fixture outright, the sports collection is the only place asked.
  const direct = site(CHIEFS_BILLS);
  assert.equal((await new Enricher({ site: "https://ndb.test", fetch: direct.fetch }).lookup("Chiefs vs Bills", "fixture"))?.kind, "fixture");
  assert.equal(direct.asked.length, 1);
});

test("among the same two teams, the game being played beats the one to come, which beats the one gone", () => {
  const meeting = (state: string, page: string, score = 0.8) => ({
    kind: "fixture", title: "Bills at Chiefs", page, score, tags: ["fixture", `state:${state}`], data: { state },
  });
  // Same score: the state decides.
  assert.equal(pickBest({ items: [meeting("post", "last-year"), meeting("pre", "next-week"), meeting("in", "now")] }, "Chiefs vs Bills")?.page, "now");
  assert.equal(pickBest({ items: [meeting("post", "last-year"), meeting("pre", "next-week")] }, "Chiefs vs Bills")?.page, "next-week");
  // Exact titles too, where the score is not consulted at all.
  assert.equal(pickBest({ items: [meeting("post", "last-year", 1), meeting("in", "now", 0.7)] }, "Bills at Chiefs")?.page, "now");
  // But a plainly better score still wins over a better state.
  assert.equal(pickBest({ items: [meeting("post", "last-year", 0.9), meeting("in", "now", 0.6)] }, "Chiefs vs Bills")?.page, "last-year");
  // The state is read from the tags when the data has none.
  const tagged = { kind: "fixture", title: "Bills at Chiefs", page: "tagged", score: 0.8, tags: ["state:in"], data: {} };
  assert.equal(pickBest({ items: [meeting("pre", "next-week"), tagged] }, "Chiefs vs Bills")?.page, "tagged");
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
  // A miss on a name that reads as a game is believed only a minute: the
  // fixture may be listed by the time the channel is on.
  assert.equal(fresh(miss, now + FIXTURE_TTL_MS + 1, true), false);
  assert.equal(fresh(miss, now + FIXTURE_TTL_MS - 1, true), true);
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

  // A cache written by older rules is not believed: those rules chose the
  // answers, and an update that chooses better must be seen through it.
  const stale = join(dir, "old.json");
  writeFileSync(stale, JSON.stringify({ [cacheKey("BBC One", "channel", null)]: { at: Date.now(), hit: null } }));
  const third = new Enricher({ site: "https://ndb.test", fetch: dead, cacheFile: stale });
  assert.equal(third.size, 0);
});

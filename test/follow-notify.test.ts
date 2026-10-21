import { test } from "node:test";
import assert from "node:assert/strict";
import { FollowNotices, noticeFrom, NOTICES_PER_ARTIST_PER_DAY, sendFollowNotice, type FollowNotice } from "../src/follow-notify.ts";
import type { Queryable } from "../src/follows.ts";

const NOTICE: FollowNotice = {
  target: "artist:iron-veil",
  key: "album:iron-veil-rust:songs",
  title: "New from Iron Veil: Rust",
  body: "The first song of Rust.",
  url: "https://live.streaming.pit.world/radio/album/iron-veil-rust",
};

/** Just enough Postgres for follow_claims and follow_notices. */
function fakeDb(): Queryable {
  const claims = new Map<string, string>();
  const notices: Array<{ target: string; key: string; account: string }> = [];
  return {
    async query(text: string, values: unknown[] = []) {
      const v = values.map(String);
      if (/CREATE TABLE/.test(text)) return { rows: [] };
      if (text.startsWith("INSERT INTO follow_claims")) {
        if (!claims.has(v[0]!)) claims.set(v[0]!, v[1]!);
        return { rows: [] };
      }
      if (text.startsWith("SELECT account_id FROM follow_claims")) return { rows: claims.has(v[0]!) ? [{ account_id: claims.get(v[0]!) }] : [] };
      if (text.startsWith("SELECT 1 FROM follow_notices")) return { rows: notices.filter((one) => one.target === v[0] && one.key === v[1]).map(() => ({ "?column?": 1 })) };
      if (text.includes("COUNT(*) FILTER")) {
        return { rows: [{ artist: notices.filter((one) => one.target === v[0]).length, account: notices.filter((one) => one.account === v[1]).length }] };
      }
      if (text.startsWith("INSERT INTO follow_notices")) {
        if (notices.some((one) => one.target === v[0] && one.key === v[1])) return { rows: [] };
        notices.push({ target: v[0]!, key: v[1]!, account: v[2]! });
        return { rows: [{ "?column?": 1 }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test("a notice names an artist, a key, a title and a /radio page of ours, nothing else", () => {
  assert.deepEqual(noticeFrom(NOTICE), NOTICE);
  assert.equal(noticeFrom({ ...NOTICE, target: "streamer-1" }), null);
  assert.equal(noticeFrom({ ...NOTICE, url: "https://evil.example/radio/album/x" }), null, "only our hosts");
  assert.equal(noticeFrom({ ...NOTICE, url: "https://live.streaming.pit.world/watch?play=x" }), null, "only /radio pages");
  assert.equal(noticeFrom({ ...NOTICE, url: "http://live.streaming.pit.world/radio/x" }), null);
  assert.equal(noticeFrom({ ...NOTICE, title: "" }), null);
  assert.equal(noticeFrom({ ...NOTICE, key: "has spaces" }), null);
  assert.equal(noticeFrom({ ...NOTICE, title: "a\nb" })!.title, "a b");
});

test("an artist is told by the account that first announced it, once per key, a few times a day", async () => {
  const notices = new FollowNotices(fakeDb());
  assert.equal(await notices.accept("server-owner", NOTICE), "accepted");
  assert.equal(await notices.accept("server-owner", NOTICE), "duplicate", "the same album's first song is told once");
  assert.equal(await notices.accept("somebody-else", { ...NOTICE, key: "album:iron-veil-rust:done" }), "not_yours");
  for (let n = 1; n < NOTICES_PER_ARTIST_PER_DAY; n += 1) assert.equal(await notices.accept("server-owner", { ...NOTICE, key: `album:a${n}:done` }), "accepted");
  assert.equal(await notices.accept("server-owner", { ...NOTICE, key: "album:one-more:done" }), "too_many");
});

test("a server tells nixamp.com signed in as itself, and never throws", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ result: "accepted", told: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await sendFollowNotice({ site: "https://nixamp.com", token: "tok", fetcher }, NOTICE), "accepted");
  assert.equal(sent[0]!.url, "https://nixamp.com/api/v1/follows/notify");
  assert.equal((sent[0]!.init.headers as Record<string, string>)["authorization"], "Bearer tok");
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), NOTICE);
  assert.equal(await sendFollowNotice({ site: "https://nixamp.com", token: "", fetcher }, NOTICE), "unsigned");
  const broken = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal(await sendFollowNotice({ site: "https://nixamp.com", token: "tok", fetcher: broken }, NOTICE), "unreachable");
});

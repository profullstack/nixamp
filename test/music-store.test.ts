import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, makeGrant, MusicStore, readGrant } from "../src/music-store.ts";
import type { Db, Support } from "../src/support.ts";

/** Just enough of Postgres for music_purchases. */
function fakeDb(): Db & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const cols = ["id", "token", "email", "user_id", "server", "kind", "artist", "album", "n", "title", "artist_name", "amount_cents", "coin", "payment_id", "created_at"];
  return {
    rows,
    async query(text: string, params: unknown[] = []) {
      if (/^CREATE/.test(text.trim())) return { rows: [] };
      if (text.includes("INSERT INTO music_purchases")) {
        rows.push({ ...Object.fromEntries(cols.map((name, i) => [name, params[i]])), status: "pending", paid_at: null });
        return { rows: [] };
      }
      if (text.includes("SET status = 'paid'")) {
        const one = rows.find((r) => r["id"] === params[0] && r["status"] === "pending");
        if (!one) return { rows: [] };
        one["status"] = "paid";
        one["paid_at"] = params[1];
        return { rows: [one] };
      }
      if (text.includes("WHERE id = $1 AND token = $2")) return { rows: rows.filter((r) => r["id"] === params[0] && r["token"] === params[1]) };
      if (text.includes("WHERE payment_id = $1")) return { rows: rows.filter((r) => r["payment_id"] === params[0]) };
      if (text.includes("WHERE id = $1")) return { rows: rows.filter((r) => r["id"] === params[0]) };
      if (text.includes("user_id = $1 OR lower(email)")) return { rows: rows.filter((r) => r["status"] === "paid" && (r["user_id"] === params[0] || String(r["email"]).toLowerCase() === String(params[1]).toLowerCase())) };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const CATALOGUE = {
  holder: "Profullstack, Inc.",
  genres: [{ genre: "Pop", artists: [{ key: "aaaaaaaaaa", name: "Lumi Kestrel", albums: [{ key: "bbbbbbbb", title: "Record 1", year: 2026, songs: [{ n: 1, title: "One" }, { n: 2, title: "Two" }] }] }] }],
};

function setup() {
  const db = fakeDb();
  const paid = new Set<string>();
  const payments: Array<Record<string, unknown>> = [];
  const mails: string[] = [];
  const support = {
    async pay(input: Record<string, unknown>) {
      payments.push(input);
      return { url: `https://coinpayportal.com/pay/pay_${payments.length}xyz`, paymentId: `pay_${payments.length}xyz` };
    },
    async isPaid(id: string) { return paid.has(id); },
  } as unknown as Support;
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/label")) return new Response(JSON.stringify(CATALOGUE), { status: 200 });
    if (url.includes("resend")) { mails.push(String(init?.body)); return new Response("{}", { status: 200 }); }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const store = new MusicStore({ db, support, mail: { apiKey: "re_x", from: "nixamp <n@nixamp.com>" }, site: "https://nixamp.com", secret: "s3cret", servers: () => ["https://server1.example.com:4321"], fetcher });
  return { db, store, paid, payments, mails };
}

test("grants are signed, expire, and cover only what was bought", () => {
  const scope = { server: "https://s.example", kind: "album" as const, artist: "aaaaaaaaaa", album: "bbbbbbbb", n: 0 };
  const grant = makeGrant("k", scope, Date.now() + 60_000);
  assert.deepEqual({ ...readGrant("k", grant)!, exp: 0 }, { ...scope, exp: 0 });
  assert.equal(readGrant("other", grant), null);
  assert.equal(readGrant("k", makeGrant("k", scope, Date.now() - 1)), null);
  assert.equal(readGrant("k", grant.replace("album", "artist")), null, "a changed scope breaks the signature");
  assert.ok(covers(scope, "aaaaaaaaaa", "bbbbbbbb", 2));
  assert.ok(!covers(scope, "aaaaaaaaaa", "cccccccc", 1));
  assert.ok(covers({ ...scope, kind: "artist", album: "" }, "aaaaaaaaaa", "cccccccc", 1));
  assert.ok(!covers({ ...scope, kind: "song", n: 1 }, "aaaaaaaaaa", "bbbbbbbb", 2));
});

test("buy: 10 cents a song, $1 an album, $2 an artist; paid once, mailed once, then in the account", async () => {
  const { store, paid, payments, mails, db } = setup();
  const server = "https://server1.example.com:4321";
  await assert.rejects(store.checkout({ server: "https://evil.example", kind: "song", artist: "aaaaaaaaaa", album: "bbbbbbbb", n: 1, email: "a@b.co", coin: "SOL" }, null), /does not sell/);
  await assert.rejects(store.checkout({ server, kind: "song", artist: "aaaaaaaaaa", album: "bbbbbbbb", n: 9, email: "a@b.co", coin: "SOL" }, null), /No such music/);
  await assert.rejects(store.checkout({ server, kind: "album", artist: "aaaaaaaaaa", album: "bbbbbbbb", coin: "SOL" }, null), /email/);
  const song = await store.checkout({ server, kind: "song", artist: "aaaaaaaaaa", album: "bbbbbbbb", n: 2, email: "Fan@Example.com", coin: "sol" }, null);
  const album = await store.checkout({ server, kind: "album", artist: "aaaaaaaaaa", album: "bbbbbbbb", email: "fan@example.com", coin: "SOL" }, null);
  const artist = await store.checkout({ server, kind: "artist", artist: "aaaaaaaaaa", coin: "SOL" }, { id: "user-1", email: "fan@example.com" });
  assert.deepEqual(payments.map((one) => one["amountUsd"]), [0.1, 1, 2]);
  assert.match(String(payments[1]!["redirect"]), new RegExp(`^https://nixamp.com/purchases/${album.id}\\?t=`));
  // Not paid yet: the receipt waits, and the account sees nothing.
  assert.equal((await store.get(song.id, song.token))!.status, "pending");
  assert.equal((await store.forAccount({ id: "user-1", email: "fan@example.com" })).length, 0);
  // The webhook settles one; coming back to the page settles another.
  paid.add("pay_1xyz");
  paid.add("pay_2xyz");
  assert.deepEqual(await store.settle("pay_1xyz"), { settled: true, purchase: song.id });
  assert.deepEqual(await store.settle("pay_1xyz"), { settled: true, purchase: song.id });
  assert.equal((await store.get(album.id, album.token))!.status, "paid");
  assert.equal(await store.get(album.id, "wrong"), null);
  assert.equal(mails.length, 2, "one receipt each, however often it is settled");
  assert.match(mails[0]!, /Two/);
  assert.match(mails[0]!, new RegExp(`/purchases/${song.id}\\?t=${song.token}`));
  // The account (by its email, or by having bought signed in) sees both, with a grant and a zip address.
  const mine = await store.forAccount({ id: "user-1", email: "FAN@example.com" });
  assert.deepEqual(mine.map((one) => one.kind).sort(), ["album", "song"]);
  const view = store.view(mine[0]!);
  assert.match(String(view["zip"]), /^https:\/\/server1\.example\.com:4321\/api\/v1\/label\/zip\?grant=g1\./);
  assert.ok(store.check(String(view["grant"])));
  assert.equal(db.rows.find((one) => one["id"] === artist.id)!["user_id"], "user-1");
  assert.deepEqual(await store.settle("pay_unknown"), { settled: false });
});

test("a video on demand sells at the price its guide set, and its grant opens only its download", async () => {
  const db = fakeDb();
  const paid = new Set<string>();
  const payments: Array<Record<string, unknown>> = [];
  const support = {
    async pay(input: Record<string, unknown>) {
      payments.push(input);
      return { url: "https://coinpayportal.com/pay/pay_v1", paymentId: "pay_v1" };
    },
    async isPaid(id: string) { return paid.has(id); },
  } as unknown as Support;
  const vods: Record<string, unknown> = {
    hnhX1chd: { name: "House on Haunted Hill (1959)", artist: "William Castle", priceCents: 150 },
    free1234: { name: "Free one", artist: "" },
  };
  const fetcher = (async (url: string) => {
    const one = /^https:\/\/live\.streaming\.pit\.world\/api\/v1\/guide\/vods\/(.+)$/.exec(url);
    if (one && vods[one[1]!]) return new Response(JSON.stringify({ vod: vods[one[1]!] }), { status: 200 });
    if (url.includes("resend")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const store = new MusicStore({ db, support, mail: null, site: "https://nixamp.com", secret: "s3cret", servers: () => [], fetcher });
  const item = await store.describe({ server: "https://live.streaming.pit.world", kind: "vod", vod: "hnhX1chd" });
  assert.deepEqual([item.kind, item.artist, item.title, item.artistName, item.amountCents], ["vod", "hnhX1chd", "House on Haunted Hill (1959)", "William Castle", 150]);
  await assert.rejects(store.describe({ server: "https://live.streaming.pit.world", kind: "vod", vod: "free1234" }), /not sold/);
  await assert.rejects(store.describe({ server: "https://evil.example", kind: "vod", vod: "hnhX1chd" }), /does not sell/);
  await assert.rejects(store.describe({ server: "https://live.streaming.pit.world", kind: "vod", vod: "nope9999" }), /No such video/);

  const made = await store.checkout({ server: "https://live.streaming.pit.world", kind: "vod", vod: "hnhX1chd", email: "a@b.co" }, null);
  assert.equal(payments[0]!["amountUsd"], 1.5);
  paid.add("pay_v1");
  const purchase = (await store.get(made.id, made.token))!;
  assert.equal(purchase.status, "paid");
  const zip = store.zipUrl(purchase);
  assert.match(zip, /^https:\/\/live\.streaming\.pit\.world\/api\/v1\/guide\/vods\/hnhX1chd\/download\?grant=g1\./);
  const scope = readGrant("s3cret", decodeURIComponent(zip.split("grant=")[1]!))!;
  assert.deepEqual([scope.kind, scope.artist, scope.server], ["vod", "hnhX1chd", "https://live.streaming.pit.world"]);
  // A video's grant never opens the label's music.
  assert.equal(covers(scope, "hnhX1chd", ""), false);
});

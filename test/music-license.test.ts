import { test } from "node:test";
import assert from "node:assert/strict";
import { creditLine, licenseTerms, LICENSE_PRICES, MusicLicenses } from "../src/music-license.ts";
import { handleLicenseRoutes } from "../src/license-routes.ts";

const COLUMNS = ["id", "code", "token", "email", "user_id", "licensee", "project", "project_url", "tier", "kind", "server", "artist", "album", "n",
  "title", "artist_name", "credit_url", "amount_cents", "coin", "payment_id", "terms", "created_at"];

/** Just enough of Postgres for music-license.ts's queries. */
function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, " ").trim();
      if (sql.startsWith("CREATE")) return { rows: [] };
      if (sql.startsWith("INSERT INTO music_licenses")) {
        rows.push({ ...Object.fromEntries(COLUMNS.map((name, at) => [name, params[at]])), status: "pending", paid_at: null, expires_at: null });
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE music_licenses SET status = 'paid'")) {
        const one = rows.find((r) => r["id"] === params[0] && r["status"] === "pending");
        if (!one) return { rows: [] };
        Object.assign(one, { status: "paid", paid_at: params[1], expires_at: one["kind"] === "catalog" ? params[2] : null });
        return { rows: [one] };
      }
      if (sql.includes("WHERE id = $1 AND token = $2")) return { rows: rows.filter((r) => r["id"] === params[0] && r["token"] === params[1]) };
      if (sql.includes("WHERE code = $1 AND status = 'paid'")) return { rows: rows.filter((r) => r["code"] === params[0] && r["status"] === "paid") };
      if (sql.startsWith("SELECT 1 FROM music_licenses WHERE payment_id")) return { rows: rows.filter((r) => r["payment_id"] === params[0]) };
      if (sql.startsWith("SELECT id, status FROM music_licenses")) return { rows: rows.filter((r) => r["payment_id"] === params[0]) };
      if (sql.startsWith("SELECT * FROM music_licenses WHERE id = $1")) return { rows: rows.filter((r) => r["id"] === params[0]) };
      if (sql.includes("user_id = $1 OR lower(email)")) return { rows: rows.filter((r) => r["status"] === "paid" && (r["user_id"] === params[0] || String(r["email"]) === String(params[1]).toLowerCase())) };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function setup(now = Date.UTC(2026, 9, 21)) {
  const db = fakeDb();
  const paid = new Set<string>();
  const payments: Array<{ amountUsd: number; description: string }> = [];
  const support = {
    pay: async (input: { amountUsd: number; description: string }) => { payments.push(input); return { url: `https://coinpayportal.com/pay/p${payments.length}`, paymentId: `p${payments.length}` }; },
    isPaid: async (id: string) => paid.has(id),
  };
  const store = {
    describe: async (input: Record<string, unknown>) => {
      if (input["artist"] !== "0243b45872") throw new Error("No such music.");
      return { server: "https://server1.example:4321", kind: input["kind"] as "song", artist: "0243b45872", album: "aaaa1111", n: Number(input["n"] ?? 0),
        title: input["kind"] === "album" ? "Sailing into Sunset (2026)" : "Island Weekend", artistName: "Marina Del Gray", amountCents: 10, songs: 1 };
    },
  };
  const licenses = new MusicLicenses({ db: db as never, support: support as never, store: store as never, mail: null, site: "https://nixamp.com", serverId: () => "f5fd7d9747", now: () => now });
  return { db, paid, payments, licenses };
}

const order = { tier: "indie", kind: "song", server: "f5fd7d9747", artist: "0243b45872", album: "aaaa1111", n: 1, licensee: "Tiny Studio", project: "Harbor Run", projectUrl: "https://tiny.example/harbor", email: "Dev@Tiny.example", coin: "usdc_pol", agree: true };

test("prices: Creator $5, Indie $25 a song or $100 an album, Commercial $250, the Catalog pass $29 a year; nothing else is sold", async () => {
  const { licenses } = setup();
  assert.equal((await licenses.quote({ ...order, tier: "creator" })).amountCents, 500);
  assert.equal((await licenses.quote(order)).amountCents, 2500);
  assert.equal((await licenses.quote({ ...order, kind: "album" })).amountCents, 10000);
  assert.equal((await licenses.quote({ ...order, tier: "commercial" })).amountCents, 25000);
  const pass = await licenses.quote({ kind: "catalog" });
  assert.deepEqual([pass.tier, pass.amountCents, pass.title], ["catalog", 2900, "Every artist released by Profullstack, Inc."]);
  await assert.rejects(licenses.quote({ ...order, tier: "creator", kind: "album" }), /not sold/);
  await assert.rejects(licenses.quote({ ...order, tier: "commercial", kind: "album" }), /not sold/);
  assert.deepEqual(Object.keys(LICENSE_PRICES), ["creator", "indie", "commercial", "catalog"]);
});

test("checkout needs the terms agreed, who, which project and an email; it asks CoinPay for the price", async () => {
  const { licenses, payments, db } = setup();
  await assert.rejects(licenses.checkout({ ...order, agree: false }, null), /terms/);
  await assert.rejects(licenses.checkout({ ...order, licensee: "" }, null), /who the licence is for/);
  await assert.rejects(licenses.checkout({ ...order, project: " " }, null), /project/);
  await assert.rejects(licenses.checkout({ ...order, email: "nope" }, null), /email/);
  const made = await licenses.checkout(order, null);
  assert.match(made.code, /^NXL-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(payments[0]!.amountUsd, 25);
  assert.match(payments[0]!.description, /Indie licence: Island Weekend by Marina Del Gray for Harbor Run/);
  assert.equal(db.rows[0]!["email"], "dev@tiny.example");
  assert.equal(db.rows[0]!["credit_url"], "https://nixamp.com/music/artist/f5fd7d9747/0243b45872");
  // Not paid: nobody can look it up by code yet.
  assert.equal(await licenses.byCode(made.code), null);
});

test("paid: the certificate is active and checkable; a catalogue pass runs a year and then stops covering new projects", async () => {
  const start = Date.UTC(2026, 9, 21);
  let now = start;
  const { licenses, paid } = setup();
  (licenses as unknown as { options: { now: () => number } }).options.now = () => now;
  const song = await licenses.checkout(order, null);
  const pass = await licenses.checkout({ kind: "catalog", licensee: "Tiny Studio", project: "Tiny Studio games", email: "dev@tiny.example", coin: "sol", agree: true }, null);
  paid.add("p1"); paid.add("p2");
  assert.deepEqual(await licenses.settle("p1"), { settled: true, license: song.id });
  assert.equal((await licenses.settle("p2")).settled, true);
  const one = (await licenses.byCode(song.code))!;
  assert.equal(one.expiresAt, 0);
  assert.equal(licenses.view(one, false)["active"], true);
  assert.equal(creditLine(one), `Music: "Island Weekend" by Marina Del Gray (https://nixamp.com/music/artist/f5fd7d9747/0243b45872), licensed on nixamp (${song.code})`);
  const year = (await licenses.byCode(pass.code))!;
  assert.equal(year.expiresAt, start + 365 * 24 * 3600_000);
  assert.equal(licenses.view(year, false)["active"], true);
  now = start + 366 * 24 * 3600_000;
  assert.equal(licenses.view(year, false)["active"], false);
  // The public view carries no email or payment.
  assert.equal(licenses.view(one, false)["email"], undefined);
});

test("the pages: a licence form per tier, the terms, a public check that does not know unpaid codes", async () => {
  const { licenses } = setup();
  const ask = async (path: string) => {
    let status = 0;
    let body = "";
    const response = { headersSent: false, setHeader: () => undefined, writeHead: (code: number) => { status = code; return response; }, end: (text?: string) => { body = String(text ?? ""); } };
    const url = new URL(path, "https://nixamp.com");
    await handleLicenseRoutes({ method: "GET", url: path, headers: {} } as never, response as never, url.pathname, url,
      { licenses, account: async () => null, json: (res, code, value) => { status = code; body = JSON.stringify(value); void res; }, readBody: async () => "", serverId: () => "f5fd7d9747", site: "https://nixamp.com" });
    return { status, body };
  };
  const song = await ask("/license?server=f5fd7d9747&kind=song&artist=0243b45872&album=aaaa1111&n=1");
  assert.equal(song.status, 200);
  for (const tier of ["Creator", "Indie", "Commercial"]) assert.match(song.body, new RegExp(`<strong>${tier}</strong>`));
  assert.match(song.body, /value="indie"[^>]*checked/);
  assert.match(song.body, /licence terms/);
  const pass = await ask("/license?kind=catalog");
  assert.match(pass.body, /Catalog pass.*\$29\/year/s);
  assert.doesNotMatch(pass.body, /<strong>Creator<\/strong>/);
  const terms = await ask("/license/terms");
  assert.equal(terms.status, 200);
  for (const one of licenseTerms("Profullstack, Inc.", "https://nixamp.com")) assert.ok(terms.body.includes(one.heading), one.heading);
  assert.match(terms.body, /Content ID/);
  assert.equal((await ask("/license/NXL-AAAA-BBBB")).status, 404);
});

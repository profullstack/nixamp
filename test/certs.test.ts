import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryZone } from "../src/dns.ts";
import { AcmeIssuer, Certs, type Challenge, type Issued, type Issuer } from "../src/certs.ts";
import type { Queryable } from "../src/follows.ts";

const DAY = 24 * 60 * 60 * 1000;

/** A database that remembers what it was asked and answers from a script. */
function db(answers: Record<string, () => Record<string, unknown>[]> = {}) {
  const asked: { text: string; values: unknown[] }[] = [];
  const queryable: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows: rows() };
      }
      return { rows: [] };
    },
  };
  return { asked, queryable, sql: () => asked.map((a) => a.text).join("\n") };
}

/** A CA that hands back whatever it is told to, after we let it. */
function issuer(outcome: Issued | Error = { cert: "CERT", key: "KEY", expiresAt: 0 }) {
  const calls: { names: string[]; set: [string, string][]; cleared: [string, string][] }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => { release = done; });
  const fake: Issuer = {
    async issue(names, challenge: Challenge) {
      const call = { names, set: [] as [string, string][], cleared: [] as [string, string][] };
      calls.push(call);
      await challenge.set(`_acme-challenge.${names[1]}`, "token-1");
      call.set.push([`_acme-challenge.${names[1]}`, "token-1"]);
      await gate;
      await challenge.clear(`_acme-challenge.${names[1]}`, "token-1");
      call.cleared.push([`_acme-challenge.${names[1]}`, "token-1"]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { fake, calls, release: () => release() };
}

test("the names a handle's certificate covers", () => {
  const certs = new Certs(db().queryable, new MemoryZone("nixamp.com"), issuer().fake);
  assert.deepEqual(certs.namesFor("chovy"), ["*.chovy.nixamp.com", "chovy.nixamp.com"]);
});

test("a first request starts an order in the background and answers issuing, then ready", async () => {
  let now = 1_000_000;
  const expiresAt = now + 90 * DAY;
  const zone = new MemoryZone("nixamp.com");
  const store = db();
  const ca = issuer({ cert: "CERT", key: "KEY", expiresAt });
  const lines: string[] = [];
  const certs = new Certs(store.queryable, zone, ca.fake, { now: () => now, log: (line) => lines.push(line) });

  const first = await certs.forHandle("chovy");
  assert.deepEqual(first, { status: "issuing", since: now });
  assert.equal(ca.calls.length, 1);
  assert.deepEqual(ca.calls[0]?.names, ["*.chovy.nixamp.com", "chovy.nixamp.com"]);
  // The challenge went to the zone, at the apex of the handle, as a TXT.
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual((await zone.list("_acme-challenge.chovy.nixamp.com", "TXT")).map((r) => r.content), ["token-1"]);

  // Asked again while the CA is thinking: still issuing, and not a second order.
  assert.equal((await certs.forHandle("chovy")).status, "issuing");
  assert.equal(ca.calls.length, 1);

  ca.release();
  await certs.settle("chovy");
  // Stored, and the challenge tidied away.
  const upsert = store.asked.find((a) => a.text.includes("INSERT INTO certs"));
  assert.deepEqual(upsert?.values.slice(0, 3), ["chovy", "CERT", "KEY"]);
  assert.deepEqual(await zone.list("_acme-challenge.chovy.nixamp.com", "TXT"), []);
  assert.match(lines.join("\n"), /Ordering a certificate/);
  assert.match(lines.join("\n"), /issued, good for 90 days/);

  // From now on the row answers. The fake db is scripted, so script it.
  const ready = new Certs(
    db({ "SELECT cert, key, expires_at": () => [{ cert: "CERT", key: "KEY", expires_at: new Date(expiresAt) }] }).queryable,
    zone,
    ca.fake,
    { now: () => now },
  );
  assert.deepEqual(await ready.forHandle("chovy"), { status: "ready", cert: "CERT", key: "KEY", expiresAt, renewing: false });
  assert.equal(ca.calls.length, 1);
});

test("a certificate near its end is still the answer, and a renewal starts alongside", async () => {
  const now = 5_000_000;
  const expiresAt = now + 10 * DAY;
  const ca = issuer({ cert: "NEW", key: "NEWKEY", expiresAt: now + 90 * DAY });
  const certs = new Certs(
    db({ "SELECT cert, key, expires_at": () => [{ cert: "OLD", key: "OLDKEY", expires_at: new Date(expiresAt).toISOString() }] }).queryable,
    new MemoryZone("nixamp.com"),
    ca.fake,
    { now: () => now },
  );
  const state = await certs.forHandle("chovy");
  assert.equal(state.status, "ready");
  if (state.status === "ready") {
    assert.deepEqual({ cert: state.cert, renewing: state.renewing }, { cert: "OLD", renewing: true });
  }
  // Two askers, one order.
  await certs.forHandle("chovy");
  assert.equal(ca.calls.length, 1);
  ca.release();
  await certs.settle("chovy");
});

test("a CA that refuses is remembered for an hour, then asked again", async () => {
  let now = 9_000_000;
  const ca = issuer(new Error("rateLimited: too many certificates"));
  const lines: string[] = [];
  const certs = new Certs(db().queryable, new MemoryZone("nixamp.com"), ca.fake, {
    now: () => now,
    retryAfterMs: 60 * 60 * 1000,
    log: (line) => lines.push(line),
  });
  assert.equal((await certs.forHandle("chovy")).status, "issuing");
  ca.release();
  await certs.settle("chovy");

  const failed = await certs.forHandle("chovy");
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(failed.error, /rateLimited/);
  assert.equal(ca.calls.length, 1, "a failure does not mean try again at once");
  assert.match(lines.join("\n"), /failed: rateLimited/);

  now += 30 * 60 * 1000;
  assert.equal((await certs.forHandle("chovy")).status, "failed");
  assert.equal(ca.calls.length, 1);

  now += 31 * 60 * 1000;
  assert.equal((await certs.forHandle("chovy")).status, "issuing");
  assert.equal(ca.calls.length, 2);
});

test("the ACME account key is made once and kept", async () => {
  let kept = "";
  const store = db({
    "SELECT key_pem": () => (kept ? [{ key_pem: kept }] : []),
  });
  const certs = new Certs(store.queryable, new MemoryZone("nixamp.com"), issuer().fake);
  const first = await certs.accountKey();
  assert.match(first, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/);
  const inserted = store.asked.find((a) => a.text.includes("INSERT INTO acme_account"));
  assert.equal(inserted?.values[0], first);
  kept = first;
  const second = await certs.accountKey();
  assert.equal(second, first);
  assert.equal(store.asked.filter((a) => a.text.includes("INSERT INTO acme_account")).length, 1);
});

test("the real issuer is built for DNS-01 against a directory, and nothing else", () => {
  const real = new AcmeIssuer({
    directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory",
    email: "ops@nixamp.com",
    accountKey: async () => "KEY",
  });
  assert.ok(real instanceof AcmeIssuer);
  // Nothing to issue is refused before any network is touched.
  return assert.rejects(real.issue([], { set: async () => undefined, clear: async () => undefined }), /nothing to issue/);
});

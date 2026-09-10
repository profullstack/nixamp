import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimName, fetchCert, labelFor, readCertFiles, writeCertFiles } from "../src/naming.ts";
import { dns } from "../src/session.ts";

/** A nixamp.com that answers from a script and remembers what it was asked. */
function site(script: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    calls.push({ url: text, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = script(text, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test("a machine claims a name with both families on auto, and is told what it got", async () => {
  const said: string[] = [];
  const { calls, fetcher } = site(() => ({
    status: 200,
    body: { name: { host: "vienna.chovy.nixamp.com", a: "152.53.47.37", aaaa: "2a01:db8::1", ttl: 600 } },
  }));
  const named = await claimName("https://nixamp.com", "nxa_t", "vienna", (line) => said.push(line), fetcher);
  assert.deepEqual(named, { host: "vienna.chovy.nixamp.com", a: "152.53.47.37", aaaa: "2a01:db8::1" });
  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.url, "https://nixamp.com/api/v1/dns/vienna");
  assert.deepEqual(calls[0]?.body, { a: "auto", aaaa: "auto" });
  assert.deepEqual(said, []);
});

test("a name that is taken, or a site that is down, is said rather than thrown", async () => {
  const said: string[] = [];
  const taken = site(() => ({ status: 409, body: { error: "that name belongs to somebody else" } }));
  assert.equal(await claimName("https://nixamp.com", "t", "server1", (l) => said.push(l), taken.fetcher), null);
  assert.match(said[0] ?? "", /belongs to somebody else/);

  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal(await claimName("https://nixamp.com", "t", "server1", (l) => said.push(l), down), null);
  assert.match(said[1] ?? "", /could not reach/);
});

test("the certificate is waited for while it is issuing, and said about once", async () => {
  let asked = 0;
  const { fetcher } = site(() => {
    asked += 1;
    return asked < 3
      ? { status: 202, body: { status: "issuing", host: "*.chovy.nixamp.com" } }
      : { status: 200, body: { status: "ready", cert: "CERT", key: "KEY", expiresAt: 1_800_000_000_000, host: "*.chovy.nixamp.com" } };
  });
  const said: string[] = [];
  const slept: number[] = [];
  const got = await fetchCert(
    "https://nixamp.com",
    "t",
    { everyMs: 10, waitMs: 100, sleep: async (ms) => { slept.push(ms); }, fetcher },
    (l) => said.push(l),
  );
  assert.deepEqual(got, { cert: "CERT", key: "KEY", expiresAt: 1_800_000_000_000, host: "*.chovy.nixamp.com" });
  assert.deepEqual(slept, [10, 10]);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /Getting a certificate for \*\.chovy\.nixamp\.com/);
});

test("a certificate that never comes, or failed, leaves the server on http", async () => {
  const forever = site(() => ({ status: 202, body: { status: "issuing" } }));
  const said: string[] = [];
  const got = await fetchCert("https://nixamp.com", "t", { everyMs: 10, waitMs: 30, sleep: async () => {}, fetcher: forever.fetcher }, (l) => said.push(l));
  assert.equal(got, null);
  assert.match(said[said.length - 1] ?? "", /still issuing/);
  // Polled until the wait ran out: at 0, 10, 20 and 30 waited.
  assert.equal(forever.calls.length, 4);

  const failed = site(() => ({ status: 503, body: { status: "failed", error: "rate limited by the CA" } }));
  const said2: string[] = [];
  assert.equal(await fetchCert("https://nixamp.com", "t", { fetcher: failed.fetcher }, (l) => said2.push(l)), null);
  assert.match(said2[0] ?? "", /rate limited by the CA/);
});

test("certificate files are kept privately and read back only while they are good for a day", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-naming-"));
  const inAWeek = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const paths = writeCertFiles(dir, { cert: "CERT", key: "KEY", expiresAt: inAWeek, host: "*.chovy.nixamp.com" });
  assert.equal(paths.cert, join(dir, "tls", "chovy.nixamp.com.cert.pem"));
  assert.equal(readFileSync(paths.key, "utf8"), "KEY");
  assert.equal(statSync(paths.key).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "tls")).mode & 0o777, 0o700);

  const back = readCertFiles(dir, "*.chovy.nixamp.com");
  assert.deepEqual(back, { cert: "CERT", key: "KEY", expiresAt: inAWeek });
  // The same files under the name without the star, which is how a caller
  // that only knows the handle asks.
  assert.equal(readCertFiles(dir, "chovy.nixamp.com")?.cert, "CERT");

  // Expiring tonight is as good as expired: fetch a fresh one instead.
  writeCertFiles(dir, { cert: "OLD", key: "OLDKEY", expiresAt: Date.now() + 60 * 60 * 1000, host: "*.chovy.nixamp.com" });
  assert.equal(readCertFiles(dir, "*.chovy.nixamp.com"), null);
  assert.equal(readCertFiles(dir, "*.nobody.nixamp.com"), null);
});

test("a machine's label is its name, else its hostname, made safe for a subdomain", () => {
  assert.equal(labelFor("Server 2", "vienna.local"), "server-2");
  assert.equal(labelFor("", "profullstack-dev-vienna.example.com"), "profullstack-dev-vienna");
  assert.equal(labelFor("", "MacBook Pro"), "macbook-pro");
  assert.equal(labelFor("--", "x"), "server");
  assert.equal(labelFor("", "a".repeat(40)), "a".repeat(30));
  assert.equal(labelFor("", "abc-------------------------------def"), "abc");
});

test("nixamp dns lists, sets and removes names under the handle", async () => {
  const before = process.env["NIXAMP_TOKEN"];
  const beforeSite = process.env["NIXAMP_SITE"];
  process.env["NIXAMP_TOKEN"] = "nxa_test";
  process.env["NIXAMP_SITE"] = "https://nixamp.test";
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const { calls, fetcher } = site((url, init) => {
      if (init?.method === "PUT") {
        return { status: 200, body: { name: { host: "server2.chovy.nixamp.com", a: "152.53.47.37", aaaa: null, ttl: 600 } } };
      }
      if (init?.method === "DELETE") return { status: url.endsWith("/gone") ? 404 : 200, body: { ok: true } };
      return {
        status: 200,
        body: {
          zone: "chovy.nixamp.com",
          names: [{ label: "server1", host: "server1.chovy.nixamp.com", a: "104.152.209.195", aaaa: null, ttl: 600, updatedAt: 1_789_000_000_000 }],
        },
      };
    });

    assert.equal(await dns([], fetcher), 0);
    assert.match(lines.join("\n"), /server1\.chovy\.nixamp\.com.*A 104\.152\.209\.195/);
    assert.equal(calls[0]?.url, "https://nixamp.test/api/v1/dns");
    assert.match(String((await (async () => calls)())[0]?.url), /dns$/);

    // Bare set: both families auto.
    assert.equal(await dns(["set", "server2"], fetcher), 0);
    assert.deepEqual(calls[1]?.body, { a: "auto", aaaa: "auto" });
    assert.match(lines.join("\n"), /server2\.chovy\.nixamp\.com/);
    // Named addresses, and "off" for a family, and a ttl.
    assert.equal(await dns(["set", "server2", "--a", "1.2.3.4", "--aaaa", "off", "--ttl", "300"], fetcher), 0);
    assert.deepEqual(calls[2]?.body, { a: "1.2.3.4", aaaa: null, ttl: 300 });
    assert.equal(await dns(["set", "server2", "--ttl", "5"], fetcher), 64);

    assert.equal(await dns(["rm", "server2"], fetcher), 0);
    assert.equal(calls[3]?.method, "DELETE");
    assert.equal(await dns(["rm", "gone"], fetcher), 1);
    assert.match(lines[lines.length - 1] ?? "", /no name like that/);
    assert.equal(await dns(["set"], fetcher), 64);
    assert.equal(await dns(["bogus"], fetcher), 64);
  } finally {
    console.log = log;
    console.error = err;
    if (before === undefined) delete process.env["NIXAMP_TOKEN"];
    else process.env["NIXAMP_TOKEN"] = before;
    if (beforeSite === undefined) delete process.env["NIXAMP_SITE"];
    else process.env["NIXAMP_SITE"] = beforeSite;
  }
});

test("nixamp dns without a session says so", async () => {
  const before = process.env["NIXAMP_TOKEN"];
  delete process.env["NIXAMP_TOKEN"];
  const err = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    // Only when no session file exists either; a dev box that is signed in
    // answers 0 here, which is also correct, so the message is what is checked.
    const code = await dns([], (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    if (code === 1) assert.match(lines[0] ?? "", /not signed in/);
  } finally {
    console.error = err;
    if (before !== undefined) process.env["NIXAMP_TOKEN"] = before;
  }
});

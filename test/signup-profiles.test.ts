import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import type { AddressInfo } from "node:net";
import { createProfileStore } from "@profullstack/profile";
import { Accounts, type AuthLike } from "../src/accounts.ts";
import { createServer, EmptyEngine } from "../src/server.ts";

const account = { id: "u1", email: "ada@acme.com" };
const fakeAuth = (): AuthLike => ({
  register: async () => ({ user: account, tokens: { accessToken: "jwt" } }),
  login: async () => ({ user: account, tokens: { accessToken: "jwt" } }),
  validateToken: async (token: string) => (token === "jwt" ? { userId: account.id, email: account.email } : null),
});

/** nixamp.com's sign-up and profile routes on a port, the profiles in an in-memory SQLite. */
async function withSite(body: (base: string, store: ReturnType<typeof createProfileStore>) => Promise<void>): Promise<void> {
  const store = createProfileStore(new Database(":memory:"));
  await store.migrate();
  const accounts = new Accounts({ connectionString: "", secret: "", system: fakeAuth() });
  const server = createServer(new EmptyEngine("nothing here"), {
    web: null,
    media: true,
    version: "test",
    accounts,
    signupProfiles: store,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const signUp = (base: string, fields: Record<string, string>) =>
  fetch(`${base}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: "password123", ...fields }),
  });

test("the web sign-up needs a first and last name, and keeps every field it is given", async () => {
  await withSite(async (base, store) => {
    const missing = await signUp(base, { first_name: "Ada", last_name: "" });
    assert.equal(missing.status, 400);
    assert.ok((await missing.json()).errors.last_name);
    assert.equal(await store.get(account.id), null);

    const made = await signUp(base, {
      first_name: "Ada",
      last_name: "Lovelace",
      company_domain: "https://www.Acme.com/about",
      job_title: "VP Engineering",
      linkedin_url: "in/ada-lovelace",
    });
    assert.equal(made.status, 200);
    const saved = await store.get(account.id);
    assert.equal(saved?.email, "ada@acme.com");
    assert.equal(saved?.first_name, "Ada");
    assert.equal(saved?.last_name, "Lovelace");
    assert.equal(saved?.company_domain, "acme.com");
    assert.equal(saved?.job_title, "VP Engineering");
    assert.equal(saved?.linkedin_url, "https://www.linkedin.com/in/ada-lovelace");
  });
});

test("a terminal that sends no profile fields still signs up", async () => {
  await withSite(async (base, store) => {
    const made = await signUp(base, {});
    assert.equal(made.status, 200);
    assert.equal(await store.get(account.id), null);
  });
});

test("/api/v1/me/profile/fields reads and patches the signed-in account's fields", async () => {
  await withSite(async (base, store) => {
    const anonymous = await fetch(`${base}/api/v1/me/profile/fields`);
    assert.equal(anonymous.status, 401);

    await store.save(account.id, { email: account.email, first_name: "Ada", last_name: "Lovelace" });
    const auth = { authorization: "Bearer jwt", "content-type": "application/json" };
    const patched = await fetch(`${base}/api/v1/me/profile/fields`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ job_title: "CTO" }),
    });
    assert.equal(patched.status, 200);
    const read = await (await fetch(`${base}/api/v1/me/profile/fields`, { headers: auth })).json();
    assert.equal(read.profile.job_title, "CTO");
    assert.equal(read.profile.first_name, "Ada");
  });
});

test("on Postgres the table is made before the first query, with $n placeholders", async () => {
  const { signupProfiles } = await import("../src/signup-profiles.ts");
  const seen: string[] = [];
  const store = signupProfiles({
    query: async (text: string) => {
      seen.push(text);
      return { rows: [] };
    },
  });
  assert.equal(await store.get("u1"), null);
  assert.match(seen[0] ?? "", /create table if not exists "user_profiles" \(\s+"user_id" text primary key/);
  assert.match(seen[1] ?? "", /\$1/);
});

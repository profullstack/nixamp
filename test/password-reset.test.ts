import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresAdapter } from "@profullstack/auth-system";
import pg from "pg";
import { Accounts, type AdapterLike } from "../src/accounts.ts";
import { PasswordResets, RESET_INVALID, RESET_MESSAGE, resendPasswordReset } from "../src/password-reset.ts";
import { passwordResetPage } from "../src/password-reset-page.ts";
import { createServer, EmptyEngine } from "../src/server.ts";

test("reset mail contains a private expiring recovery link and no follower footer", async () => {
  let message: Record<string, unknown> = {};
  const send = resendPasswordReset({ apiKey: "test", from: "nixamp <test@example.com>", fetch: async (url, input) => {
    assert.equal(url, "https://api.resend.com/emails");
    message = JSON.parse(String(input?.body));
    return new Response("{}", { status: 200 });
  } });
  assert.equal(await send("recipient@example.com", "https://backtoschool.help/reset-password#token=secret"), true);
  assert.match(String(message.subject), /backtoschool.help/);
  assert.match(String(message.text), /30 minutes/);
  assert.match(String(message.text), /#token=secret/);
  assert.doesNotMatch(String(message.text), /follow them/);
});

test("recovery pages keep the token in the fragment and use native labelled forms", () => {
  const page = passwordResetPage("https://backtoschool.help", "test-nonce");
  assert.match(page, /BackToSchool.help/);
  assert.match(page, /autocomplete="new-password"/);
  assert.match(page, /role="status"/);
  assert.match(page, /history.replaceState/);
  assert.match(page, /script nonce="test-nonce"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|\.focus\(|scrollIntoView/);
});

test("password recovery persists single-use links and revokes old sessions atomically", {
  skip: !process.env["NIXAMP_TEST_DATABASE_URL"],
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env["NIXAMP_TEST_DATABASE_URL"] });
  const adapter = new PostgresAdapter({ pool }) as unknown as AdapterLike;
  const accounts = new Accounts({ connectionString: "", secret: "test-secret", adapter });
  const email = `reset-${randomUUID()}@example.com`;
  const signed = await accounts.signUp(email, "Old-password9");
  assert.equal(signed.ok, true);
  const account = signed.account!;
  const oldSession = await accounts.sessionFor(account);
  const cli = await accounts.mintCliToken(account, "test");
  const mails: { email: string; link: string }[] = [];
  const server = createServer(new EmptyEngine(), {
    web: null, media: false, version: "test", load: async () => [], accounts,
    webSites: new Map([["backtoschool.help", { site: "https://backtoschool.help", web: "/unused" }]]),
    resetMail: async (email, link) => { mails.push({ email, link }); return true; },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (action: string, body: unknown) => fetch(`${base}/api/v1/auth/password-reset/${action}`, {
    method: "POST", headers: { host: "backtoschool.help", "content-type": "application/json", "x-forwarded-host": "evil.example" }, body: JSON.stringify(body),
  });
  const token = () => new URLSearchParams(new URL(mails.at(-1)!.link).hash.slice(1)).get("token")!;
  try {
    const page = await fetch(`${base}/reset-password`, { headers: { host: "backtoschool.help" } });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /BackToSchool.help/);
    assert.deepEqual(await (await post("request", { email })).json(), { message: RESET_MESSAGE });
    assert.deepEqual(await (await post("request", { email: "unknown-" + email })).json(), { message: RESET_MESSAGE });
    assert.equal(mails.length, 1);
    assert.equal(new URL(mails[0]!.link).origin, "https://backtoschool.help");
    const first = token();
    const stored = (await pool.query("SELECT * FROM nixamp_password_resets WHERE user_id=$1", [account.id])).rows[0];
    assert.notEqual(stored.token_hash, first);
    assert.ok(!JSON.stringify(stored).includes(first));
    assert.ok(stored.expires_at.getTime() - Date.now() < 30 * 60_000);
    assert.equal(await accounts.whoIs(signed.token) !== null, true);
    assert.equal((await post("confirm", { token: first, password: "short" })).status, 422);
    await post("request", { email });
    const current = token();
    assert.notEqual(first, current);
    assert.equal((await post("confirm", { token: first, password: "New-password9" })).status, 400);
    // Two processes sharing the database: only one can consume the link.
    const restarted = new Accounts({ connectionString: "", secret: "test-secret", adapter });
    const outcomes = await Promise.all([
      accounts.passwordResets!.confirm(current, "New-password9"),
      restarted.passwordResets!.confirm(current, "New-password9"),
    ]);
    assert.deepEqual(outcomes.sort(), [null, RESET_INVALID].sort());
    assert.equal((await accounts.signIn(email, "Old-password9")).ok, false);
    assert.equal((await accounts.signIn(email, "New-password9")).ok, true);
    assert.equal(await accounts.whoIs(oldSession), null);
    assert.equal(await accounts.whoIs(cli!.token), null);
    assert.equal(await accounts.whoIs(signed.token), null);
    assert.equal((await post("confirm", { token: current, password: "Another-password9" })).status, 400);
    await post("request", { email });
    const expired = token();
    await pool.query("UPDATE nixamp_password_resets SET expires_at=now()-interval '1 minute' WHERE user_id=$1", [account.id]);
    assert.equal((await post("confirm", { token: expired, password: "Another-password9" })).status, 400);
    const sent = mails.length;
    await post("request", { email });
    assert.equal(mails.length, sent, "repeated requests to one address do not send more email");
    for (let n = 0; n < 8; n++) await post("request", { email: `other-${n}-${email}` });
    const limited = await post("request", { email });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query("DELETE FROM nixamp_tokens WHERE user_id=$1", [account.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [account.id]);
    await pool.end();
  }
});

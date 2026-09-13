import { test } from "node:test";
import assert from "node:assert/strict";
import { resendPasswordReset } from "../src/password-reset.ts";
import { resendEmail } from "../src/notify.ts";

test("reset and invitation mail select the school sender and key only for exact school hosts", async () => {
  const calls: {body: Record<string, unknown>; key: string | null}[] = [];
  const options = {
    apiKey: "nixamp-key", from: "nixamp <notifications@nixamp.com>",
    backtoschool: {apiKey: "school-key", from: "BackToSchool.help <notifications@backtoschool.help>"},
    fetch: (async (_: unknown, init?: RequestInit) => {
      calls.push({body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("authorization")});
      return Response.json({id: "test"});
    }) as typeof fetch,
  };
  const reset = resendPasswordReset(options);
  const invite = resendEmail({...options, reason: "You received this email because a host invited you to join a live session."});
  for (const host of ["backtoschool.help", "www.backtoschool.help", "nixamp.com", "backtoschool.help.evil.example"]) {
    const school = host === "backtoschool.help" || host === "www.backtoschool.help";
    const url = `https://${host}/reset-password#token=private`;
    assert.equal(await reset("to@example.com", url), true);
    assert.equal(await invite("to@example.com", {title: "Invitation", body: "Join this session", url}), true);
    for (const call of calls.slice(-2)) {
      assert.equal(call.key, `Bearer ${school ? "school-key" : "nixamp-key"}`);
      assert.equal(call.body.from, school ? options.backtoschool.from : options.from);
      assert.doesNotMatch(String(call.body.text), /follow them/);
    }
    assert.match(String(calls.at(-1)!.body.text), /host invited you/);
  }
});

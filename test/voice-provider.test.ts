import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceProviderFailure } from "../src/voice-provider.ts";
import { transientAudioError } from "../src/live-recovery.ts";

test("provider quota, billing and permissions are terminal even when ElevenLabs returns 401", async () => {
  for (const [code, status] of [["quota_exceeded", 402], ["subscription_required", 402], ["payment_issue", 402], ["invalid_api_key", 424], ["missing_permissions", 424]] as const) {
    const failure = await voiceProviderFailure(Response.json({ detail: { status: code, message: "private provider account data" } }, { status: 401 }));
    assert.equal(failure.error.status, status);
    assert.equal(transientAudioError(failure.error), false);
    assert.equal(failure.cooldownMs, 300_000);
    assert.doesNotMatch(failure.error.message, /private provider/);
    if (code === "payment_issue") assert.match(failure.error.message, /complete the outstanding ElevenLabs invoice/);
  }
});

test("malformed failures are safe and rate-limit cooldowns are bounded", async () => {
  const unknown = await voiceProviderFailure(new Response("private body", { status: 401 }));
  assert.equal(unknown.error.status, 424);
  assert.equal(unknown.code, "unknown");
  const retry = await voiceProviderFailure(new Response("busy", { status: 429, headers: { "retry-after": "9000" } }));
  assert.equal(retry.cooldownMs, 300_000);
  assert.equal(retry.error.status, 429);
  const outage = await voiceProviderFailure(new Response("failure", { status: 500 }));
  assert.equal(transientAudioError(outage.error), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ListenPassVerifier, checkListenPass, listenPassSecret, mintListenPass } from "../src/listen-pass.ts";
import { quietDuringBreaks, silentFrame } from "../src/break-silence.ts";

test("a listen pass is good until it expires, and only under its own secret", () => {
  const now = Date.UTC(2026, 9, 20);
  const { pass, expires } = mintListenPass("secret", now, 60);
  assert.equal(checkListenPass("secret", pass, now), expires);
  assert.equal(checkListenPass("other", pass, now), 0);
  assert.equal(checkListenPass("secret", pass, now + 61_000), 0);
  assert.equal(checkListenPass("secret", pass.replace(/.$/, (c) => (c === "A" ? "B" : "A")), now), 0);
  assert.equal(checkListenPass("secret", `v1.${expires + 1000}.${pass.split(".")[2]}`, now), 0);
  assert.equal(checkListenPass("", pass, now), 0);
});

test("the secret is derived where accounts live and absent elsewhere", () => {
  assert.equal(listenPassSecret({}), "");
  assert.match(listenPassSecret({ NIXAMP_JWT_SECRET: "jwt" }), /^[0-9a-f]{64}$/);
  assert.equal(listenPassSecret({ NIXAMP_LISTEN_PASS_SECRET: "set", NIXAMP_JWT_SECRET: "jwt" }), "set");
});

test("a station asks nixamp.com about a pass once, and a refusal or an outage is not a pass", async () => {
  const now = Date.UTC(2026, 9, 20);
  const { pass } = mintListenPass("k", now);
  let asked = 0;
  let down = false;
  const fetcher = (async (url: string) => {
    asked += 1;
    if (down) return new Response("", { status: 502 });
    const given = new URL(url).searchParams.get("pass") ?? "";
    const expires = checkListenPass("k", given, now);
    return Response.json(expires ? { ok: true, expires } : { ok: false });
  }) as typeof fetch;
  const verifier = new ListenPassVerifier({ site: "https://nixamp.com/", fetcher, now: () => now });
  assert.equal(await verifier.good(pass), true);
  assert.equal(await verifier.good(pass), true);
  assert.equal(asked, 1);
  const forged = mintListenPass("not-k", now).pass;
  assert.equal(await verifier.good(forged), false);
  assert.equal(await verifier.good(forged), false);
  assert.equal(asked, 2);
  assert.equal(await verifier.good("garbage"), false);
  assert.equal(asked, 2);
  down = true;
  assert.equal(await verifier.good(mintListenPass("k", now, 30).pass), false);
});

test("nixamp.com checks its own passes without asking anybody", async () => {
  const verifier = new ListenPassVerifier({ site: "https://nixamp.com", secret: "k", fetcher: (() => { throw new Error("asked"); }) as typeof fetch });
  assert.equal(await verifier.good(mintListenPass("k").pass), true);
  assert.equal(await verifier.good(mintListenPass("x").pass), false);
});

test("a silent frame is a valid MPEG-1 Layer III 48 kHz header with empty side information", () => {
  const frame = silentFrame(128);
  assert.equal(frame.length, 384);
  assert.deepEqual([...frame.subarray(0, 4)], [0xff, 0xfb, 0x94, 0x00]);
  assert.ok(frame.subarray(4).every((byte) => byte === 0));
  assert.equal(silentFrame(192).length, 576);
  assert.equal(silentFrame(999).length, 384);
});

test("during a break a spared listener gets silence lasting as long as what it replaces", () => {
  const written: Buffer[] = [];
  let inBreak = false;
  const out = quietDuringBreaks({ write: (chunk) => { written.push(chunk); return true; }, end: () => undefined }, 128, () => inBreak);
  const music = Buffer.alloc(1000, 7);
  out.write(music);
  inBreak = true;
  // Five seconds of the spot at 128 kbps, in uneven chunks.
  for (let sent = 0; sent < 80_000; sent += 3_333) out.write(Buffer.alloc(Math.min(3_333, 80_000 - sent), 9));
  inBreak = false;
  out.write(music);
  assert.equal(written[0], music);
  assert.equal(written.at(-1), music);
  const silence = Buffer.concat(written.slice(1, -1));
  assert.ok(!silence.includes(9));
  // 5 s is 208.33 frames of 24 ms; never more than was owed.
  assert.equal(silence.length % 384, 0);
  assert.ok(silence.length / 384 >= 207 && silence.length / 384 <= 208, String(silence.length / 384));
});

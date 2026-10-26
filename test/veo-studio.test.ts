import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLedger, pgLedger, VeoBudgetError, VeoRefused, VeoStudio } from "../src/veo-studio.ts";
import { veoPrompts } from "../src/ai-label.ts";

function veoFake(outcome: "ok" | "filtered" | "refused", seen: Array<Record<string, unknown>>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith(":predictLongRunning")) {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return outcome === "refused" ? Response.json({ error: { message: "quota" } }, { status: 429 }) : Response.json({ name: "models/veo/operations/op1" });
    }
    if (url.endsWith("/operations/op1")) {
      return Response.json(outcome === "filtered"
        ? { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ["Sorry, we can't create videos with real people's names or likenesses."] } } }
        : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://files.example/video.mp4" } }] } } });
    }
    if (url === "https://files.example/video.mp4") return new Response(Buffer.alloc(20_000, 7));
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

test("an Omni shot is one POST to /interactions with the portraits inline, and the ledger settles at what its tokens cost", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-omni-"));
  try {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    let outcome: "ok" | "refused" = "ok";
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (outcome === "refused") return Response.json({ error: { message: "nope" } }, { status: 400 });
      return Response.json({
        status: "completed",
        steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: Buffer.alloc(20_000, 5).toString("base64") }] }],
        // 1080p, 10 s: 86,880 video tokens = $1.5204.
        usage: { total_input_tokens: 0, total_output_tokens: 86_880, total_thought_tokens: 0 },
      });
    }) as typeof fetch;
    const ledger = fileLedger(join(top, "omni.json"));
    const studio = new VeoStudio({ key: "k", ledger, monthlyUsd: 5, usdPerSecond: 0.15, fetcher, now: () => Date.UTC(2026, 9, 26) });
    const bytes = await studio.clip({ prompt: "a bassist under a zinc roof", seconds: 4, references: [Buffer.alloc(100, 1)] });
    assert.equal(bytes.length, 20_000);
    assert.match(seen[0]!.url, /\/v1beta\/interactions$/);
    assert.equal(seen[0]!.body["model"], "gemini-omni-1.1-flash");
    assert.deepEqual(seen[0]!.body["response_format"], { type: "video", aspect_ratio: "16:9", resolution: "1080p" });
    const input = seen[0]!.body["input"] as Array<{ type: string }>;
    assert.deepEqual(input.map((one) => one.type), ["image", "text"]);
    // Reserved at 10 s x $0.15 = $1.50, settled up to the $1.52 it cost.
    assert.ok(Math.abs((await ledger.spent("2026-10")) - 1.5204) < 0.001);
    outcome = "refused";
    await assert.rejects(studio.clip({ prompt: "x", seconds: 4, references: [] }), VeoRefused);
    assert.ok(Math.abs((await ledger.spent("2026-10")) - 1.5204) < 0.001, "a refusal costs nothing");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("Veo shots are paid for under the month's cap, reserved first and given back when nothing is made", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-veo-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    let now = Date.UTC(2026, 9, 21);
    const make = (outcome: "ok" | "filtered" | "refused") => new VeoStudio({ key: "k", model: "veo-3.1-fast-generate-preview", ledger: fileLedger(join(top, "veo.json")), monthlyUsd: 3, usdPerSecond: 0.15, fetcher: veoFake(outcome, seen), sleep: async () => undefined, now: () => now });
    const studio = make("ok");
    const clip = await studio.clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [Buffer.alloc(2000, 1)] });
    assert.equal(clip.length, 20_000);
    const asked = seen[0] as { instances: Array<{ referenceImages?: Array<{ referenceType: string; image: { mimeType: string } }> }>; parameters: { durationSeconds: number; aspectRatio: string; resolution: string } };
    assert.deepEqual([asked.parameters.durationSeconds, asked.parameters.aspectRatio, asked.parameters.resolution, asked.instances[0]!.referenceImages?.[0]?.referenceType], [8, "16:9", "1080p", "asset"]);
    assert.deepEqual([(await studio.status()).spentUsd, (await studio.status()).leftUsd], [1.2, 1.8]);
    // A filtered or refused shot costs nothing.
    await assert.rejects(make("filtered").clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [] }), VeoRefused);
    await assert.rejects(make("refused").clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [] }), VeoRefused);
    assert.equal((await make("ok").status()).spentUsd, 1.2, "kept on disk, and refunds kept too");
    // Over the cap: refused before Google is asked.
    await studio.clip({ prompt: "a band on a stage, close-up", seconds: 8, references: [] });
    const before = seen.length;
    await assert.rejects(studio.clip({ prompt: "a band on a stage, third", seconds: 8, references: [] }), VeoBudgetError);
    assert.equal(seen.length, before, "nothing was asked of Google");
    // Next month, a fresh cap.
    now = Date.UTC(2026, 10, 2);
    assert.equal((await studio.status()).spentUsd, 0);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("the Postgres ledger keeps the month's spend and never lets a reservation pass the cap", async () => {
  const rows = new Map<string, number>();
  const db = {
    async query(text: string, params: unknown[] = []) {
      const [month, usd, cap] = params as [string, number, number];
      if (text.startsWith("CREATE")) return { rows: [] };
      if (text.startsWith("SELECT")) return { rows: rows.has(month) ? [{ usd: String(rows.get(month)) }] : [] };
      if (text.startsWith("INSERT")) { if (!rows.has(month)) rows.set(month, 0); return { rows: [] }; }
      if (text.includes("usd + $2 <= $3")) {
        if (!rows.has(month) || rows.get(month)! + usd > cap) return { rows: [] };
        rows.set(month, rows.get(month)! + usd);
        return { rows: [{ usd: rows.get(month) }] };
      }
      if (text.includes("GREATEST")) { if (rows.has(month)) rows.set(month, Math.max(0, rows.get(month)! - usd)); return { rows: [] }; }
      throw new Error(`unexpected ${text}`);
    },
  };
  const ledger = pgLedger(db);
  assert.equal(await ledger.spent("2026-10"), 0);
  assert.equal(await ledger.reserve("2026-10", 1.2, 2), true);
  assert.equal(await ledger.reserve("2026-10", 1.2, 2), false);
  await ledger.refund("2026-10", 1.2);
  assert.equal(await ledger.reserve("2026-10", 2, 2), true, "exactly the cap is allowed");
  assert.equal(await pgLedger(db).spent("2026-10"), 2, "a new process reads what the last one spent");
});

test("Veo prompts describe the band by role and look, never by name", () => {
  const prompts = veoPrompts(
    { genre: "Rock", sound: "gritty alternative rock" },
    { style: "anthemic chorus, 140 BPM." },
    [{ role: "lead vocals", look: "woman, late twenties, curly dark hair, leather jacket" }, { role: "lead guitar", look: "man, blond, plaid shirt" }],
    4,
  );
  assert.equal(prompts.length, 4);
  for (const prompt of prompts) {
    assert.match(prompt, /the lead vocals from reference image 1 \(woman, late twenties/);
    assert.match(prompt, /the lead guitar from reference image 2/);
    assert.doesNotMatch(prompt, /Ava Morales|Ethan/);
    assert.match(prompt, /nobody sings, speaks or lip-syncs on camera/i, "Veo never shows a mouth it cannot sync");
  }
});

test("a lip sync uploads the shot and its seconds of the song to fal.ai, is paid under the same cap, and costs nothing when it fails", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-lipsync-"));
  try {
    let fail = false;
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.includes("/storage/upload/initiate")) return Response.json({ upload_url: "https://up.example/put", file_url: `https://cdn.example/${(JSON.parse(String(init?.body)) as { file_name: string }).file_name}` });
      if (url === "https://up.example/put") return new Response(null, { status: 200 });
      if (url.endsWith("/sync-lipsync/v2/pro")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { video_url: "https://cdn.example/shot.mp4", audio_url: "https://cdn.example/vocal.mp3" });
        return Response.json({ status_url: "https://queue.example/status", response_url: "https://queue.example/result" });
      }
      if (url === "https://queue.example/status") return Response.json({ status: "COMPLETED" });
      if (url === "https://queue.example/result") return fail ? Response.json({ detail: [{ msg: "no face found" }] }, { status: 422 }) : Response.json({ video: { url: "https://cdn.example/out.mp4" } });
      if (url === "https://cdn.example/out.mp4") return new Response(Buffer.alloc(30_000, 5));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const studio = new VeoStudio({ key: "k", falKey: "f", ledger: fileLedger(join(top, "veo.json")), monthlyUsd: 3, lipsyncUsdPerSecond: 0.1, fetcher, sleep: async () => undefined, now: () => Date.UTC(2026, 9, 21) });
    assert.ok(studio.canLipsync);
    const out = await studio.lipsync({ video: Buffer.alloc(20_000, 1), audio: Buffer.alloc(4_000, 2), seconds: 8 });
    assert.equal(out.length, 30_000);
    assert.equal((await studio.status()).spentUsd, 0.8);
    fail = true;
    await assert.rejects(studio.lipsync({ video: Buffer.alloc(20_000, 1), audio: Buffer.alloc(4_000, 2), seconds: 8 }), VeoRefused);
    assert.equal((await studio.status()).spentUsd, 0.8, "a failed sync is given back");
    assert.ok(!new VeoStudio({ key: "k", ledger: fileLedger(join(top, "v2.json")) }).canLipsync, "no fal.ai key, no lip sync");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("when Google is out of quota or credit the same shot is made by Veo on fal.ai, paid once under the cap", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-falveo-"));
  try {
    const models: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.endsWith(":predictLongRunning")) return Response.json({ error: { message: "You exceeded your current quota, please check your plan and billing details." } }, { status: 429 });
      if (url.includes("/storage/upload/initiate")) return Response.json({ upload_url: "https://up.example/put", file_url: `https://cdn.example/${(JSON.parse(String(init?.body)) as { file_name: string }).file_name}` });
      if (url === "https://up.example/put") return new Response(null, { status: 200 });
      if (url.startsWith("https://queue.fal.run/")) {
        const model = url.slice("https://queue.fal.run/".length);
        models.push(model);
        const body = JSON.parse(String(init?.body)) as { duration: string; resolution: string; image_urls?: string[] };
        assert.deepEqual([body.duration, body.resolution], ["8s", "1080p"]);
        if (model.endsWith("reference-to-video")) assert.deepEqual(body.image_urls, ["https://cdn.example/ref-0.jpg"]);
        return Response.json({ status_url: "https://queue.example/status", response_url: "https://queue.example/result" });
      }
      if (url === "https://queue.example/status") return Response.json({ status: "COMPLETED" });
      if (url === "https://queue.example/result") return Response.json({ video: { url: "https://cdn.example/veo.mp4" } });
      if (url === "https://cdn.example/veo.mp4") return new Response(Buffer.alloc(40_000, 3));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const studio = new VeoStudio({ key: "k", model: "veo-3.1-fast-generate-preview", falKey: "f", ledger: fileLedger(join(top, "veo.json")), monthlyUsd: 10, fetcher, sleep: async () => undefined, now: () => Date.UTC(2026, 9, 21) });
    const clip = await studio.clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [Buffer.alloc(2000, 1)] });
    assert.equal(clip.length, 40_000);
    assert.deepEqual(models, ["fal-ai/veo3.1/fast/reference-to-video"]);
    assert.equal((await studio.status()).spentUsd, 1.2, "one shot, counted once");
    // Without a fal.ai key, Google's refusal stands.
    const alone = new VeoStudio({ key: "k", ledger: fileLedger(join(top, "v2.json")), fetcher, sleep: async () => undefined });
    await assert.rejects(alone.clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [] }), VeoRefused);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

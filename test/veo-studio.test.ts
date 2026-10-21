import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeoBudgetError, VeoRefused, VeoStudio } from "../src/veo-studio.ts";
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

test("Veo shots are paid for under the month's cap, reserved first and given back when nothing is made", async () => {
  const top = mkdtempSync(join(tmpdir(), "nixamp-veo-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    let now = Date.UTC(2026, 9, 21);
    const make = (outcome: "ok" | "filtered" | "refused") => new VeoStudio({ key: "k", file: join(top, "veo.json"), monthlyUsd: 3, usdPerSecond: 0.15, fetcher: veoFake(outcome, seen), sleep: async () => undefined, now: () => now });
    const studio = make("ok");
    const clip = await studio.clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [Buffer.alloc(2000, 1)] });
    assert.equal(clip.length, 20_000);
    const asked = seen[0] as { instances: Array<{ referenceImages?: Array<{ referenceType: string; image: { mimeType: string } }> }>; parameters: { durationSeconds: number; aspectRatio: string } };
    assert.deepEqual([asked.parameters.durationSeconds, asked.parameters.aspectRatio, asked.instances[0]!.referenceImages?.[0]?.referenceType], [8, "16:9", "asset"]);
    assert.deepEqual([studio.status().spentUsd, studio.status().leftUsd], [1.2, 1.8]);
    // A filtered or refused shot costs nothing.
    await assert.rejects(make("filtered").clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [] }), VeoRefused);
    await assert.rejects(make("refused").clip({ prompt: "a band on a stage, wide shot", seconds: 8, references: [] }), VeoRefused);
    assert.equal(make("ok").status().spentUsd, 1.2, "kept on disk, and refunds kept too");
    // Over the cap: refused before Google is asked.
    await studio.clip({ prompt: "a band on a stage, close-up", seconds: 8, references: [] });
    const before = seen.length;
    await assert.rejects(studio.clip({ prompt: "a band on a stage, third", seconds: 8, references: [] }), VeoBudgetError);
    assert.equal(seen.length, before, "nothing was asked of Google");
    // Next month, a fresh cap.
    now = Date.UTC(2026, 10, 2);
    assert.equal(studio.status().spentUsd, 0);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
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
  }
});

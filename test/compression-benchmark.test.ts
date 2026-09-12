import { test } from "node:test";
import assert from "node:assert/strict";
import { exactnessFailures, reportMarkdown, reportPasses, runBenchmark, syntheticCorpus } from "../src/compression/benchmark.ts";

test("the synthetic corpus benchmarks honestly: floor stored, ceiling compressed, every applicable codec exact", async () => {
  const report = await runBenchmark(syntheticCorpus(), { implementationVersion: "test", zstdLevels: [1, 9] });
  assert.equal(report.spec, "openstream");
  assert.equal(report.specVersion, "NXS1");
  assert.ok(report.environment.runtime);
  assert.ok(report.environment.cpu);

  const byName = Object.fromEntries(report.samples.map((s) => [s.sample, s]));
  // Incompressible data is stored: a codec must not be recorded as beating it.
  assert.equal(byName["random-1mib"]!.recommendation.mode, "stored", "random must not compress");
  // Maximally and ordinarily compressible data does compress.
  assert.notEqual(byName["zeros-1mib"]!.recommendation.mode, "stored");
  assert.notEqual(byName["text-repeat-1mib"]!.recommendation.mode, "stored");
  // A padded transport stream saves about its padding share; an unpadded one
  // with incompressible payloads does not beat stored. This is the honest
  // point of the whole exercise.
  const padded = byName["ts-padded-50pct"]!.rows.filter((r) => r.roundTrip && r.mode !== "stored").sort((a, b) => a.wireBytes - b.wireBytes)[0];
  assert.ok(padded && padded.savingsPercent > 40 && padded.savingsPercent < 60, `padded TS saved ${padded?.savingsPercent}%`);
  assert.equal(byName["ts-unpadded"]!.recommendation.mode, "stored", "an efficient feed saves little; stored is honest");
  // Tiny and empty are stored, and the report says so without a fake saving.
  assert.equal(byName["tiny-3b"]!.recommendation.mode, "stored");
  assert.equal(byName["empty"]!.recommendation.mode, "stored");

  // Every applicable codec restored exactly. ts-zstd on non-transport bytes is
  // "not applicable" (a noted row), which is not an exactness failure.
  assert.equal(reportPasses(report), true);
  assert.deepEqual(exactnessFailures(report), []);
  const notedButNotFailed = report.samples
    .flatMap((s) => s.rows)
    .some((r) => r.note && !r.roundTrip);
  assert.ok(notedButNotFailed, "ts-zstd on random/zeros is recorded as not-applicable, not as a failure");

  // The aggregate excludes not-applicable rows, so stored is the honest floor.
  const stored = report.summary.byMode.find((m) => m.mode === "stored")!;
  assert.ok(stored.savingsPercent < 0, "stored costs the envelope overhead, a small negative saving");
  assert.ok(report.summary.byMode.every((m) => m.roundTrip), "no applicable mode failed");

  const md = reportMarkdown(report);
  assert.match(md, /OpenStream benchmark/);
  assert.match(md, /framing envelope over Zstandard/);
  assert.match(md, /random-1mib/);
});

test("the report is deterministic: two runs produce the same corpus bytes", async () => {
  const a = await runBenchmark(syntheticCorpus(), { implementationVersion: "test", zstdLevels: [1] });
  const b = await runBenchmark(syntheticCorpus(), { implementationVersion: "test", zstdLevels: [1] });
  assert.deepEqual(
    a.samples.map((s) => [s.sample, s.sha256, s.inputBytes]),
    b.samples.map((s) => [s.sample, s.sha256, s.inputBytes]),
    "same seed, same bytes, same digests",
  );
});

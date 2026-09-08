import { test } from "node:test";
import assert from "node:assert/strict";
import { Analyser, bandEdges, bands, decay, hann, isPowerOfTwo } from "../src/fft.ts";

const RATE = 44100;

function tone(hz: number, n: number, amplitude = 1, rate = RATE): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

test("rejects a non-power-of-two size rather than producing nonsense", () => {
  assert.throws(() => new Analyser(1000), /power of two/);
  assert.ok(isPowerOfTwo(2048));
  assert.equal(isPowerOfTwo(1000), false);
});

test("a pure tone lands in the bin for its frequency", () => {
  const a = new Analyser(2048, RATE);
  for (const hz of [440, 1000, 5000]) {
    a.run(tone(hz, 2048));
    const found = a.frequencyOf(a.peakBin());
    // Bin spacing here is ~21.5 Hz, so within one bin is exact.
    assert.ok(Math.abs(found - hz) <= RATE / 2048, `${hz} Hz found at ${found.toFixed(1)} Hz`);
  }
});

test("two tones give two peaks, not one smear", () => {
  const a = new Analyser(2048, RATE);
  const mixed = tone(300, 2048, 0.5);
  const high = tone(4000, 2048, 0.5);
  for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] as number) + (high[i] as number);
  const mags = a.run(mixed);

  const binOf = (hz: number) => Math.round((hz * 2048) / RATE);
  const near = (hz: number) => Math.max(
    mags[binOf(hz) - 1] as number, mags[binOf(hz)] as number, mags[binOf(hz) + 1] as number,
  );
  assert.ok(near(300) > 0.1, "300 Hz present");
  assert.ok(near(4000) > 0.1, "4000 Hz present");
  // Nothing substantial in between.
  assert.ok((mags[binOf(2000)] as number) < 0.02, "no phantom peak at 2 kHz");
});

test("amplitude is recovered, so the display is not arbitrary", () => {
  const a = new Analyser(4096, RATE);
  // A frequency that completes whole cycles in the frame, so windowing and
  // leakage do not muddy the amplitude check.
  const hz = (RATE * 100) / 4096;
  a.run(tone(hz, 4096, 0.5));
  const peak = a.magnitudes[a.peakBin()] as number;
  // The Hann window halves coherent gain, hence ~0.25 for a 0.5 amplitude tone.
  assert.ok(peak > 0.2 && peak < 0.3, `peak magnitude ${peak.toFixed(3)}`);
});

test("silence produces no peaks", () => {
  const a = new Analyser(1024, RATE);
  const mags = a.run(new Float32Array(1024));
  assert.ok(Math.max(...mags) < 1e-9);
});

test("a short frame is zero padded rather than throwing", () => {
  const a = new Analyser(1024, RATE);
  assert.doesNotThrow(() => a.run(new Float32Array(100)));
  assert.doesNotThrow(() => a.run([]));
});

test("the Hann window starts and ends at zero and peaks in the middle", () => {
  const w = hann(64);
  assert.ok((w[0] as number) < 1e-9);
  assert.ok((w[63] as number) < 1e-9);
  assert.ok(Math.abs((w[32] as number) - 1) < 0.01);
});

test("band edges rise logarithmically and stay inside the spectrum", () => {
  const edges = bandEdges(24, RATE, 2048);
  assert.equal(edges.length, 25);
  for (let i = 1; i < edges.length; i++) {
    assert.ok((edges[i] as number) >= (edges[i - 1] as number), "edges are non-decreasing");
    assert.ok((edges[i] as number) <= 1024, "never past Nyquist");
  }
  // Logarithmic, so the low bands are far narrower than the high ones.
  const lowSpan = (edges[1] as number) - (edges[0] as number);
  const highSpan = (edges[24] as number) - (edges[23] as number);
  assert.ok(highSpan > lowSpan * 5, `low ${lowSpan} vs high ${highSpan}`);
});

test("bands are normalised to 0..1 and silence sits at the floor", () => {
  const a = new Analyser(2048, RATE);
  const edges = bandEdges(24, RATE, 2048);

  const quiet = bands(a.run(new Float32Array(2048)), edges);
  assert.equal(quiet.length, 24);
  assert.ok(quiet.every((v) => v === 0), "silence is zero everywhere");

  const loud = bands(a.run(tone(1000, 2048)), edges);
  assert.ok(loud.every((v) => v >= 0 && v <= 1), "always in range");
  assert.ok(Math.max(...loud) > 0.8, "a full-scale tone reaches near the top");
});

test("bars rise instantly and fall gradually", () => {
  const risen = decay([0, 0.9], [0.8, 0.1], 0.12);
  assert.equal(risen[0], 0.8, "a rise is immediate");
  assert.ok((risen[1] as number) > 0.7 && (risen[1] as number) < 0.9, "a fall is gradual");
  // Repeated falls eventually reach the new value rather than sticking.
  let v = [1];
  for (let i = 0; i < 20; i++) v = decay(v, [0], 0.12);
  assert.equal(v[0], 0);
});

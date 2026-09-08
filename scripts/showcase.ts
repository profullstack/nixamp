/**
 * Frames for the hqtui.com apps showcase.
 *
 * The spectrum is computed from real decoded audio rather than invented
 * numbers: ffmpeg synthesises a bass-heavy pink noise source and the analyser
 * runs over it, so the bars in the screenshot are a real measurement.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAND_COUNT, createState, view } from "../src/main.ts";
import { detectTools, probe, RATE, Stream, toMono } from "../src/audio.ts";
import { Analyser, bandEdges, bands, decay } from "../src/fft.ts";

const TRACKS = [
  { path: "/m/1.flac", title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 },
  { path: "/m/2.flac", title: "Aerials", artist: "System of a Down", album: "Toxicity", duration: 235 },
  { path: "/m/3.flac", title: "Lateralus", artist: "Tool", album: "Lateralus", duration: 562 },
  { path: "/m/4.flac", title: "Cassandra Gemini", artist: "The Mars Volta", album: "Frances", duration: 1112 },
];

/** Analyse a synthesised source so the bars are measured, not invented. */
async function realBars(): Promise<number[]> {
  const tools = detectTools();
  const dir = mkdtempSync(join(tmpdir(), "nixamp-shot-"));
  try {
    const file = join(dir, "source.wav");
    const [cmd, ...rest] = tools.ffmpeg;
    const made = spawnSync(cmd as string, [
      ...rest, "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "anoisesrc=d=2:c=pink:a=0.6",
      "-af", "volume=1.5,bass=g=12,treble=g=-6",
      "-ac", "2", "-ar", String(RATE), file,
    ], { timeout: 60_000 });
    if (made.status !== 0) return new Array(BAND_COUNT).fill(0);

    const chunks: Float32Array[] = [];
    await new Promise<void>((resolve) => {
      new Stream({ ...tools, play: null }, {
        onSamples: (pcm) => chunks.push(pcm),
        onEnd: () => resolve(),
      }).start(probe(tools, file));
    });

    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return new Array(BAND_COUNT).fill(0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { joined.set(c, at); at += c.length; }
    const mono = toMono(joined);

    const analyser = new Analyser(2048, RATE);
    const edges = bandEdges(BAND_COUNT, RATE, 2048);
    let bars: number[] = new Array(BAND_COUNT).fill(0);
    for (let f = 0; f < 12 && (f + 1) * 2048 <= mono.length; f++) {
      analyser.run(mono.subarray(f * 2048, f * 2048 + 2048));
      bars = decay(bars, bands(analyser.magnitudes, edges));
    }
    return bars;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BARS = await realBars();

export const frames = [
  {
    name: "nixamp",
    width: 132,
    height: 30,
    draw: (args: { ui: unknown; theme: unknown; height: number }) => {
      const state = createState(TRACKS, "~/Music", false);
      state.playing = true;
      state.index = 0;
      state.position = 147;
      state.bars = BARS;
      state.peakHold = BARS.map((b) => Math.min(1, b + 0.1));
      state.levels = [0.72, 0.64];
      view(args as never, state);
    },
  },
];

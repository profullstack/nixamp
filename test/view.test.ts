import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToText } from "@profullstack/hqtui/testing";
import { BrailleCanvas } from "@profullstack/hqtui";
import { BAND_COUNT, barGlyph, createState, drawSpectrum, view, type State } from "../src/main.ts";
import type { Track } from "../src/audio.ts";

const TRACKS: Track[] = [
  { path: "/m/a.flac", title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 },
  { path: "/m/b.mp3", title: "Aerials", artist: "SOAD", album: "Toxicity", duration: 235 },
  { path: "/m/c.ogg", title: "Untitled", artist: "", album: "", duration: 0 },
];

const frame = (s: State, width = 96, height = 26): string =>
  renderToText((args) => view(args as never, s), { width, height });

test("the player draws with a playlist loaded", () => {
  const out = frame(createState(TRACKS, "/m", false));
  assert.match(out, /NIXAMP/);
  assert.match(out, /Now Playing/);
  assert.match(out, /Spectrum Analyser/);
  assert.match(out, /Playlist \(3\)/);
  assert.match(out, /Meshuggah — Bleed/);
});

test("stopped and playing are distinguishable", () => {
  assert.match(frame(createState(TRACKS, "/m", false)), /STOPPED/);
  const s = createState(TRACKS, "/m", false);
  s.playing = true;
  assert.match(frame(s), /PLAYING/);
});

test("elapsed and total time are shown, and an unknown duration is not faked", () => {
  const s = createState(TRACKS, "/m", false);
  s.position = 65;
  assert.match(frame(s), /01:05/);
  assert.match(frame(s), /07:27/);
  s.index = 2;
  assert.match(frame(s), /--:--/);
});

test("a track with no artist shows just its title", () => {
  const s = createState(TRACKS, "/m", false);
  s.index = 2;
  assert.match(frame(s), /Untitled/);
  assert.doesNotMatch(frame(s), / — Untitled/);
});

test("no audio output is reported rather than silently doing nothing", () => {
  assert.match(frame(createState(TRACKS, "/m", true)), /No audio output/);
  assert.doesNotMatch(frame(createState(TRACKS, "/m", false)), /No audio output/);
});

test("the block ramp spans quiet to loud", () => {
  assert.equal(barGlyph(0), "▁");
  assert.equal(barGlyph(1), "█");
  assert.equal(barGlyph(-5), "▁", "clamped low");
  assert.equal(barGlyph(99), "█", "clamped high");
  assert.notEqual(barGlyph(0.5), barGlyph(0));
});

test("the analyser draws taller columns for louder bands", () => {
  const s = createState(TRACKS, "/m", false);
  s.bars = new Array(BAND_COUNT).fill(0);
  s.peakHold = new Array(BAND_COUNT).fill(0);
  s.bars[0] = 1;

  const canvas = new BrailleCanvas(48, 8);
  drawSpectrum(canvas, s);

  const lit = (x: number): number => {
    let n = 0;
    for (let y = 0; y < canvas.height; y++) if (canvas.get(x, y)) n++;
    return n;
  };
  assert.ok(lit(0) > canvas.height - 2, "a full band fills its column");
  // A silent band still shows its floor pixel, not a full column.
  const perBand = Math.floor(canvas.width / BAND_COUNT);
  assert.ok(lit(perBand * 5) <= 2, "a silent band is at the floor");
});

test("the analyser survives a canvas with no room", () => {
  const s = createState(TRACKS, "/m", false);
  assert.doesNotThrow(() => drawSpectrum(new BrailleCanvas(0, 0), s));
});

test("an empty playlist renders rather than crashing", () => {
  const out = frame(createState([], "/m", false));
  assert.match(out, /Nothing loaded|Empty/);
});

test("the layout survives a narrow terminal", () => {
  const out = frame(createState(TRACKS, "/m", false), 54, 20);
  assert.ok(out.split("\n").every((l) => l.length <= 54), "no row overflows");
});

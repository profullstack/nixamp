/**
 * nixamp — it really whips the terminal's ass.
 *
 *   bunx nixamp ~/Music
 *   bunx nixamp track.flac
 *
 * ffmpeg decodes; we read every sample on its way to the speakers and draw it.
 */
import { createApp, themes, type BrailleCanvas, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import { resolve } from "node:path";
import {
  detectTools, formatTime, peaks, RATE, Stream, toMono,
  type Tools, type Track,
} from "./audio.ts";
import { Analyser, bandEdges, bands, decay } from "./fft.ts";
import { displayName, loadPlaylist } from "./playlist.ts";

const FFT_SIZE = 2048;
export const BAND_COUNT = 24;

export interface State {
  tracks: Track[];
  index: number;
  offset: number;
  playing: boolean;
  position: number;
  bars: number[];
  peakHold: number[];
  levels: [number, number];
  note: string;
  silent: boolean;
  root: string;
}

export function createState(tracks: Track[], root: string, silent: boolean): State {
  return {
    tracks,
    index: 0,
    offset: 0,
    playing: false,
    position: 0,
    bars: new Array(BAND_COUNT).fill(0),
    peakHold: new Array(BAND_COUNT).fill(0),
    levels: [0, 0],
    note: silent ? "No audio output found (install ffplay) — analyser only." : "",
    silent,
    root,
  };
}

export function current(state: State): Track | undefined {
  return state.tracks[state.index];
}

/** The classic block ramp, low to high. */
const RAMP = "▁▂▃▄▅▆▇█";

export function barGlyph(value: number): string {
  const i = Math.max(0, Math.min(RAMP.length - 1, Math.round(value * (RAMP.length - 1))));
  return RAMP[i] as string;
}

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? ".");
  const tools = detectTools();
  const tracks = loadPlaylist(tools, target);
  if (tracks.length === 0) {
    console.error(`nixamp: no audio files under ${target}`);
    process.exit(1);
  }

  const state = createState(tracks, target, tools.play === null);
  const app = await createApp({ theme: themes.matrix, title: "nixamp", quitKeys: ["ctrl+c"] });

  const analyser = new Analyser(FFT_SIZE, RATE);
  const edges = bandEdges(BAND_COUNT, RATE, FFT_SIZE);
  // Samples accumulate until there are enough for one transform.
  let pending = new Float32Array(0);

  const stream = new Stream(tools, {
    onSamples: (pcm) => {
      state.levels = peaks(pcm);
      state.position = stream.position;
      const mono = toMono(pcm);
      const joined = new Float32Array(pending.length + mono.length);
      joined.set(pending);
      joined.set(mono, pending.length);
      let at = 0;
      while (joined.length - at >= FFT_SIZE) {
        analyser.run(joined.subarray(at, at + FFT_SIZE));
        state.bars = decay(state.bars, bands(analyser.magnitudes, edges));
        state.peakHold = state.peakHold.map((p, i) =>
          Math.max((state.bars[i] as number), p - 0.02));
        at += FFT_SIZE;
      }
      pending = joined.subarray(at);
      app.invalidate();
    },
    onEnd: (error) => {
      if (error) { state.note = error; state.playing = false; app.invalidate(); return; }
      next(1);
    },
  });

  const play = (): void => {
    const track = current(state);
    if (!track) return;
    pending = new Float32Array(0);
    state.position = 0;
    state.playing = true;
    state.note = state.silent ? "No audio output found (install ffplay) — analyser only." : "";
    stream.start(track);
    app.invalidate();
  };

  const next = (delta: number): void => {
    if (state.tracks.length === 0) return;
    state.index = (state.index + delta + state.tracks.length) % state.tracks.length;
    if (state.playing) play(); else { state.position = 0; app.invalidate(); }
  };

  const stopAll = (): void => {
    stream.stop();
    state.playing = false;
    state.bars = new Array(BAND_COUNT).fill(0);
    state.peakHold = new Array(BAND_COUNT).fill(0);
    state.levels = [0, 0];
    state.position = 0;
    app.invalidate();
  };

  app.on("key", (event: KeyEvent) => {
    switch (event.key) {
      case "q": stream.stop(); app.quit(); return;
      case "space": state.playing ? stopAll() : play(); return;
      case "enter": play(); return;
      case "s": stopAll(); return;
      case "n": case "right": next(1); return;
      case "p": case "left": next(-1); return;
      case "up":
        state.index = Math.max(0, state.index - 1);
        if (state.playing) play(); else app.invalidate();
        return;
      case "down":
        state.index = Math.min(state.tracks.length - 1, state.index + 1);
        if (state.playing) play(); else app.invalidate();
        return;
    }
  });

  app.on("exit", () => stream.stop());
  app.render((args) => view(args, state));
  await app.start();
}


/**
 * The bars, on a braille canvas: four vertical pixels per cell, so a bar moves
 * smoothly instead of stepping through eight block glyphs.
 *
 * Each band gets a column of pixels with a one-pixel gap, and its peak is held
 * as a single floating pixel that sinks — the detail that made Winamp's
 * analyser readable rather than just busy.
 */
export function drawSpectrum(canvas: BrailleCanvas, state: State): void {
  const high = canvas.height;
  const wide = canvas.width;
  if (high <= 0 || wide <= 0) return;
  const perBand = Math.max(1, Math.floor(wide / state.bars.length));
  state.bars.forEach((value, i) => {
    const x0 = i * perBand;
    const top = Math.round((1 - value) * (high - 1));
    for (let x = x0; x < x0 + Math.max(1, perBand - 1) && x < wide; x++) {
      canvas.vline(x, top, high - 1);
      canvas.pixel(x, Math.round((1 - (state.peakHold[i] as number)) * (high - 1)));
    }
  });
}

export function view(
  { ui, theme, height }: { ui: Container; theme: Theme; height: number },
  state: State,
): void {
  const track = current(state);
  const duration = track?.duration ?? 0;
  const progress = duration > 0 ? Math.min(1, state.position / duration) : 0;

  ui.row({ size: 1 }, (header) => {
    header.text(" ⣿ NIXAMP", { fg: theme.title, bold: true, size: 11 });
    header.text(state.playing ? "▶ PLAYING" : "■ STOPPED", {
      fg: state.playing ? theme.success : theme.muted,
      size: 12,
    });
    header.text(`${state.tracks.length} tracks  ${state.root} `, { fg: theme.muted, align: "right" });
  });

  ui.panel({ title: "Now Playing", size: 6 }, (p) => {
    if (!track) { p.label("Nothing loaded."); return; }
    p.text(displayName(track), { fg: theme.accent, bold: true, size: 1 });
    p.text(track.album || "—", { fg: theme.muted, size: 1 });
    p.row({ size: 1 }, (r) => {
      r.text(formatTime(state.position), { fg: theme.foreground, size: 7 });
      r.progress({ value: progress, color: theme.success });
      r.text(duration > 0 ? formatTime(duration) : "--:--", {
        fg: theme.muted, size: 7, align: "right",
      });
    });
  });

  ui.row({ size: height - 10, gap: 1 }, (row) => {
    row.panel({ title: "Spectrum Analyser", width: "1.3fr" }, (p) => {
      // Braille gives four vertical pixels per cell, so the bars move smoothly
      // rather than stepping through eight block glyphs.
      p.canvas((canvas) => {
        drawSpectrum(canvas, state);
      }, { color: theme.success });
      p.row({ size: 1 }, (r) => {
        r.text(state.bars.map(barGlyph).join(""), { fg: theme.success });
        r.text(
          `L${"▮".repeat(Math.round(state.levels[0] * 6)).padEnd(6, "·")} ` +
          `R${"▮".repeat(Math.round(state.levels[1] * 6)).padEnd(6, "·")}`,
          { fg: theme.accent, align: "right" },
        );
      });
    });

    row.panel({ title: `Playlist (${state.tracks.length})`, width: "1fr" }, (p) => {
      if (state.tracks.length === 0) { p.label("Empty."); return; }
      p.table({
        rows: state.tracks.map((t, i) => ({
          n: String(i + 1).padStart(2, " "),
          name: displayName(t),
          time: t.duration > 0 ? formatTime(t.duration) : "--:--",
          playing: i === state.index && state.playing,
        })),
        selected: state.index,
        offset: state.offset,
        followSelection: true,
        scrollbar: true,
        onScroll: (d) => { state.offset = Math.max(0, state.offset + d); },
        header: false,
        columns: [
          { key: "n", title: "", width: 3, color: theme.muted },
          {
            key: "name", title: "", min: 8,
            color: (row) => (row.playing ? theme.success : theme.foreground),
          },
          { key: "time", title: "", width: 6, align: "right", color: theme.muted },
        ],
      });
    });
  });

  if (state.note !== "") ui.text(state.note, { fg: theme.warning, size: 1 });

  ui.statusBar({
    items: [
      { key: "Space", label: state.playing ? "Stop" : "Play", active: state.playing },
      { key: "↑↓", label: "Select" },
      { key: "n/p", label: "Next/Prev" },
      { key: "Enter", label: "Play" },
      { key: "q", label: "Quit" },
    ],
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

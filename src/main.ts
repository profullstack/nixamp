/**
 * nixamp — it really whips the terminal's ass.
 *
 *   bunx nixamp ~/Music
 *   bunx nixamp track.flac
 *
 * ffmpeg decodes; we read every sample on its way to the speakers and draw it.
 */
import { createApp, themes, type BrailleCanvas, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  detectTools, formatTime, peaks, RATE, Stream, toMono,
  type Tools, type Track,
} from "./audio.ts";
import { Analyser, bandEdges, bands, decay } from "./fft.ts";
import { version } from "./meta.ts";
import { displayName, loadSource } from "./playlist.ts";
import { isRemote } from "./sources.ts";
import { DEFAULT_PORT } from "./server.ts";

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

const HELP = `nixamp — it really whips the terminal's ass.

  nixamp [source]                play it in the terminal
  nixamp serve [source] [options]  play here, and hand out a browser remote
  nixamp daemon start|stop|status  serve in the background, and let go of it
  nixamp admin [--url U] [--key K] who is connected, and re-stream to them
  nixamp login [--signup]        sign in to nixamp.com
  nixamp logout / whoami        forget it, or check it
  nixamp update [version]        re-run the installer, keeping your choices
  nixamp uninstall [--yes]       remove everything the installer created

A source is a directory, a file, an .m3u, an .m3u8, a .pls, or a URL to any
of those.

Options for serve:
  -p, --port N     port to listen on (default ${DEFAULT_PORT})
  -h, --host HOST  address to bind (default 0.0.0.0, every interface)
      --web DIR    directory of built PWA files to serve at /
      --no-media   do not stream the library's bytes to remotes
      --no-key     serve to anyone who can reach the port, with no share link
      --open-port  let the port through the local firewall, and close it on exit
      --publish    list it at nixamp.com/directory without asking first
      --no-publish never list it, and do not ask
      --name NAME  what to call it in the directory (default: this hostname)
      --ingest     accept a live stream in at POST /api/ingest
      --rtmp-in N  also listen for RTMP publishers (OBS, Larix) from port N
      --rtmp-streams N  how many may publish at once (default 3, a port each)
      --rtmp D     broadcast out, e.g. --rtmp youtube=<key>. Repeatable
      --x402       charge for listening once more than 5 people are listening
      --no-x402    never charge

  -v, --version    print the version
      --help       print this
`;

/**
 * `nixamp daemon <start|stop|status>`.
 *
 * The daemon is `nixamp serve` with nobody holding its terminal, so this is
 * mostly bookkeeping: start it detached, remember where it went, and be able
 * to answer whether it is still there.
 */
async function runDaemon(argv: string[]): Promise<number> {
  const d = await import("./daemon.ts");
  const [action = "status", ...rest] = argv;
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));

  if (action === "start") {
    try {
      const state = await d.start(rest, entry);
      console.log(`nixamp daemon running (pid ${state.pid})`);
      const url = d.daemonUrl(state);
      console.log(`  ${state.key ? `${url}/s/${state.key}` : url}`);
      console.log(`  ${state.source}`);
      console.log("");
      console.log("  nixamp admin        who is connected");
      console.log("  nixamp daemon stop  when you are done");
      return 0;
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
  }

  if (action === "stop") {
    const stopped = await d.stop();
    console.log(stopped ? "nixamp daemon stopped" : "nixamp: no daemon was running");
    return 0;
  }

  if (action === "status") {
    const { running, state } = d.status();
    if (!state) {
      console.log("nixamp: no daemon. Start one with `nixamp daemon start`.");
      return 1;
    }
    // A pid file outlives its process often enough that saying "running"
    // without checking is how you report a daemon that died on Tuesday.
    if (!running) {
      console.log(`nixamp: the daemon (pid ${state.pid}) is gone. See ${state.log}`);
      return 1;
    }
    const url = d.daemonUrl(state);
    console.log(`nixamp daemon running (pid ${state.pid})`);
    console.log(`  ${state.key ? `${url}/s/${state.key}` : url}`);
    console.log(`  ${state.source}`);
    console.log(`  up ${Math.round((Date.now() - state.startedAt) / 1000)}s`);
    return 0;
  }

  console.error(`nixamp daemon: unknown action ${action}. Try start, stop or status.`);
  return 64;
}

/**
 * The whole CLI, as a function. `bin/nixamp.mjs` imports and calls it: relying
 * on `import.meta.main` there would leave the installed binary doing nothing,
 * because the flag is false in a module that was imported rather than run.
 */
export async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);

  if (first === "serve") {
    const { serve } = await import("./server.ts");
    await serve(rest, version());
    return;
  }
  if (first === "daemon") {
    process.exitCode = await runDaemon(rest);
    return;
  }
  if (first === "admin") {
    const { admin } = await import("./admin.ts");
    await admin(rest);
    return;
  }
  if (first === "login" || first === "signup") {
    const { login } = await import("./session.ts");
    process.exitCode = await login(first === "signup" ? [...rest, "--signup"] : rest);
    return;
  }
  if (first === "logout" || first === "whoami") {
    const session = await import("./session.ts");
    process.exitCode = first === "logout" ? session.logout() : await session.whoami();
    return;
  }
  if (first === "update" || first === "uninstall") {
    const manage = await import("./manage.ts");
    process.exitCode = first === "update" ? manage.update(rest) : manage.uninstall(rest);
    return;
  }
  if (first === "--version" || first === "-v") { console.log(version()); return; }
  if (first === "--help") { console.log(HELP); return; }

  // resolve() would turn https://host/x into /cwd/https:/host/x, so a URL is
  // left exactly as it was typed.
  const asked = first ?? ".";
  const target = isRemote(asked) ? asked : resolve(asked);
  const tools = detectTools();
  const tracks = await loadSource(tools, target);
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

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
import { displayName, loadSource, loadTagged } from "./playlist.ts";
import { isRemote } from "./sources.ts";
import { DEFAULT_PORT } from "./server.ts";
import type { DaemonState } from "./daemon.ts";
import { shareLink } from "./share.ts";
import { playJingle } from "./jingle.ts";

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
  nixamp daemon start|restart|stop|status  serve in the background, and let go of it
  nixamp attach                  put the player back in front of the daemon
  nixamp admin [--url U] [--key K] who is connected, and re-stream to them
  nixamp login [--with github]  sign in to nixamp.com, in a browser or here
  nixamp logout / whoami        forget it, or check it
  nixamp token create|list|revoke  tokens for a machine that cannot sign in
  nixamp dns [set|rm]           names under your handle, for your servers
  nixamp server list|add|remove  the machines you run, kept against your account
  nixamp opendir list|add|remove  folders found on the web, published for everyone
  nixamp update [version]        re-run the installer, keeping your choices
  nixamp uninstall [--yes]       remove everything the installer created

A source is a directory, a file, an .m3u, an .m3u8, a .pls, or a URL to any
of those.

It plays a jingle when it starts, picked at random. Any mp3 in your home
directory with nixamp in the name is yours and wins; otherwise the ones that
ship are used. --no-jingle, or NIXAMP_NO_JINGLE=1, for silence.

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
      --public-url URL  the address this server is reachable at from outside,
                   when that is a tunnel or a forwarded port rather than one of
                   its own interfaces. Also NIXAMP_PUBLIC_URL
      --no-lookup  do not ask ipinfo.io what this machine's public address is
                   when nothing local looks public
      --tls-cert FILE --tls-key FILE  serve https rather than http. Needed by
                   anyone opening this from a page that is itself https, since
                   a browser refuses every request from https to http
      --ingest     accept a live stream in at POST /api/ingest
      --rtmp-in N  also listen for RTMP publishers (OBS, Larix) from port N
      --rtmp-streams N  how many may publish at once (default 3, a port each)
      --rtmp D     broadcast out, e.g. --rtmp youtube=<key>. Repeatable
      --x402       charge for listening once more than 5 people are listening
      --no-x402    never charge

Options for login:
      --with NAME  sign in with a provider (github, google) in a browser
      --device     approve in a browser, whichever way it is signed in
      --password   ask for an address and a password here instead
      --token T    keep a token made with \`nixamp token create\`
      --signup     make an account with an address and a password
      --no-browser print the URL rather than trying to open one
      --site URL   somewhere other than https://nixamp.com

NIXAMP_TOKEN in the environment is a signed-in nixamp with no login at all,
which is what a build server wants.

Keys in the player:
  space play/pause   enter play   s stop   n/p next/previous   up/down choose
  d     detach: hand the music to a daemon and get the terminal back
  q     quit

  -v, --version    print the version
  -h, --help       print this. \`nixamp help <command>\` says more about one
`;

/** `-h`, `--help`, or the word, which is what people type when they forget. */
export function isHelp(arg: string | undefined): boolean {
  return arg === "-h" || arg === "--help" || arg === "help";
}

/**
 * Was help asked for, given what the command already means by its flags?
 *
 * `serve` has had `-h HOST` since the beginning, and `daemon start` passes its
 * flags straight through, so for those two `-h` is a bind address and only the
 * spelled-out forms ask for help. Everywhere else `-h` is help, because that
 * is what it is everywhere else.
 */
export function wantsHelp(first: string | undefined, rest: string[]): boolean {
  if (isHelp(first)) return true;
  const shortIsHost = first === "serve" || first === "daemon";
  return rest.some((arg) => (shortIsHost ? arg !== "-h" && isHelp(arg) : isHelp(arg)));
}

/**
 * Longer help, one command at a time.
 *
 * The summary in HELP is a list of what exists; these say how each is used,
 * which is the thing you want at the moment you ask, and the thing that makes
 * the summary unreadable if it is folded in.
 */
const TOPICS: Record<string, string> = {
  login: `nixamp login — sign in to nixamp.com.

  nixamp login                 choose how: a provider in a browser, or a password
  nixamp login --with github   go straight to a provider (github, google)
  nixamp login --device        approve in a browser you are already signed in to
  nixamp login --password      an address and a password, here in the terminal
  nixamp login --token TOKEN   keep a token made with \`nixamp token create\`
  nixamp signup                make an account with an address and a password

A provider sign-in never asks this terminal for anything secret. It shows a
short code, you approve it in a browser on whatever device has a keyboard, and
this terminal ends up holding the session. That works over ssh, and it works on
a television, which is why it is the default.

  --no-browser  print the URL rather than trying to open one
  --site URL    somewhere other than https://nixamp.com

NIXAMP_TOKEN in the environment is a signed-in nixamp with no login at all.
`,
  token: `nixamp token — tokens for a machine that cannot sign in.

  nixamp token create --name ci   make one, and print it once
  nixamp token list               id, when it was made, when it was last used
  nixamp token revoke ID          stop it working, everywhere, now

A token is shown once because the server keeps only its hash. Put it in the
environment as NIXAMP_TOKEN, or keep it here with \`nixamp login --token\`.
Signing out does not touch it: that is what it is for.
`,
  dns: `nixamp dns — names under your handle, for your servers.

  nixamp dns                     every name on your account, and where it points
  nixamp dns set NAME            NAME.<handle>.nixamp.com, pointed at this machine
  nixamp dns set NAME --a IP --aaaa IP   pointed somewhere you name; "off" clears one
  nixamp dns set NAME --ttl N    how long resolvers may keep it (seconds)
  nixamp dns rm NAME             take the name away

The DNS keys stay on nixamp.com. A signed-in \`nixamp serve\` names itself
this way on start and picks up the handle's certificate, so a server is
https://NAME.<handle>.nixamp.com with nothing typed here.
`,
  daemon: `nixamp daemon — a nixamp that outlives the terminal that started it.

  nixamp daemon start [source] [serve options]   start it, detached
  nixamp daemon restart [source] [serve options] stop it and start it again
  nixamp daemon status                           where it is, and how long
  nixamp daemon stop                             stop it

Restart with no arguments replays the ones it was started with, certificate
and public URL included, so picking up a new version costs one command.

It is \`nixamp serve\` with nobody holding its terminal, so it keeps playing and
keeps serving its browser remote. One per user.

  nixamp attach   put the player back in front of it
  nixamp admin    who is connected, and re-stream to them

From inside the player, d hands the music to a daemon without stopping it.
`,
  server: `nixamp server -- the machines you run.

  nixamp server list             every server on your account
  nixamp server add --here       remember the daemon on this machine
  nixamp server add URL --name x remember one somewhere else
  nixamp server remove ID        forget it

A share link printed in a terminal you have since closed is a server you have
lost. This keeps the address against your account, so the answer is the same
here, in the browser and in the desktop app. The share key is kept with it only
if you pass one, since it is the secret that opens the machine.
`,
  attach: `nixamp attach — the player, in front of the running daemon.

The same view and the same keys as the local player, except that the music is
the daemon's: keys are sent to it, and what you see is what it is doing. Any
number of terminals may attach at once.

  nixamp attach                    the daemon on this machine
  nixamp attach --url URL [--key K]  a nixamp somewhere else

q or d leaves; neither stops anything. \`nixamp daemon stop\` is what stops it.
`,
};

export function helpFor(topic: string | undefined): string {
  return (topic ? TOPICS[topic] : undefined) ?? HELP;
}

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
      for (const line of d.daemonLines(state)) console.log(line);
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

  if (action === "restart") {
    try {
      const state = await d.restart(rest, entry);
      for (const line of d.daemonLines(state)) console.log(line);
      return 0;
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
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
    // The same lines start prints, because the question "where is it" has the
    // same answer however you ask it -- and printing loopback alone was the
    // one address that cannot be handed to anybody.
    for (const line of d.daemonLines(state, Date.now() - state.startedAt)) console.log(line);
    return 0;
  }

  // `nixamp daemon attach` is what people try before `nixamp attach`, so it is
  // the same thing rather than an error about a word that means what it says.
  if (action === "attach") {
    const { attach } = await import("./attach.ts");
    return attach(rest);
  }

  console.error(`nixamp daemon: unknown action ${action}. Try start, restart, stop, status or attach.`);
  return 64;
}

/**
 * The whole CLI, as a function. `bin/nixamp.mjs` imports and calls it: relying
 * on `import.meta.main` there would leave the installed binary doing nothing,
 * because the flag is false in a module that was imported rather than run.
 */
export async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);

  // Asked for however anybody asks for it. `nixamp help serve` and
  // `nixamp serve --help` are the same question, so they get the same answer.
  if (wantsHelp(first, rest)) {
    console.log(helpFor(isHelp(first) ? rest[0] : first));
    return;
  }

  if (first === "attach") {
    const { attach } = await import("./attach.ts");
    process.exitCode = await attach(rest);
    return;
  }

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
  if (first === "opendir" || first === "opendirs") {
    const { opendirs } = await import("./session.ts");
    process.exitCode = await opendirs(rest);
    return;
  }
  if (first === "server" || first === "servers") {
    const { servers } = await import("./session.ts");
    process.exitCode = await servers(rest);
    return;
  }
  if (first === "token" || first === "tokens") {
    const { tokens } = await import("./session.ts");
    process.exitCode = await tokens(rest);
    return;
  }
  if (first === "dns") {
    const { dns } = await import("./session.ts");
    process.exitCode = await dns(rest);
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

  // resolve() would turn https://host/x into /cwd/https:/host/x, so a URL is
  // left exactly as it was typed.
  const asked = first ?? ".";
  const target = isRemote(asked) ? asked : resolve(asked);
  const tools = detectTools();
  // The noise it makes when it wakes up. Started before the library is walked
  // so it plays over the wait rather than after it, and never awaited: a
  // jingle that delays the player is worse than no jingle.
  if (!rest.includes("--no-jingle")) playJingle(tools);
  // Names now, tags later: an ffprobe per file over a large library is minutes
  // of a blank terminal before the player appears. The list is the same list;
  // only the titles arrive late, and they arrive into a player already running.
  const tracks = await loadSource(tools, target, false);
  if (tracks.length === 0) {
    console.error(`nixamp: no audio files under ${target}`);
    process.exit(1);
  }

  const state = createState(tracks, target, tools.play === null);
  const app = await createApp({ theme: themes.matrix, title: "nixamp", quitKeys: ["ctrl+c"] });
  // Set when d handed the music to a daemon, and printed after the TUI is
  // gone. A field rather than a local, because a local assigned only inside a
  // closure stays narrowed to null for the checker.
  const handoff: { to: { daemon: DaemonState; url: string } | null } = { to: null };

  // The titles, arriving into a player that is already up. Not awaited, and
  // applied only if the list is still the one it describes.
  if (!isRemote(target)) {
    void loadTagged(tools, target)
      .then((tagged) => {
        if (tagged.length !== state.tracks.length) return;
        if (tagged.some((track, at) => track.path !== state.tracks[at]?.path)) return;
        state.tracks = tagged;
        app.invalidate();
      })
      .catch(() => {
        // Filenames play. Nothing to say about tags that would not read.
      });
  }

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

  /**
   * Hand the music to a daemon and give the terminal back.
   *
   * The local stream is stopped first, because two processes fighting over the
   * audio device is a worse experience than a second of silence. What comes
   * back is where it went, so `nixamp attach` is a suggestion rather than a
   * thing to remember.
   */
  const detach = async (): Promise<void> => {
    state.note = "Handing over to a daemon...";
    app.invalidate();
    stream.stop();
    state.playing = false;
    try {
      const d = await import("./daemon.ts");
      const daemon = await d.start([target], fileURLToPath(new URL("./main.js", import.meta.url)));
      handoff.to = { daemon, url: d.daemonUrl(daemon) };
      app.quit();
    } catch (error) {
      // Most often: a daemon is already running, which is worth saying rather
      // than leaving somebody looking at a player that stopped for no reason.
      state.note = (error as Error).message;
      app.invalidate();
    }
  };

  app.on("key", (event: KeyEvent) => {
    switch (event.key) {
      case "q": stream.stop(); app.quit(); return;
      case "d": void detach(); return;
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

  const handed = handoff.to;
  if (handed !== null) {
    console.log(`Detached. Still playing as pid ${handed.daemon.pid}.`);
    console.log(`  ${shareLink(handed.url, handed.daemon.key ?? null)}`);
    console.log("  nixamp attach       come back to it");
    console.log("  nixamp daemon stop  when you are done");
  }
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
    // The same rule the installed launcher uses: a message we wrote is one the
    // reader can act on, and printing a stack over it buries the sentence that
    // says what to do.
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("nixamp:") ? message : error);
    process.exit(1);
  });
}

/**
 * Walking away from the player, and coming back to it.
 *
 * The daemon has always been able to outlive the terminal that started it.
 * What was missing was the pair of moves that makes that worth having: `d` in
 * the player hands the music to a daemon and gives you your terminal back, and
 * `nixamp attach` puts the same player back in front of the same music.
 *
 * Attaching is not a second player. It is the same view, drawn from the
 * daemon's snapshot instead of a local stream, with the keys sent as commands
 * over the API a browser remote already uses. So the analyser moves, the track
 * list is the daemon's, and nothing has to agree twice about what a player
 * looks like.
 *
 * Quitting an attached player stops nothing. That is the whole point: it is
 * tmux's detach, not a stop button.
 */
import { createApp, themes, type KeyEvent } from "@profullstack/hqtui";
import { resolveTarget } from "./admin.ts";
import { BAND_COUNT, createState, view, type State } from "./main.ts";
import type { Command, Snapshot } from "./protocol.ts";
import { KEY_HEADER } from "./share.ts";

/** How long to wait before trying the event stream again. */
const RECONNECT_MS = 1000;

/** A remote track has no path, because no filesystem path leaves the machine. */
export function applySnapshot(state: State, snapshot: Snapshot): void {
  // A frame without a list is not an empty library, it is a frame with nothing
  // new to say about it -- which is every frame but the first.
  if (snapshot.tracks !== undefined) {
    state.tracks = snapshot.tracks.map((track) => ({ path: "", ...track }));
  }
  state.index = snapshot.index;
  state.playing = snapshot.playing;
  state.position = snapshot.position;
  state.levels = snapshot.levels;
  state.silent = snapshot.silent;
  state.root = snapshot.root;
  state.note = snapshot.note;

  // The bars come down the wire; the peaks that hang above them do not, and
  // are a local decoration either way. Falling at the same rate the local
  // player uses keeps the two looking like one program.
  const bars = new Array(BAND_COUNT).fill(0).map((_, index) => snapshot.bars[index] ?? 0);
  state.bars = bars;
  state.peakHold = state.peakHold.map((peak, index) => Math.max(bars[index] as number, peak - 0.02));
}

/**
 * Read the server's event stream, calling back with every snapshot.
 *
 * Reconnects for as long as it is wanted: a daemon restarting under an
 * attached player should look like a pause, not a crash.
 */
export async function follow(
  url: string,
  headers: Record<string, string>,
  onSnapshot: (snapshot: Snapshot) => void,
  onTrouble: (why: string) => void,
  signal: AbortSignal,
  send: typeof fetch = fetch,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const answer = await send(`${url}/api/events`, { headers, signal });
      if (!answer.ok || answer.body === null) throw new Error(`${answer.status}`);
      onTrouble("");
      // SSE frames are separated by a blank line, and arrive split across
      // chunks in whatever way the network felt like.
      let buffered = "";
      const reader = answer.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let cut = buffered.indexOf("\n\n");
        while (cut !== -1) {
          const frame = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              onSnapshot(JSON.parse(line.slice(5).trim()) as Snapshot);
            } catch {
              // A frame we cannot read is one frame, not a reason to hang up.
            }
          }
          cut = buffered.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
      onTrouble(`cannot reach ${url}`);
    }
    if (signal.aborted) return;
    await new Promise((done) => setTimeout(done, RECONNECT_MS));
  }
}

/** Drive the daemon with the same keys that drive the local player. */
export function commandFor(key: string): Command | null {
  switch (key) {
    case "space":
      return { type: "toggle" };
    case "enter":
      return { type: "play" };
    case "s":
      return { type: "stop" };
    case "n":
    case "right":
      return { type: "next" };
    case "p":
    case "left":
      return { type: "prev" };
    default:
      return null;
  }
}

/** `nixamp attach` — the player, in front of whatever the daemon is doing. */
export async function attach(argv: string[]): Promise<number> {
  let target: { url: string; key: string | null };
  try {
    target = resolveTarget(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error("  `nixamp daemon start ~/Music` starts one, or press d in the player to hand it one.");
    return 1;
  }

  const headers: Record<string, string> = target.key ? { [KEY_HEADER]: target.key } : {};
  const state = createState([], target.url, false);
  state.note = `attaching to ${target.url}...`;

  const app = await createApp({ theme: themes.matrix, title: "nixamp", quitKeys: ["ctrl+c"] });
  const stop = new AbortController();

  const tell = (command: Command): void => {
    void fetch(`${target.url}/api/command`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(command),
    }).catch(() => {
      // The next snapshot says whether it landed; a failed keypress is not
      // worth a dialog in a player.
    });
  };

  app.on("key", (event: KeyEvent) => {
    // q and d both leave, because both mean "I am done with this terminal".
    // Neither stops the music, and the line printed on the way out says so.
    if (event.key === "q" || event.key === "d") {
      app.quit();
      return;
    }
    if (event.key === "up" || event.key === "down") {
      const at = state.index + (event.key === "down" ? 1 : -1);
      if (at < 0 || at >= state.tracks.length) return;
      // Moved here as well as asked for, so the highlight does not wait for a
      // round trip before it moves.
      state.index = at;
      app.invalidate();
      tell({ type: "select", index: at });
      return;
    }
    const command = commandFor(event.key);
    if (command) tell(command);
  });

  app.on("exit", () => stop.abort());
  app.render((args) => view(args, state));

  void follow(
    target.url,
    headers,
    (snapshot) => {
      applySnapshot(state, snapshot);
      app.invalidate();
    },
    (why) => {
      state.note = why;
      app.invalidate();
    },
    stop.signal,
  );

  await app.start();
  stop.abort();
  console.log(`Detached. ${target.url} is still playing.`);
  console.log("  nixamp attach       come back");
  console.log("  nixamp daemon stop  when you are done");
  return 0;
}

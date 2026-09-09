/**
 * The noise nixamp makes when it wakes up.
 *
 * Winamp had one, and it is half of why anybody remembers Winamp. This plays
 * once when a player starts and once on a fresh page at nixamp.com, and never
 * again in that session -- a sound you like the first time is a sound you
 * resent the fourth.
 *
 * `~/NixAmp*.mp3` wins if it is there, so somebody can drop their own in
 * without touching anything; otherwise the one that ships is used, so it works
 * on a machine that has never heard of any of this.
 */
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tools } from "./audio.ts";

/** Turned off by `--no-jingle` or by setting this in the environment. */
export const OFF = "NIXAMP_NO_JINGLE";

/**
 * The file to play, or null when there is none.
 *
 * Yours first. The match is deliberately loose -- `NixAmp anything.mp3` --
 * because the point is that you can drop a file in your home directory and
 * have it picked up, not that you can name it exactly right.
 */
export function findJingle(
  home = homedir(),
  packaged = defaultPackaged(),
  read: (dir: string) => string[] = safeRead,
  exists: (path: string) => boolean = existsSync,
): string | null {
  // Guarded here rather than only inside the default reader: whether a jingle
  // can be found is this function's promise to keep, and it should not depend
  // on which reader it was handed.
  let names: string[];
  try {
    names = read(home);
  } catch {
    names = [];
  }
  const mine = names.filter((name) => /^nixamp.*\.mp3$/i.test(name)).sort();
  const first = mine[0];
  if (first !== undefined) return join(home, first);
  return packaged !== null && exists(packaged) ? packaged : null;
}

function safeRead(dir: string): string[] {
  return readdirSync(dir);
}

/** Where the shipped copy lives, next to the built web assets. */
function defaultPackaged(): string | null {
  try {
    // dist/jingle.js -> the package root -> web/dist, which is what `files`
    // in package.json actually ships.
    return fileURLToPath(new URL("../web/dist/nixamp.mp3", import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Play it, without making anybody wait for it.
 *
 * Detached and unwatched: a jingle that delays the player, or that fails
 * loudly because a codec is missing, is worse than no jingle. Nothing here is
 * awaited and nothing it does can stop a start.
 */
export function playJingle(
  tools: Tools,
  path: string | null = findJingle(),
  /** Injected so a test can see what would be run on a machine with speakers. */
  start: Spawner = spawn,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (path === null) return false;
  if (env[OFF]) return false;
  const play = tools.play;
  if (play === null) return false;
  const [command, ...rest] = play;
  if (command === undefined) return false;
  try {
    const child = start(command, [...rest, ...JINGLE_ARGS, path], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", () => {
      // No player, a file it will not open, or a machine with no sound card at
      // all -- which is most servers. Silence is the fallback, and it is not
      // worth a line of output on every start.
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Play it and stop, with no window.
 *
 * `-nodisp` because a jingle is not something to open a window for, and
 * `-autoexit` because a player that lingers after the sound is a process
 * somebody has to notice and kill.
 */
export const JINGLE_ARGS = ["-autoexit", "-nodisp", "-loglevel", "quiet"] as const;

type Spawner = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; detached: boolean },
) => { on: (event: "error", run: () => void) => unknown; unref?: () => void };

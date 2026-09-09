/**
 * The noise nixamp makes when it wakes up.
 *
 * Winamp had one, and it is half of why anybody remembers Winamp. This plays
 * once when a player starts and once on a fresh page at nixamp.com, and never
 * again in that session -- a sound you like the first time is a sound you
 * resent the fourth.
 *
 * Yours win: any mp3 in your home directory with "nixamp" in its name, so you
 * can drop one in without touching anything. Otherwise the ones that ship are
 * used, so it works on a machine that has never heard of any of this.
 *
 * With more than one, it picks at random rather than cycling, because a
 * rotation you can predict is one you stop hearing.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tools } from "./audio.ts";

/** Turned off by `--no-jingle` or by setting this in the environment. */
export const OFF = "NIXAMP_NO_JINGLE";

/**
 * Every jingle available, yours first, in a stable order.
 *
 * The match is deliberately loose -- any mp3 whose name contains "nixamp" --
 * because the point is that a file you drop in your home directory is picked
 * up, not that you named it exactly right. `001. NixAmp Whips the D-M-C-As.mp3`
 * is a name a person actually uses, and an anchored pattern missed it.
 */
export function findJingles(
  home = homedir(),
  packaged = packagedJingles(),
  read: (dir: string) => string[] = safeRead,
): string[] {
  // Guarded here rather than only inside the default reader: whether a jingle
  // can be found is this function's promise to keep, and it should not depend
  // on which reader it was handed.
  let names: string[];
  try {
    names = read(home);
  } catch {
    names = [];
  }
  const mine = names
    .filter((name) => name.toLowerCase().endsWith(".mp3") && name.toLowerCase().includes("nixamp"))
    .sort()
    .map((name) => join(home, name));
  return mine.length > 0 ? mine : packaged;
}

/**
 * One to play, chosen at random.
 *
 * Random rather than in turn: a rotation you can predict is one you stop
 * hearing, and there is no state worth keeping between runs for this.
 */
export function findJingle(
  home = homedir(),
  packaged = packagedJingles(),
  read: (dir: string) => string[] = safeRead,
  pick: (upTo: number) => number = (upTo) => Math.floor(Math.random() * upTo),
): string | null {
  const all = findJingles(home, packaged, read);
  if (all.length === 0) return null;
  return all[Math.min(all.length - 1, Math.max(0, pick(all.length)))] ?? null;
}

function safeRead(dir: string): string[] {
  return readdirSync(dir);
}

/**
 * The ones that ship, read from the list the web build writes.
 *
 * A list rather than a name, so adding another jingle is dropping a file in
 * and rebuilding rather than editing this.
 */
function packagedJingles(): string[] {
  try {
    // dist/jingle.js -> the package root -> web/dist, which is what `files`
    // in package.json actually ships.
    const dir = fileURLToPath(new URL("../web/dist/jingles", import.meta.url));
    const listed = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as unknown;
    if (!Array.isArray(listed)) return [];
    return listed
      .filter((name): name is string => typeof name === "string")
      .map((name) => join(dir, name));
  } catch {
    return [];
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

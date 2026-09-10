/**
 * Where the media is.
 *
 * A server that is not told serves the directory it was started in, and a
 * daemon restarted from a home directory served the home directory: every
 * key, session and download on the machine, listed in a public directory
 * under a link anybody could be handed. That is not a default anyone chose,
 * so it is not a default any more.
 *
 * The library is a setting. It is asked for once -- at sign-in, or the first
 * time the daemon is started without being told -- and kept beside the keys,
 * so `nixamp daemon start` on its own means the same folder every time. And
 * some folders are refused however they are asked for: the whole filesystem,
 * the home directory, anything above it, and the hidden folders where keys
 * and sessions live.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stateDir } from "./daemon.ts";

export interface Config {
  /** The folder the daemon serves when it is not told which. */
  library?: string;
}

export function configPath(): string {
  return join(stateDir(), "config.json");
}

export function readConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return { ...(typeof record["library"] === "string" ? { library: record["library"] } : {}) };
  } catch {
    return {};
  }
}

export function writeConfig(patch: Partial<Config>): void {
  const next = { ...readConfig(), ...patch };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/** The saved library, or "" when nobody has said yet. */
export function readLibrary(): string {
  return readConfig().library ?? "";
}

export function writeLibrary(path: string): void {
  writeConfig({ library: resolve(path) });
}

/**
 * Why a folder must not be served, or "" when it may be.
 *
 * Judged on the resolved path, so `~/..` and `/home/me/./` do not slip past.
 * A hidden folder inside home is refused because that is where `.ssh`,
 * `.config` and nixamp's own keys are; a hidden folder elsewhere is somebody's
 * deliberate choice.
 */
export function forbiddenLibrary(path: string, home = homedir()): string {
  const full = resolve(path);
  const house = resolve(home);
  if (full === "/" || /^[A-Za-z]:\\?$/.test(full)) return "the whole filesystem";
  if (full === house) return "your whole home directory";
  if (house.startsWith(`${full}/`)) return "a folder above your home directory";
  if (full.startsWith(`${house}/`)) {
    // Any dotted segment on the way, not only the last: ~/.local/state is
    // where nixamp's own keys are, and its basename says nothing.
    const hidden = full.slice(house.length + 1).split("/").find((segment) => segment.startsWith("."));
    if (hidden) return `a hidden folder (${hidden}), which is where keys and sessions live`;
  }
  return "";
}

/** Folders a person is likely to mean, in the order they are likely to mean them. */
export function suggestedLibraries(home = homedir()): string[] {
  return ["Music", "Videos", "Movies", "Downloads"]
    .map((name) => join(home, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/** One line from the terminal. Split out so the question can be tested. */
export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Ask where the media is, refusing the answers that must be refused, and
 * keep the answer. Empty when the person gave up or gave nothing usable
 * three times.
 */
export async function askLibrary(
  ask: (question: string) => Promise<string> = askLine,
  home = homedir(),
  say: (line: string) => void = (line) => console.log(line),
): Promise<string> {
  const suggestions = suggestedLibraries(home);
  say("Where is your media? nixamp serves one folder and nothing outside it.");
  for (const path of suggestions) say(`  ${path}`);
  const fallback = suggestions[0] ?? "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const typed = await ask(fallback ? `Folder [${fallback}]: ` : "Folder: ");
    const chosen = (typed || fallback).replace(/^~(?=$|\/)/, home);
    if (!chosen) continue;
    const full = resolve(chosen);
    const why = forbiddenLibrary(full, home);
    if (why) {
      say(`  nixamp will not serve ${why}. Pick a folder with your media in it.`);
      continue;
    }
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      say(`  ${full} is not a folder here.`);
      continue;
    }
    writeLibrary(full);
    say(`  Serving ${full}. Change it any time with \`nixamp library <folder>\`.`);
    return full;
  }
  return "";
}

/**
 * The library to use: the saved one, or -- when there is somebody to ask --
 * the one they name now. "" when there is neither.
 */
export async function chooseLibrary(interactive: boolean, ask?: (question: string) => Promise<string>): Promise<string> {
  const saved = readLibrary();
  if (saved) return saved;
  if (!interactive) return "";
  return askLibrary(ask);
}

/** `nixamp library [folder]`: say where the media is, or set it. */
export async function libraryCommand(argv: string[]): Promise<number> {
  const [given] = argv;
  if (!given) {
    const saved = readLibrary();
    if (!saved) {
      console.log("nixamp: no library set. `nixamp library ~/Music` sets it, and `nixamp daemon start` serves it.");
      return 1;
    }
    console.log(saved);
    return 0;
  }
  const full = resolve(given.replace(/^~(?=$|\/)/, homedir()));
  const why = forbiddenLibrary(full);
  if (why) {
    console.error(`nixamp: will not serve ${why}. Pick a folder with your media in it.`);
    return 64;
  }
  if (!existsSync(full) || !statSync(full).isDirectory()) {
    console.error(`nixamp: ${full} is not a folder here.`);
    return 66;
  }
  writeLibrary(full);
  console.log(`nixamp will serve ${full}. Start it with \`nixamp daemon start\`.`);
  return 0;
}

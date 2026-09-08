/**
 * Daemon mode.
 *
 * `nixamp serve` holds a terminal. A server you leave running should not, and
 * you should be able to walk away and come back to it, which means something on
 * disk has to remember where it is and what key it minted. That file is the
 * whole of the daemon: a pid to signal and enough to reconnect.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  /** The share key, so `nixamp admin` can talk to it without being told. */
  key: string | null;
  source: string;
  startedAt: number;
  /** Where its output went, for when it died and you want to know why. */
  log: string;
}

/** XDG, with the usual fallback. One daemon per user, which is one too few for nobody. */
export function stateDir(): string {
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(base, "nixamp");
}

export function statePath(): string {
  return join(stateDir(), "daemon.json");
}

export function logPath(): string {
  return join(stateDir(), "daemon.log");
}

export function readState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export function writeState(state: DaemonState): void {
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function clearState(): void {
  rmSync(statePath(), { force: true });
}

/**
 * Signal 0 asks "could I signal this?" without sending anything. A pid file
 * outlives the process that wrote it often enough that trusting one is how you
 * end up reporting a daemon that has been dead since Tuesday.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The daemon as far as anyone asking is concerned. */
export function status(): { running: boolean; state: DaemonState | null } {
  const state = readState();
  if (state === null) return { running: false, state: null };
  return { running: alive(state.pid), state };
}

/** The URL an admin client should talk to. */
export function daemonUrl(state: DaemonState): string {
  const host = state.host === "0.0.0.0" || state.host === "::" ? "127.0.0.1" : state.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${state.port}`;
}

/**
 * Start one, detached, and wait until it is actually answering before saying
 * it started. Reporting success and leaving the user to discover a crash in a
 * log file is the thing this is meant to avoid.
 */
export async function start(argv: string[], entry: string): Promise<DaemonState> {
  const existing = status();
  if (existing.running && existing.state) {
    throw new Error(`nixamp: a daemon is already running (pid ${existing.state.pid}). Stop it first.`);
  }

  mkdirSync(stateDir(), { recursive: true });
  const log = logPath();
  const out = openSync(log, "a");

  const child = spawn(process.execPath, [entry, "serve", ...argv, "--announce"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, NIXAMP_DAEMON: "1" },
  });
  child.unref();
  if (child.pid === undefined) throw new Error("nixamp: could not start the daemon");

  // The server prints one JSON line when it is listening, because guessing how
  // long a start takes is how a flaky `daemon start` is written.
  const announced = await waitForAnnounce(log, 15_000);
  if (announced === null) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // Already gone, which is the more likely reason we are here.
    }
    throw new Error(`nixamp: the daemon did not start. See ${log}`);
  }

  const state: DaemonState = { ...announced, pid: child.pid, startedAt: Date.now(), log };
  writeState(state);
  return state;
}

/** Poll the log for the announce line. */
async function waitForAnnounce(
  log: string,
  timeoutMs: number,
): Promise<Omit<DaemonState, "pid" | "startedAt" | "log"> | null> {
  const deadline = Date.now() + timeoutMs;
  const from = existsSync(log) ? readFileSync(log, "utf8").length : 0;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    let text: string;
    try {
      text = readFileSync(log, "utf8").slice(from);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line) as { nixamp?: string } & Record<string, unknown>;
        if (parsed["nixamp"] === "listening") {
          return {
            host: String(parsed["host"]),
            port: Number(parsed["port"]),
            key: (parsed["key"] as string | null) ?? null,
            source: String(parsed["source"]),
          };
        }
      } catch {
        // A partial line: it will be complete on the next pass.
      }
    }
  }
  return null;
}

/** Stop it, and wait for it to actually be gone. */
export async function stop(timeoutMs = 5000): Promise<boolean> {
  const { running, state } = status();
  if (!state) return false;
  if (!running) {
    clearState();
    return false;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    clearState();
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      clearState();
      return true;
    }
    await new Promise((done) => setTimeout(done, 100));
  }

  // It ignored SIGTERM. ffmpeg children make that more likely than it sounds.
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // Gone between the check and the signal.
  }
  clearState();
  return true;
}

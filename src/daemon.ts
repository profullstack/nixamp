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
import { type Firewall, portCommands, shareLink } from "./share.ts";

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
  /**
   * The labelled addresses the server itself worked out, share key not applied.
   *
   * Recorded rather than recomputed because only the server knows them: a
   * daemon bound to every interface has no single host to print, and the
   * public one may be a tunnel it was told about rather than an interface
   * anybody here can see. Absent on a state file written by an older nixamp.
   */
  urls?: { label: string; url: string }[];
  /** The firewall standing between this port and the rest of the network. */
  firewall?: string | null;
  /**
   * The public address was asked of an outside service rather than found on an
   * interface, so it names the router and not this port.
   */
  guessedPublic?: boolean;
  /**
   * What it was started with, so it can be started that way again.
   *
   * A daemon serving TLS on a public name is six flags, and restarting it
   * meant finding them again -- from shell history, or from `ps`, or not at
   * all. Absent on a state file written by an older nixamp, which is why
   * `restart` says so rather than starting something different.
   */
  argv?: string[];
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
  // A daemon serving https has a certificate for a name, and loopback is not
  // that name. Asking it for https://localhost fails verification even though
  // it is the same process on the same machine, which is how turning TLS on
  // silently broke `nixamp admin` and `nixamp attach`. Prefer the address it
  // was told to publish, which is the one the certificate is actually for.
  const told = state.urls?.find(
    (entry) => entry.label === "on the internet" && entry.url.startsWith("https://"),
  );
  if (told) return told.url;

  const scheme = state.urls?.[0]?.url.startsWith("https://") ? "https" : "http";
  const host = state.host === "0.0.0.0" || state.host === "::" ? "127.0.0.1" : state.host;
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}:${state.port}`;
}

/**
 * Whether this address is our own machine over TLS with a certificate that
 * cannot possibly name it.
 *
 * A certificate proves you reached the host you asked for. Asking for loopback
 * proves that already: nothing is in the way to impersonate. So a daemon with a
 * certificate for some public name is still reachable at 127.0.0.1, and a
 * client refusing to talk to it is protecting nobody from anything.
 */
export function isLoopbackTls(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * How long it has been up, as a person would say it. Written here rather than
 * borrowed from admin.ts, which would drag the whole terminal UI into a code
 * path that only prints four lines.
 */
function spell(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What `nixamp daemon start` and `nixamp daemon status` print, as lines, so it
 * can be tested without starting a daemon.
 *
 * Every address the server found, not one loopback link: the point of a daemon
 * is the phone in the other room, and 127.0.0.1 is the single address that
 * cannot be handed to anybody. The firewall warning comes with it because the
 * server writes that into a log file nobody reads, not to the person who just
 * typed the command.
 */
export function daemonLines(state: DaemonState, uptimeMs?: number): string[] {
  // The daemon's own key is the one that administers, so it is an /a/ link.
  const link = (url: string): string => shareLink(url, state.key ?? null);
  // A state file written by an older nixamp has no list, so host and port
  // still stand in rather than printing nothing at all.
  const addresses = state.urls ?? [{ label: "here", url: daemonUrl(state) }];
  const width = Math.max(...addresses.map((a) => a.label.length), "source".length);

  const lines = [`nixamp daemon running (pid ${state.pid})`];
  for (const { label, url } of addresses) lines.push(`  ${label.padEnd(width)}  ${link(url)}`);
  lines.push(`  ${"source".padEnd(width)}  ${state.source}`);
  if (uptimeMs !== undefined) lines.push(`  ${"up".padEnd(width)}  ${spell(uptimeMs)}`);

  if (state.guessedPublic) {
    lines.push(
      "",
      "  That internet address is this machine's router, not this port.",
      `  Nothing outside reaches it until ${state.port} is forwarded here.`,
    );
  }
  if (state.firewall) {
    const { open } = portCommands(state.firewall as Firewall, state.port);
    lines.push(
      "",
      `  ${state.firewall} is running, so nothing else can reach port ${state.port} yet:`,
      `    sudo ${open.join(" ")}`,
      "  or `nixamp daemon stop` and start again with --open-port.",
    );
  }
  if (!addresses.some((a) => a.label === "on the internet")) {
    lines.push(
      "",
      "  None of those work from outside this network. If it should:",
      "    nixamp daemon start ... --public-url https://your-tunnel.example.com",
    );
  }

  lines.push(
    "",
    "  nixamp attach       the player, in front of it",
    "  nixamp admin        who is connected",
    "  nixamp daemon stop  when you are done",
  );
  return lines;
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

  const state: DaemonState = { ...announced, pid: child.pid, startedAt: Date.now(), log, argv };
  writeState(state);
  return state;
}

/**
 * Stop it and start it again, the way it was started.
 *
 * The flags are replayed from the state file rather than retyped, because the
 * interesting daemons are the ones with the most flags: a certificate, a key,
 * a public URL. Given arguments of its own it uses those instead, which is how
 * you change one thing without stopping and starting by hand.
 */
export async function restart(
  argv: string[],
  entry: string,
  /** Injected so a test can see which arguments would be replayed. */
  starter: typeof start = start,
): Promise<DaemonState> {
  const { state } = status();
  const before = state?.argv;
  if (argv.length === 0 && before === undefined && state !== null) {
    throw new Error(
      "nixamp: this daemon was started by an older nixamp, which did not record its flags. " +
        "Stop it and start it again with the flags you want.",
    );
  }
  await stop();
  return starter(argv.length > 0 ? argv : (before ?? []), entry);
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
          const urls = parsed["urls"];
          return {
            host: String(parsed["host"]),
            port: Number(parsed["port"]),
            key: (parsed["key"] as string | null) ?? null,
            source: String(parsed["source"]),
            ...(Array.isArray(urls) ? { urls: urls as { label: string; url: string }[] } : {}),
            ...(typeof parsed["firewall"] === "string" ? { firewall: parsed["firewall"] } : {}),
            ...(parsed["guessedPublic"] === true ? { guessedPublic: true } : {}),
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

/**
 * What stations cost to run, and the limits that keep one from costing
 * everything.
 *
 * Counted where it is spent: every byte a station's link delivers and every
 * second somebody is connected, per station, per calendar month, kept in
 * `usage-<port>.json`. Restarts and files that would not play are counted
 * too, because those are what an operator is asked about.
 *
 * Limits are the operator's (environment, below), and each is a refusal a
 * person can act on, never a silent cut:
 *
 *   NIXAMP_STATION_MAX_LISTENERS   per station (default 200)
 *   NIXAMP_MAX_LISTENERS           across every station (default 500)
 *   NIXAMP_MAX_RUNNING_STATIONS    stations on the air at once (default 1000)
 *
 * The same names, lower-cased without the prefix, can be kept in config.json
 * under "limits" (e.g. {"limits": {"runningStations": 30}}); the environment
 * wins when both are set. A daemon is restarted by every update, and an
 * environment variable typed at a terminal does not survive that.
 *   NIXAMP_STATION_MONTHLY_GB      delivered per station per month (default 0: no allowance)
 *
 * When an allowance runs out the policy is "pause": nobody new is admitted
 * until the month turns or the allowance is raised; nobody already
 * listening is cut off mid-song. Control requests are limited separately
 * (STATION_CONTROL_LIMIT) so that a flood of listeners never locks the owner
 * out, and a flood of control requests never starves listeners.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Limits {
  stationListeners: number;
  totalListeners: number;
  runningStations: number;
  /** Bytes per station per month; 0 is no allowance. */
  monthlyBytes: number;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env, saved: Partial<Record<keyof Limits | "monthlyGb", unknown>> = {}): Limits {
  const whole = (name: string, key: keyof typeof saved, fallback: number): number => {
    for (const raw of [env[name], saved[key]]) {
      if (raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    }
    return fallback;
  };
  const gb = env["NIXAMP_STATION_MONTHLY_GB"] ?? saved.monthlyGb;
  return {
    stationListeners: whole("NIXAMP_STATION_MAX_LISTENERS", "stationListeners", 200),
    totalListeners: whole("NIXAMP_MAX_LISTENERS", "totalListeners", 500),
    runningStations: whole("NIXAMP_MAX_RUNNING_STATIONS", "runningStations", 1000),
    monthlyBytes: Math.round(Number(gb ?? 0) * 1024 ** 3) || 0,
  };
}

/** Station control: start, stop, edit, publish. Thirty a minute is a person. */
export const STATION_CONTROL_LIMIT = { allowed: 30, windowMs: 60_000 };

export interface MonthUsage {
  bytes: number;
  listenerSeconds: number;
  peakListeners: number;
  restarts: number;
  failures: number;
}

const BLANK: MonthUsage = { bytes: 0, listenerSeconds: 0, peakListeners: 0, restarts: 0, failures: 0 };

export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export class StationUsage {
  /** station -> month -> usage */
  private usage: Record<string, Record<string, MonthUsage>> = {};
  private live = new Map<string, Map<object, number>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    try {
      this.usage = JSON.parse(readFileSync(file, "utf8")) as typeof this.usage;
    } catch {
      this.usage = {};
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `usage-${port}.json`);
  }

  private month(station: string, at = this.now()): MonthUsage {
    const byMonth = (this.usage[station] ??= {});
    return (byMonth[monthOf(at)] ??= { ...BLANK });
  }

  private touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 5_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Listening still going on is counted up to now, then counted on from now.
    const at = this.now();
    for (const [station, listeners] of this.live) {
      for (const [who, since] of listeners) {
        this.month(station, at).listenerSeconds += Math.max(0, (at - since) / 1000);
        listeners.set(who, at);
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.usage), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      // Counting is not a reason to stop serving.
    }
  }

  /** Somebody started listening; returns what to call when they stop. */
  joined(station: string): () => void {
    const who = {};
    let listeners = this.live.get(station);
    if (!listeners) {
      listeners = new Map();
      this.live.set(station, listeners);
    }
    listeners.set(who, this.now());
    const month = this.month(station);
    month.peakListeners = Math.max(month.peakListeners, listeners.size);
    this.touch();
    return () => {
      const since = listeners!.get(who);
      if (since === undefined) return;
      listeners!.delete(who);
      this.month(station).listenerSeconds += Math.max(0, (this.now() - since) / 1000);
      this.touch();
    };
  }

  delivered(station: string, bytes: number): void {
    this.month(station).bytes += bytes;
    this.touch();
  }

  restarted(station: string): void {
    this.month(station).restarts += 1;
    this.touch();
  }

  failed(station: string): void {
    this.month(station).failures += 1;
    this.touch();
  }

  listeners(station: string): number {
    return this.live.get(station)?.size ?? 0;
  }

  totalListeners(): number {
    let total = 0;
    for (const listeners of this.live.values()) total += listeners.size;
    return total;
  }

  thisMonth(station: string): MonthUsage {
    return { ...this.month(station) };
  }

  history(station: string): Record<string, MonthUsage> {
    return { ...(this.usage[station] ?? {}) };
  }

  forget(station: string): void {
    delete this.usage[station];
    this.live.delete(station);
    this.touch();
  }

  /**
   * Whether one more listener may join this station now: null to go
   * ahead, or why not, with a code and how long to wait.
   */
  admit(station: string, limits: Limits): { code: string; error: string; status: number; retryAfter: number } | null {
    if (limits.monthlyBytes > 0 && this.month(station).bytes >= limits.monthlyBytes) {
      const now = new Date(this.now());
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      return { code: "allowance_exhausted", error: "this station has used its delivery allowance for the month", status: 429, retryAfter: Math.ceil((next - this.now()) / 1000) };
    }
    if (limits.stationListeners > 0 && this.listeners(station) >= limits.stationListeners) {
      return { code: "station_full", error: "this station is full; try again in a little while", status: 503, retryAfter: 60 };
    }
    if (limits.totalListeners > 0 && this.totalListeners() >= limits.totalListeners) {
      return { code: "server_full", error: "this server is carrying as many listeners as it can; try again in a little while", status: 503, retryAfter: 60 };
    }
    return null;
  }
}

/** Things an owner should know about a station, in words. */
export function alertsFor(
  station: { desired: string; failures: Record<string, number> },
  state: string,
  offlineSince: number,
  usage: MonthUsage,
  limits: Limits,
  now = Date.now(),
): string[] {
  const alerts: string[] = [];
  if (station.desired === "running" && (state === "offline" || state === "recovering") && offlineSince > 0) {
    const minutes = Math.floor((now - offlineSince) / 60_000);
    if (minutes >= 2) alerts.push(`Off the air for ${minutes} minutes while it should be running.`);
  }
  const left = Object.values(station.failures).filter((count) => count >= 3).length;
  if (left > 0) alerts.push(`${left} file${left === 1 ? " is" : "s are"} left out because ${left === 1 ? "it" : "they"} would not play.`);
  if (usage.restarts >= 5) alerts.push(`Restarted ${usage.restarts} times this month: something keeps stopping it.`);
  if (limits.monthlyBytes > 0) {
    const share = usage.bytes / limits.monthlyBytes;
    if (share >= 1) alerts.push("The delivery allowance for this month is used up: nobody new can join until it resets.");
    else if (share >= 0.9) alerts.push(`${Math.round(share * 100)}% of this month's delivery allowance is used.`);
  }
  return alerts;
}

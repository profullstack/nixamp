/**
 * Keeping stations on the air: start, stop, skip, and coming back after
 * something went wrong.
 *
 * The runner owns the gap between what the owner asked for and what is
 * happening. A station that should be running and is not is restarted with a
 * growing delay (RECOVERY_DELAYS_MS), then tried every OFFLINE_RETRY_MS for as
 * long as it is still wanted, so a disk that comes back or a file put back in
 * place brings it back under the same id and link. A station its owner
 * stopped is never restarted by anything here.
 */
import type { Channels, ChannelInfo, PullResume } from "./channels.ts";
import {
  EXCLUDE_AFTER, OFFLINE_RETRY_MS, RECOVERY_DELAYS_MS, StationError, channelOf, insideRoots, shuffled,
  stationOfChannel, type Observed, type Station, type StationStore,
} from "./stations.ts";

export interface RunnerDeps {
  store: StationStore;
  channels: Channels;
  /** Put a list of files on the air as this channel; false when it could not. */
  pull: (channelId: string, name: string, files: string[], known: { rotation: NonNullable<PullResume["rotation"]>; audioBitrate: number }) => Promise<boolean>;
  /** The folders a station's files have to be inside. */
  roots: () => string[];
  log?: (line: string) => void;
  now?: () => number;
  /** Told when a station is restarted after an unexpected end, and when a file will not play. */
  onRestart?: (id: string) => void;
  onFailure?: (id: string) => void;
  /** A file for a break on a radio (false) or TV (true) station, or null for none. */
  breaks?: (video: boolean) => Promise<string | null>;
}

/** Something a listener is connected through, that can be ended. */
export interface Ending {
  end(): void;
}

/** A run shorter than this that ends badly does not reset the backoff. */
const HEALTHY_RUN_MS = 60_000;

export class StationRunner {
  private attempts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private startedAt = new Map<string, number>();
  private stopping = new Set<string>();
  private starting = new Set<string>();
  private errors = new Map<string, string>();
  private listening = new Map<string, Set<Ending>>();
  /** When a station that should be on went off, for "off the air for N minutes". */
  private down = new Map<string, number>();

  constructor(private readonly deps: RunnerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  /** The station's files that are still where they were, inside the library. */
  playable(station: Station): string[] {
    const roots = this.deps.roots();
    return station.items.filter((file) => insideRoots(file, roots));
  }

  /** Wanted on, and put on. */
  async start(id: string): Promise<Station> {
    const station = this.deps.store.get(id);
    if (!station) throw new StationError("not_found", "no such station", 404);
    if (this.playable(station).length === 0) {
      throw new StationError("nothing_playable", "none of this station's files can be found in the library", 409);
    }
    this.deps.store.setDesired(id, "running", this.now());
    this.cancelRecovery(id);
    this.attempts.delete(id);
    await this.launch(id);
    return this.deps.store.get(id)!;
  }

  /** Wanted off, and taken off. Stays off across restarts. */
  stop(id: string): Station {
    const station = this.deps.store.setDesired(id, "stopped", this.now());
    this.down.delete(id);
    this.cancelRecovery(id);
    this.attempts.delete(id);
    this.errors.delete(id);
    const channelId = channelOf(id);
    if (this.deps.channels.has(channelId)) {
      this.stopping.add(channelId);
      this.deps.channels.stop(channelId);
    }
    return station;
  }

  /** The next track, now. */
  skip(id: string): void {
    if (!this.deps.store.get(id)) throw new StationError("not_found", "no such station", 404);
    if (!this.deps.channels.skip(channelOf(id))) throw new StationError("not_live", "the station is not playing", 409);
  }

  /** Stopped and forgotten. */
  remove(id: string): void {
    if (!this.deps.store.get(id)) throw new StationError("not_found", "no such station", 404);
    this.stop(id);
    this.revoke(id);
    this.deps.store.remove(id);
  }

  /** Put back every station that was running when this server last stopped. */
  restore(): void {
    for (const station of this.deps.store.list()) {
      if (station.desired !== "running") continue;
      this.log(`  Putting station "${station.name}" back on the air.`);
      void this.launch(station.id);
    }
  }

  private async launch(id: string): Promise<boolean> {
    const station = this.deps.store.get(id);
    if (!station || station.desired !== "running") return false;
    const channelId = channelOf(id);
    if (this.deps.channels.has(channelId) || this.starting.has(id)) return true;
    const files = this.playable(station);
    if (files.length === 0) {
      this.errors.set(id, "none of this station's files can be found in the library");
      this.scheduleRecovery(id);
      return false;
    }
    this.starting.add(id);
    const store = this.deps.store;
    try {
      const ok = await this.deps.pull(channelId, station.name, files, {
        audioBitrate: station.bitrate,
        rotation: {
          repeat: station.repeat,
          passOver: true,
          // Read at every pass, so turning shuffle on or off lands then.
          order: (length) => (store.get(id)?.shuffle ? shuffled(length) : [...Array(length).keys()]),
          // Read at every track, so an edit lands on the next one.
          current: () => {
            const now = store.get(id);
            return now ? this.playable(now) : [];
          },
          excluded: (file) => store.isExcluded(id, file),
          // Read at every boundary, so setting breaks on a running station
          // lands without a restart; 0 is none.
          ...(this.deps.breaks
            ? { breaks: { everySeconds: () => store.get(id)?.breaksEvery ?? 0, next: () => this.deps.breaks!(station.video) } }
            : {}),
          onFailure: ({ file, reason }) => {
            this.errors.set(id, reason);
            this.deps.onFailure?.(id);
            if (store.recordFailure(id, file)) {
              this.log(`  Station "${station.name}": left out a file that failed ${EXCLUDE_AFTER} times.`);
            }
          },
        },
      });
      if (!ok) {
        this.errors.set(id, "the station could not start");
        this.scheduleRecovery(id);
        return false;
      }
      this.startedAt.set(id, this.now());
      this.down.delete(id);
      this.deps.channels.keep(channelId);
      return true;
    } catch (error) {
      this.errors.set(id, error instanceof Error ? error.message : String(error));
      this.scheduleRecovery(id);
      return false;
    } finally {
      this.starting.delete(id);
    }
  }

  /** Told by the server when any channel ends. */
  onChannelEnd(info: ChannelInfo): void {
    const id = stationOfChannel(info.id);
    if (!id) return;
    if (this.stopping.delete(info.id)) return;
    const station = this.deps.store.get(id);
    if (!station || station.desired !== "running") return;
    // A list that is not repeated played through: that is the end of it,
    // which is the owner's choice, not a failure.
    if (info.ended && !station.repeat) {
      this.deps.store.setDesired(id, "stopped", this.now());
      this.errors.delete(id);
      return;
    }
    if (!this.down.has(id)) this.down.set(id, this.now());
    this.deps.onRestart?.(id);
    const ran = this.now() - (this.startedAt.get(id) ?? 0);
    if (ran >= HEALTHY_RUN_MS) this.attempts.delete(id);
    this.errors.set(id, info.error || "the station stopped");
    this.scheduleRecovery(id);
  }

  private scheduleRecovery(id: string): void {
    if (this.timers.has(id)) return;
    const attempt = this.attempts.get(id) ?? 0;
    const delay = attempt < RECOVERY_DELAYS_MS.length ? RECOVERY_DELAYS_MS[attempt]! : OFFLINE_RETRY_MS;
    this.attempts.set(id, attempt + 1);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.launch(id);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private cancelRecovery(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  observed(id: string): Observed {
    const station = this.deps.store.get(id);
    if (!station) return "stopped";
    if (station.desired === "stopped") return "stopped";
    if (this.starting.has(id)) return "starting";
    const info = this.deps.channels.info(channelOf(id));
    if (info) return info.redials ? "recovering" : "live";
    return (this.attempts.get(id) ?? 0) <= RECOVERY_DELAYS_MS.length && this.timers.has(id) ? "recovering" : "offline";
  }

  /** When it went off while wanted, or 0 when it is not off. */
  downSince(id: string): number {
    return this.down.get(id) ?? 0;
  }

  error(id: string): string {
    return this.errors.get(id) ?? "";
  }

  /** A listener on a station's link, ended if the link is revoked. */
  track(id: string, listener: Ending): () => void {
    let set = this.listening.get(id);
    if (!set) {
      set = new Set();
      this.listening.set(id, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  listeners(id: string): number {
    return this.listening.get(id)?.size ?? 0;
  }

  /** Everybody listening through a link that no longer works is let go. */
  revoke(id: string): number {
    const set = this.listening.get(id);
    if (!set) return 0;
    const count = set.size;
    for (const one of [...set]) {
      try { one.end(); } catch { /* already gone */ }
    }
    set.clear();
    return count;
  }
}

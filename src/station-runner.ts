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
 *
 * A station nobody is listening to sleeps: after `idleSeconds` with nobody
 * attached to its channel, the channel (and its ffmpeg) is stopped, but the
 * station stays wanted on and is still on the air to the guide. The first
 * listener wakes it, and it carries on from the track after the one it slept
 * on, with its break clock where it was. A sleep is not a failure: no
 * recovery, no restart counted.
 */
import type { Channels, ChannelInfo, PullResume } from "./channels.ts";
import {
  EXCLUDE_AFTER, OFFLINE_RETRY_MS, RECOVERY_DELAYS_MS, StationError, channelOf, insideRoots, spreadByArtist,
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
  /** Who a file is by, from the library's tags, for a shuffle that spreads artists out; "" when unknown. */
  artistOf?: (file: string) => string;
  /** Seconds with nobody listening before a station sleeps; 0 (or unset) never. Asked at every sweep. */
  idleSeconds?: () => number;
}

/** How long a listener waking a station is held for its first bytes. */
export const WAKE_WAIT_MS = 10_000;

/**
 * Who a file is by when the tags do not say: "Artist - Album/track" names
 * them in the folder, and "Artist/Album/track" one folder up.
 */
export function artistFromPath(file: string): string {
  const parts = file.split(/[\\/]/);
  const folder = parts[parts.length - 2] ?? "";
  const dash = folder.indexOf(" - ");
  if (dash > 0) return folder.slice(0, dash);
  return parts[parts.length - 3] ?? folder;
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
  /** The server is going down: its channels end because it is, not because a station failed. */
  private closing = false;
  /** Wanted on, with nobody listening: no channel until somebody does. */
  private asleep = new Set<string>();
  /** For a station asleep: the rest of the pass it was playing, in order. */
  private parked = new Map<string, string[]>();
  /** Since when a station's channel has had nobody on it. */
  private quietSince = new Map<string, number>();
  private waking = new Map<string, Promise<boolean>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Called before the server stops every channel on its way out. Without it,
   * each update or restart counted as a restart of every station, and after a
   * busy day every station said "something keeps stopping it".
   */
  close(): void {
    if (!this.closing) {
      // Where each station on the air was, so after an update it wakes on
      // the next track with its break clock, as it would from a sleep.
      for (const station of this.deps.store.list()) {
        if (station.desired !== "running" || this.asleep.has(station.id)) continue;
        const point = this.deps.channels.resumePoint(channelOf(station.id));
        if (point) this.deps.store.setResume(station.id, { after: point.file || station.resume?.after || "", sinceBreak: point.sinceBreak });
      }
    }
    this.closing = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

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
    this.asleep.delete(id);
    this.cancelRecovery(id);
    this.attempts.delete(id);
    await this.launch(id);
    return this.deps.store.get(id)!;
  }

  /** Wanted off, and taken off. Stays off across restarts. */
  stop(id: string): Station {
    const station = this.deps.store.setDesired(id, "stopped", this.now());
    this.asleep.delete(id);
    this.parked.delete(id);
    this.quietSince.delete(id);
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
    // Asleep, the next track is the one after the one it will wake on.
    if (this.asleep.has(id)) {
      this.parked.get(id)?.shift();
      return;
    }
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
    // Asleep until somebody listens, when stations sleep at all: putting
    // every one on at once, to have each go back to sleep a minute later,
    // is a storm of ffmpeg for nobody.
    const sleepy = (this.deps.idleSeconds?.() ?? 0) > 0;
    for (const station of this.deps.store.list()) {
      if (station.desired !== "running") continue;
      if (sleepy) {
        this.asleep.add(station.id);
        continue;
      }
      this.log(`  Putting station "${station.name}" back on the air.`);
      void this.launch(station.id);
    }
  }

  /** Whether a station is asleep: wanted on, on the air to the guide, with no channel until somebody listens. */
  isSleeping(id: string): boolean {
    return this.asleep.has(id);
  }

  /** The file a sleeping station would wake on, "" when it cannot say. */
  nextUp(id: string): string {
    if (!this.asleep.has(id)) return "";
    const parked = this.parked.get(id)?.[0];
    if (parked) return parked;
    const station = this.deps.store.get(id);
    if (!station || station.shuffle || !station.resume?.after) return "";
    const files = station.items;
    const at = files.indexOf(station.resume.after);
    return at >= 0 ? files[at + 1] ?? "" : "";
  }

  /** Look every so often for stations nobody is listening to. */
  watchIdle(everyMs = 5_000): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.sweep(), everyMs);
    this.idleTimer.unref?.();
  }

  /**
   * Put to sleep every station whose channel has had nobody on it for the
   * idle time. Anybody attached counts: a listener on the link or /radio, a
   * class or room relaying it, an HLS packager, a peer pulling it. The
   * now-playing events alone do not.
   */
  sweep(): void {
    const idle = this.deps.idleSeconds?.() ?? 0;
    if (idle <= 0 || this.closing) return;
    const now = this.now();
    for (const station of this.deps.store.list()) {
      const id = station.id;
      const channelId = channelOf(id);
      if (station.desired !== "running" || this.asleep.has(id) || this.starting.has(id) || !this.deps.channels.has(channelId)) {
        this.quietSince.delete(id);
        continue;
      }
      if (this.deps.channels.listenersOf(channelId) > 0) {
        this.quietSince.delete(id);
        continue;
      }
      const since = this.quietSince.get(id);
      if (since === undefined) this.quietSince.set(id, now);
      else if (now - since >= idle * 1000) this.sleep(id);
    }
  }

  /** Off the air for now, still wanted on: remembers where it was, and is not a failure. */
  sleep(id: string): void {
    const station = this.deps.store.get(id);
    const channelId = channelOf(id);
    if (!station || station.desired !== "running" || this.asleep.has(id)) return;
    const point = this.deps.channels.resumePoint(channelId);
    this.deps.store.setResume(id, {
      after: point?.file || station.resume?.after || "",
      sinceBreak: point ? point.sinceBreak : station.resume?.sinceBreak ?? 0,
    });
    this.parked.set(id, point?.upcoming ?? []);
    this.asleep.add(id);
    this.quietSince.delete(id);
    this.cancelRecovery(id);
    this.attempts.delete(id);
    this.errors.delete(id);
    this.down.delete(id);
    if (this.deps.channels.has(channelId)) {
      this.stopping.add(channelId);
      this.deps.channels.stop(channelId);
    }
    this.log(`  Station "${station.name}" is asleep until somebody listens.`);
  }

  /** On again for a listener, if it was asleep. True when its channel is up (or coming up). */
  wake(id: string): Promise<boolean> {
    const pending = this.waking.get(id);
    if (pending) return pending;
    if (!this.asleep.has(id)) return Promise.resolve(this.deps.channels.has(channelOf(id)) || this.starting.has(id));
    this.asleep.delete(id);
    this.quietSince.delete(id);
    const station = this.deps.store.get(id);
    if (station) this.log(`  Station "${station.name}" woke for a listener.`);
    const woken = this.launch(id).finally(() => this.waking.delete(id));
    this.waking.set(id, woken);
    return woken;
  }

  /**
   * Wake it if it is asleep, and wait (up to `timeoutMs`) for its first
   * bytes, so a listener hears it start rather than a stream that ends.
   * True when the channel is up.
   */
  async awake(id: string, timeoutMs = WAKE_WAIT_MS, gone: () => boolean = () => false): Promise<boolean> {
    const channelId = channelOf(id);
    const deadline = Date.now() + timeoutMs;
    const woke = this.asleep.has(id) || this.waking.has(id);
    if (!woke) return this.deps.channels.has(channelId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const up = await Promise.race([
      this.wake(id),
      new Promise<boolean>((done) => { timer = setTimeout(() => done(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!up && !this.deps.channels.has(channelId)) return false;
    while (!this.deps.channels.flowing(channelId) && Date.now() < deadline && !gone()) {
      if (!this.deps.channels.has(channelId) && !this.starting.has(id)) return false;
      await new Promise((done) => setTimeout(done, 50));
    }
    return this.deps.channels.has(channelId);
  }

  /**
   * Where a launch picks up: the rest of the pass it slept in, or (after the
   * server restarted) the files after the one it was on; and the break
   * clock. Taken once, by the next launch.
   */
  private takeResume(id: string, station: Station, files: string[]): { upcoming: string[] | null; sinceBreak: number } {
    const parked = this.parked.get(id);
    this.parked.delete(id);
    let upcoming: string[] | null = parked && parked.length > 0 ? parked : null;
    const after = station.resume?.after ?? "";
    if (!parked && after && !station.shuffle) {
      const at = files.indexOf(after);
      if (at >= 0 && at + 1 < files.length) upcoming = files.slice(at + 1);
    }
    const sinceBreak = station.resume?.sinceBreak ?? 0;
    // Used once: a recovery later is a start like any other.
    if (station.resume) this.deps.store.setResume(id, null);
    return { upcoming, sinceBreak };
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
    const resume = this.takeResume(id, station, files);
    // The first pass after a sleep is the rest of the one it slept in.
    let carryOn = resume.upcoming;
    let clock = resume.sinceBreak;
    try {
      const ok = await this.deps.pull(channelId, station.name, files, {
        audioBitrate: station.bitrate,
        rotation: {
          repeat: station.repeat,
          passOver: true,
          // Read at every pass, so turning shuffle on or off lands then.
          order: (length, files) => {
            if (carryOn) {
              const wanted = carryOn;
              carryOn = null;
              const index = new Map(files.map((file, at) => [file, at] as const));
              const picked = wanted.map((file) => index.get(file)).filter((at): at is number => at !== undefined && !store.isExcluded(id, files[at]!));
              if (picked.length > 0) return picked;
            }
            return store.get(id)?.shuffle
              ? spreadByArtist(files, (file) => this.deps.artistOf?.(file) || artistFromPath(file))
              : [...Array(length).keys()];
          },
          // Read at every track, so an edit lands on the next one.
          current: () => {
            const now = store.get(id);
            return now ? this.playable(now) : [];
          },
          excluded: (file) => store.isExcluded(id, file),
          // Read at every boundary, so setting breaks on a running station
          // lands without a restart; 0 is none.
          ...(this.deps.breaks
            ? { breaks: {
                everySeconds: () => store.get(id)?.breaksEvery ?? 0,
                next: () => this.deps.breaks!(station.video),
                // Once: a redial later in the day starts its own clock, as it always has.
                sinceBreak: () => { const was = clock; clock = 0; return was; },
              } }
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
    if (this.stopping.delete(info.id) || this.closing) return;
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
    // On the air to anyone asking: the first listener wakes it.
    if (this.asleep.has(id)) return "live";
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

/**
 * Diagnostic jobs: bounded, deduplicated, cancellable, forgotten in time.
 *
 * An analysis reads up to thirty seconds or twenty-five megabytes of a
 * channel and runs every codec over it, which is real work. So there is a
 * ceiling on how many run at once, a second request for the same thing
 * while the first is still going is handed the first, and a finished
 * result is kept for a while and then dropped rather than for ever.
 */
import { randomBytes } from "node:crypto";
import type { Analysis } from "./analyze.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  /** What is being analysed, for the listing. */
  subject: string;
  /** Who may see it: the scope that started it. */
  owner: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: { bytes: number; ms: number };
  result?: Analysis;
  error?: string;
}

export interface JobsOptions {
  concurrency?: number;
  /** How long a finished job is kept. */
  ttlMs?: number;
  /** How many jobs, in any state, may exist at once. */
  maxJobs?: number;
}

export type Runner = (signal: AbortSignal, progress: (bytes: number, ms: number) => void) => Promise<Analysis>;

interface Slot {
  job: Job;
  key: string;
  controller: AbortController;
  run: Runner;
}

export class AnalysisJobs {
  private readonly slots = new Map<string, Slot>();
  private readonly queue: Slot[] = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;

  constructor(options: JobsOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxJobs = options.maxJobs ?? 32;
  }

  /**
   * Start a job, or return the one already doing the same thing. `key`
   * names the thing: the same key while a job is queued or running is the
   * same job. Null when the server has all the jobs it will hold.
   */
  start(key: string, subject: string, owner: string, run: Runner): { job: Job; existing: boolean } | null {
    this.sweep();
    for (const slot of this.slots.values()) {
      if (slot.key === key && (slot.job.status === "queued" || slot.job.status === "running")) return { job: slot.job, existing: true };
    }
    if (this.slots.size >= this.maxJobs) return null;
    const job: Job = {
      id: `a${randomBytes(6).toString("hex")}`,
      subject,
      owner,
      status: "queued",
      createdAt: Date.now(),
      progress: { bytes: 0, ms: 0 },
    };
    const slot: Slot = { job, key, controller: new AbortController(), run };
    this.slots.set(job.id, slot);
    this.queue.push(slot);
    this.pump();
    return { job, existing: false };
  }

  /** A job, if it exists and `owner` may see it. */
  get(id: string, owner: string): Job | null {
    this.sweep();
    const slot = this.slots.get(id);
    if (!slot || slot.job.owner !== owner) return null;
    return slot.job;
  }

  cancel(id: string, owner: string): boolean {
    const slot = this.slots.get(id);
    if (!slot || slot.job.owner !== owner) return false;
    if (slot.job.status !== "queued" && slot.job.status !== "running") return false;
    slot.controller.abort();
    if (slot.job.status === "queued") {
      const at = this.queue.indexOf(slot);
      if (at !== -1) this.queue.splice(at, 1);
      slot.job.status = "cancelled";
      slot.job.finishedAt = Date.now();
    }
    return true;
  }

  list(owner: string): Job[] {
    this.sweep();
    return [...this.slots.values()].map((slot) => slot.job).filter((job) => job.owner === owner);
  }

  get counts(): { running: number; queued: number; kept: number } {
    return { running: this.running, queued: this.queue.length, kept: this.slots.size };
  }

  /** Stop everything, for a server going down. */
  stopAll(): void {
    for (const slot of this.slots.values()) slot.controller.abort();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const slot = this.queue.shift() as Slot;
      this.running += 1;
      slot.job.status = "running";
      slot.job.startedAt = Date.now();
      void slot
        .run(slot.controller.signal, (bytes, ms) => {
          slot.job.progress = { bytes, ms };
        })
        .then((result) => {
          slot.job.result = result;
          slot.job.status = slot.controller.signal.aborted ? "cancelled" : "done";
        })
        .catch((error: Error) => {
          slot.job.status = slot.controller.signal.aborted ? "cancelled" : "failed";
          slot.job.error = error.message;
        })
        .finally(() => {
          slot.job.finishedAt = Date.now();
          this.running -= 1;
          this.pump();
        });
    }
  }

  /** Forget finished jobs older than the TTL. */
  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, slot] of this.slots) {
      if (slot.job.finishedAt !== undefined && slot.job.finishedAt < cutoff) this.slots.delete(id);
    }
  }
}

/**
 * The one place the server, the CLI and the API ask about compression.
 *
 * It owns the policies, the shared encoders, the metrics, the diagnostic
 * jobs, the static cache and the incoming relays, and it is the only thing
 * that touches a channel on their behalf. Every surface is a thin client
 * of this: the routes translate HTTP into these calls and back, the CLI
 * translates flags into the routes. There is no second copy of the rules.
 */
import { statSync } from "node:fs";
import { codecsOf } from "../audio.ts";
import { type Channel, type Channels, GIVE_UP, REDIAL } from "../channels.ts";
import { type Analysis, analyzeSample, SAMPLE_MAX_BYTES, SAMPLE_MAX_SECONDS } from "./analyze.ts";
import { Pool } from "./codec.ts";
import { type Mode, RelayError } from "./envelope.ts";
import { AnalysisJobs, type Job } from "./jobs.ts";
import { ChannelMetrics, type ChannelMetricsSnapshot } from "./metrics.ts";
import { type ChannelPolicy, type LosslessPolicy, variantOf } from "./policy.ts";
import { receiveRelay, RelayRefused } from "./receiver.ts";
import { RelayEncoder, type RelayListener, type RelaySession } from "./relay.ts";
import { type GlobalSettings, PolicyStore } from "./store.ts";
import { type Prepared, StaticCache } from "./static.ts";

/** The pseudo-channel whose policy governs static file representations. */
export const STATIC_CHANNEL = "static";

export interface AnalyzeFileOptions {
  policy?: LosslessPolicy;
  ffprobe?: string[];
  signal?: AbortSignal;
}

/**
 * A file's first bytes, up to the sample limit, analysed at the source
 * boundary: these are the bytes as they sit on disk, before any ffmpeg.
 * Shared by the service and the CLI, which runs it with no server at all.
 */
export async function analyzeFile(path: string, options: AnalyzeFileOptions = {}): Promise<Analysis> {
  const size = statSync(path).size;
  const take = Math.min(size, SAMPLE_MAX_BYTES);
  const fd = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
  let sample: Buffer;
  try {
    sample = Buffer.alloc(take);
    let at = 0;
    while (at < take) {
      const { bytesRead } = await fd.read(sample, at, take - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    sample = sample.subarray(0, at);
  } finally {
    await fd.close();
  }
  const ffprobe = options.ffprobe;
  const codecs = ffprobe ? await codecsOf({ ffmpeg: [], ffprobe, play: null }, path) : undefined;
  return analyzeSample(sample, {
    boundary: "source",
    source: { kind: "file", name: path },
    truncated: take < size,
    tsAware: true,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(codecs && codecs.container ? { codecs } : {}),
    ...(ffprobe ? { ffprobeVersion: ffprobe.join(" ") } : {}),
  });
}

export interface CompressionServiceOptions {
  channels: Channels;
  /** Where settings live; null for a server that remembers nothing. */
  stateDir: string | null;
  port: number;
  pool?: Pool;
  ffprobe?: string[];
  /** Where static representations go; null to keep none. */
  cacheDir?: string | null;
  maxCacheBytes?: number;
  onEvent?: (message: string) => void;
}

export interface EffectivePolicy {
  /** The policy as it applies right now, after the global switch. */
  losslessCompression: LosslessPolicy;
  hlsPackaging: ChannelPolicy["hlsPackaging"];
  qualityProfile: ChannelPolicy["qualityProfile"];
  /** Why it differs from what is configured, when it does. */
  reason: string | null;
}

export interface ChannelStatus {
  channel: string;
  live: boolean;
  configured: ChannelPolicy;
  effective: EffectivePolicy;
  global: GlobalSettings;
  metrics: ChannelMetricsSnapshot | null;
  relay: { sessions: number; generation: number } | null;
  /** An incoming relay this channel is fed by, when it is. */
  incoming: { from: string; generation: number; reconnects: number; error: string | null } | null;
}

export type RelayAnswer =
  | { ok: true; session: RelaySession; codecs: Mode[]; generation: number; kind: "audio" | "video" | "" }
  | { ok: false; status: 404 | 406 | 409 | 503; code: string; error: string };

interface Running {
  encoder: RelayEncoder;
  detach: () => void;
  variant: string;
}

/** An incoming relay: this server as the receiver, dialling again when it drops. */
class Incoming {
  generation = 0;
  reconnects = 0;
  error: string | null = null;
  private stopped = false;
  private failures = 0;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private channel: Channel | null = null;

  constructor(
    readonly id: string,
    readonly from: string,
    private readonly key: string | null,
    private readonly name: string,
    private readonly channels: Channels,
    private readonly onEvent: (message: string) => void,
    private readonly onGone: (id: string) => void,
  ) {}

  start(): void {
    void this.dial();
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    this.controller = new AbortController();
    let received = 0;
    try {
      await receiveRelay({
        url: this.from,
        key: this.key,
        signal: this.controller.signal,
        onStart: ({ kind }) => {
          if (this.channel === null) {
            const opened = this.channels.relayIn(this.id, this.name, kind === "video" ? "video" : "audio", this.from);
            if (!opened) throw new RelayRefused(409, `channel "${this.id}" is already on`);
            this.channel = opened;
          } else {
            // A new generation upstream: new opening boxes, so everybody
            // watching here starts over too.
            this.channel.rollover();
          }
        },
        onHeader: (header) => {
          this.generation = header.generation;
        },
        onBytes: (bytes) => {
          received += bytes.length;
          this.channel?.receive(bytes);
        },
      });
      // A clean end is the upstream's source starting over, or going off.
      // Either way: dial again, and let the new generation say which.
      this.error = null;
      this.failures = 0;
    } catch (error) {
      if (this.stopped) return;
      this.error = error instanceof RelayError ? `${error.code}: ${error.message}` : (error as Error).message;
      this.onEvent(`  relay "${this.id}" from ${this.from}: ${this.error}`);
      this.failures = received > 0 ? 0 : this.failures + 1;
      if (error instanceof RelayRefused && error.status === 409 && this.channel === null) {
        this.stop();
        return;
      }
      if (this.failures >= GIVE_UP) {
        this.onEvent(`  relay "${this.id}" gave up: ${GIVE_UP} dials without a byte`);
        this.stop();
        return;
      }
    }
    if (this.stopped || !this.channels.has(this.id)) {
      this.stop();
      return;
    }
    this.reconnects += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dial();
    }, REDIAL);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller.abort();
    this.channel?.close();
    this.channel = null;
    this.onGone(this.id);
  }
}

export class CompressionService {
  readonly store: PolicyStore;
  readonly jobs: AnalysisJobs;
  readonly pool: Pool;
  readonly statics: StaticCache | null;
  private readonly running = new Map<string, Running>();
  private readonly metrics = new Map<string, ChannelMetrics>();
  private readonly incoming = new Map<string, Incoming>();
  private generation = Math.floor(Date.now() / 1000) % 0x7fff_ffff;

  constructor(private readonly options: CompressionServiceOptions) {
    this.store = new PolicyStore(options.stateDir, options.port);
    this.jobs = new AnalysisJobs({ concurrency: 1 });
    this.pool = options.pool ?? new Pool({ concurrency: 4, maxQueued: 256, timeoutMs: 2000 });
    this.statics = options.cacheDir
      ? new StaticCache(options.cacheDir, { pool: this.pool, ...(options.maxCacheBytes !== undefined ? { maxBytes: options.maxCacheBytes } : {}) })
      : null;
  }

  private get channels(): Channels {
    return this.options.channels;
  }

  /** What applies to a channel right now, and why that is not what is configured, if it is not. */
  effective(id: string): EffectivePolicy {
    const configured = this.store.get(id);
    const global = this.store.global;
    const lossless = { ...configured.losslessCompression };
    let reason: string | null = null;
    if (!global.enabled && lossless.mode !== "off") {
      lossless.mode = "off";
      reason = "compression is off for the whole server";
    } else if (lossless.mode !== "off" && lossless.boundary === "source") {
      lossless.mode = "off";
      reason = "original source bytes are unavailable: this server's sources are read by ffmpeg, and only the channel boundary can be relayed";
    }
    return {
      losslessCompression: lossless,
      hlsPackaging: this.store.has(id) ? configured.hlsPackaging : global.hlsPackaging,
      qualityProfile: configured.qualityProfile,
      reason,
    };
  }

  /** For the HLS packager: how to wrap this channel. */
  packagingOf(id: string): ChannelPolicy["hlsPackaging"] {
    return this.effective(id).hlsPackaging;
  }

  status(id: string): ChannelStatus {
    const live = this.channels.has(id);
    const running = this.running.get(id);
    const inbound = this.incoming.get(id);
    return {
      channel: id,
      live,
      configured: this.store.get(id),
      effective: this.effective(id),
      global: this.store.global,
      metrics: this.metrics.get(id)?.snapshot() ?? null,
      relay: running ? { sessions: running.encoder.sessionCount, generation: running.encoder.generation } : null,
      incoming: inbound ? { from: inbound.from, generation: inbound.generation, reconnects: inbound.reconnects, error: inbound.error } : null,
    };
  }

  /** The whole server at a glance. */
  overview(): { global: GlobalSettings; pool: Pool["stats"]; jobs: AnalysisJobs["counts"]; channels: ChannelStatus[]; cache: { bytes: number; entries: number } | null } {
    const ids = new Set<string>([...this.channels.list().map((c) => c.id), ...Object.keys(this.store.list()), ...this.running.keys(), ...this.incoming.keys()]);
    return {
      global: this.store.global,
      pool: this.pool.stats,
      jobs: this.jobs.counts,
      channels: [...ids].sort().map((id) => this.status(id)),
      cache: this.statics ? { bytes: this.statics.totalBytes, entries: this.statics.entries().length } : null,
    };
  }

  /** Change a channel's policy. A live relay under a different variant is ended; receivers reconnect. */
  set(id: string, change: unknown, expectVersion?: number): ReturnType<PolicyStore["set"]> {
    const result = this.store.set(id, change, expectVersion);
    if (result.ok) this.applyPolicy(id);
    return result;
  }

  setGlobal(change: Partial<GlobalSettings>): GlobalSettings {
    const settings = this.store.setGlobal(change);
    for (const id of [...this.running.keys()]) this.applyPolicy(id);
    return settings;
  }

  /** The kill switch, and its opposite. */
  private applyPolicy(id: string): void {
    const running = this.running.get(id);
    if (!running) return;
    const effective = this.effective(id).losslessCompression;
    if (effective.mode === "off" || variantOf(effective) !== running.variant) {
      // Not a clean end: the receiver sees the stream stop without its
      // marker, reports a disconnect, and dials again under the new policy.
      running.encoder.end();
    }
  }

  /**
   * A receiver asking for a channel. Everything that can go wrong is
   * answered before a byte of stream: no such channel, compression off,
   * a boundary this server cannot provide, a receiver that cannot decode
   * anything worth sending.
   */
  relay(id: string, listener: RelayListener, offered: Set<Mode>): RelayAnswer {
    if (!this.channels.has(id)) return { ok: false, status: 404, code: "NO_SUCH_CHANNEL", error: "nothing is playing on that channel" };
    const configured = this.store.get(id).losslessCompression;
    const effective = this.effective(id);
    const policy = effective.losslessCompression;
    if (policy.mode === "off") {
      if (configured.mode !== "off" && configured.boundary === "source") {
        return { ok: false, status: 409, code: "SOURCE_BOUNDARY_UNAVAILABLE", error: effective.reason ?? "original source bytes are unavailable" };
      }
      return { ok: false, status: 409, code: "COMPRESSION_OFF", error: effective.reason ?? "compression is off for this channel; the ordinary channel URL is unaffected" };
    }
    const codecs: Mode[] = ["stored"];
    if (offered.has("zstd")) codecs.push("zstd");
    if (offered.has("ts-zstd") && policy.tsAware) codecs.push("ts-zstd");
    if (codecs.length === 1) {
      return { ok: false, status: 406, code: "RECEIVER_UNSUPPORTED", error: "receiver does not support this format: it must decode zstd; the ordinary channel URL is unaffected" };
    }
    // A receiver that cannot undo the transform gets a variant without it.
    const variantPolicy: LosslessPolicy = { ...policy, tsAware: policy.tsAware && codecs.includes("ts-zstd") };
    const variant = variantOf(variantPolicy);
    let running = this.running.get(id);
    if (running && running.variant !== variant) {
      // One compressor per channel. A second variant would be a second
      // compressor; the first receiver's policy stands until it leaves.
      return { ok: false, status: 409, code: "VARIANT_IN_USE", error: "this channel is already being relayed under a different codec set; try again when that relay ends" };
    }
    if (!running) {
      const started = this.startEncoder(id, variantPolicy, variant);
      if (!started) return { ok: false, status: 503, code: "CHANNEL_GONE", error: "the channel ended before the relay could start" };
      running = started;
    }
    // The opening bytes and the join point, in the same tick.
    const preface = this.channels.opening(id);
    const session = running.encoder.join(listener, preface);
    return { ok: true, session, codecs, generation: running.encoder.generation, kind: this.channels.kindOf(id) ?? "" };
  }

  private startEncoder(id: string, policy: LosslessPolicy, variant: string): Running | null {
    this.generation = (this.generation + 1) % 0xffff_ffff;
    const metrics = this.metrics.get(id) ?? new ChannelMetrics();
    this.metrics.set(id, metrics);
    let record: Running | null = null;
    const encoder = new RelayEncoder({
      generation: this.generation,
      policy,
      pool: this.pool,
      metrics,
      boundary: "channel",
      onAbort: () => {
        if (record && this.running.get(id) === record) {
          this.running.delete(id);
          record.detach();
        }
      },
      onIdle: () => {
        // Nobody receiving: no compressor running. The next receiver
        // starts a new generation.
        if (record && this.running.get(id) === record) {
          this.running.delete(id);
          record.detach();
          encoder.end();
        }
      },
    });
    const detach = this.channels.listen(id, {
      write: (chunk) => encoder.write(chunk),
      end: () => encoder.end(),
      pending: () => metrics.queueBytes,
    });
    if (detach === null) return null;
    encoder.attach();
    record = { encoder, detach, variant };
    this.running.set(id, record);
    return record;
  }

  /** Start listening to another nixamp's channel as one of ours. */
  pull(id: string, from: string, key: string | null, name: string): { ok: true } | { ok: false; status: 409 | 400; error: string } {
    if (!/^https?:\/\//i.test(from)) return { ok: false, status: 400, error: "the relay address must be http or https" };
    if (this.channels.has(id) || this.incoming.has(id)) return { ok: false, status: 409, error: `channel "${id}" is already on` };
    const inbound = new Incoming(id, from, key, name, this.channels, this.options.onEvent ?? (() => undefined), (gone) => this.incoming.delete(gone));
    this.incoming.set(id, inbound);
    inbound.start();
    return { ok: true };
  }

  /** Stop an incoming relay, and the channel it feeds. */
  stopPull(id: string): boolean {
    const inbound = this.incoming.get(id);
    if (!inbound) return false;
    inbound.stop();
    return true;
  }

  /**
   * Analyse a live channel: up to `seconds` of it, or the byte limit,
   * whichever comes first, as a job. The listener is one more on the
   * channel; the channel is not touched.
   */
  analyzeChannel(id: string, seconds: number, owner: string): { job: Job; existing: boolean } | { error: string; status: 404 | 429 } {
    if (!this.channels.has(id)) return { error: "nothing is playing on that channel", status: 404 };
    const window = Math.min(SAMPLE_MAX_SECONDS, Math.max(1, Math.floor(seconds)));
    const started = this.jobs.start(`channel:${id}:${window}`, `channel ${id}`, owner, (signal, progress) => this.sampleChannel(id, window, signal, progress));
    if (started === null) return { error: "too many analyses are queued; try again later", status: 429 };
    return started;
  }

  private sampleChannel(id: string, seconds: number, signal: AbortSignal, progress: (bytes: number, ms: number) => void): Promise<Analysis> {
    return new Promise((resolve, reject) => {
      const pieces: Buffer[] = [];
      let bytes = 0;
      const began = Date.now();
      let detach: (() => void) | null = null;
      let finished = false;
      const finish = (truncated: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        detach?.();
        const info = this.channels.list().find((c) => c.id === id);
        const sample = Buffer.concat(pieces, bytes);
        analyzeSample(sample, {
          boundary: "channel",
          source: { kind: "channel", name: id },
          sampleMs: Date.now() - began,
          truncated,
          signal,
          policy: this.store.get(id).losslessCompression,
          tsAware: true,
          ...(info?.codecs ? { codecs: info.codecs } : {}),
        }).then(resolve, reject);
      };
      const timer = setTimeout(() => finish(false), seconds * 1000);
      timer.unref?.();
      signal.addEventListener("abort", () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        detach?.();
        reject(new Error("cancelled"));
      }, { once: true });
      detach = this.channels.listen(id, {
        write: (chunk) => {
          if (finished) return true;
          pieces.push(Buffer.from(chunk));
          bytes += chunk.length;
          progress(bytes, Date.now() - began);
          if (bytes >= SAMPLE_MAX_BYTES) finish(true);
          return true;
        },
        end: () => finish(false),
      });
      if (detach === null) {
        finished = true;
        clearTimeout(timer);
        reject(new Error("nothing is playing on that channel"));
      }
    });
  }

  /** Analyse a file on this machine: its first bytes, up to the sample limit. */
  analyzeFile(path: string, signal?: AbortSignal): Promise<Analysis> {
    return analyzeFile(path, {
      policy: this.store.get(STATIC_CHANNEL).losslessCompression,
      ...(this.options.ffprobe ? { ffprobe: this.options.ffprobe } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The static representation of a file. Ready when it is on disk and
   * still describes the file; building when this call started it (or
   * found it being built); failed when the last build said why; off when
   * this server keeps no cache or the static policy is off. Never a wait:
   * a film takes minutes to read, and a request is not held for that.
   */
  representation(file: string): { state: "off" } | { state: "building" } | { state: "failed"; reason: string } | { state: "ready"; path: string; entry: NonNullable<ReturnType<StaticCache["lookup"]>>["entry"] } {
    if (!this.statics) return { state: "off" };
    const policy = this.effective(STATIC_CHANNEL).losslessCompression;
    if (policy.mode === "off") return { state: "off" };
    const variant = variantOf(policy);
    const found = this.statics.lookup(file, variant);
    if (found) {
      this.failed.delete(file);
      return { state: "ready", path: found.path, entry: found.entry };
    }
    const failure = this.failed.get(file);
    if (failure !== undefined) {
      this.failed.delete(file);
      return { state: "failed", reason: failure };
    }
    void this.statics.prepare(file, policy, variant).then((result: Prepared) => {
      if (!result.ok) this.failed.set(file, result.reason);
    });
    return { state: "building" };
  }

  private readonly failed = new Map<string, string>();

  stopAll(): void {
    for (const [id, running] of [...this.running]) {
      this.running.delete(id);
      running.detach();
      running.encoder.end();
    }
    for (const inbound of [...this.incoming.values()]) inbound.stop();
    this.jobs.stopAll();
  }
}

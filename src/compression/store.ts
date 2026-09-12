/**
 * Where a server keeps its compression settings: beside the channels it
 * remembers, keyed by port for the same reason. A policy a channel does not
 * have is the default, which is off. A global switch sits above every
 * channel, so one command takes every relay down without editing any of
 * them and without forgetting what they were set to.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChannelPolicy, defaultPolicy, type HlsPackaging, normalizePolicy } from "./policy.ts";

const FILE = "compression.json";

export interface GlobalSettings {
  /** The kill switch. Off means no new compressed session anywhere on this server. */
  enabled: boolean;
  /** How HLS is packaged when a channel does not say. */
  hlsPackaging: HlsPackaging;
}

interface Saved {
  global: GlobalSettings;
  channels: Record<string, ChannelPolicy>;
}

export class PolicyStore {
  private readonly channels = new Map<string, ChannelPolicy>();
  private globalSettings: GlobalSettings = { enabled: true, hlsPackaging: "mpegts" };

  constructor(private readonly dir: string | null, private readonly port: number) {
    this.load();
  }

  get global(): GlobalSettings {
    return { ...this.globalSettings };
  }

  setGlobal(change: Partial<GlobalSettings>): GlobalSettings {
    if (typeof change.enabled === "boolean") this.globalSettings.enabled = change.enabled;
    if (change.hlsPackaging === "mpegts" || change.hlsPackaging === "fmp4") this.globalSettings.hlsPackaging = change.hlsPackaging;
    this.save();
    return this.global;
  }

  /** The policy for a channel: its own, or the default. Always a fresh copy. */
  get(id: string): ChannelPolicy {
    const own = this.channels.get(id);
    return own ? { ...own, losslessCompression: { ...own.losslessCompression } } : defaultPolicy();
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }

  /**
   * Apply a change. `expectVersion`, when given, must be the version the
   * caller last saw, or the change is refused: two operators editing the
   * same channel do not get to overwrite each other blind.
   */
  set(id: string, change: unknown, expectVersion?: number): { ok: true; policy: ChannelPolicy } | { ok: false; status: 400 | 409 | 412; errors: string[] } {
    const current = this.get(id);
    if (expectVersion !== undefined && expectVersion !== current.version) {
      return { ok: false, status: 412, errors: [`the policy is at version ${current.version}, not ${expectVersion}`] };
    }
    const normalized = normalizePolicy(change, current);
    if (!normalized.ok) return { ok: false, status: 400, errors: normalized.errors };
    const policy = { ...normalized.policy, version: current.version + 1 };
    this.channels.set(id, policy);
    this.save();
    return { ok: true, policy };
  }

  /** Every channel with a policy of its own. */
  list(): Record<string, ChannelPolicy> {
    return Object.fromEntries([...this.channels.entries()].map(([id, policy]) => [id, this.get(id)]));
  }

  private load(): void {
    if (this.dir === null) return;
    let all: Record<string, unknown>;
    try {
      all = JSON.parse(readFileSync(join(this.dir, FILE), "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const mine = all[String(this.port)];
    if (typeof mine !== "object" || mine === null) return;
    const saved = mine as Partial<Saved>;
    if (saved.global && typeof saved.global === "object") {
      if (typeof saved.global.enabled === "boolean") this.globalSettings.enabled = saved.global.enabled;
      if (saved.global.hlsPackaging === "mpegts" || saved.global.hlsPackaging === "fmp4") this.globalSettings.hlsPackaging = saved.global.hlsPackaging;
    }
    if (saved.channels && typeof saved.channels === "object") {
      for (const [id, raw] of Object.entries(saved.channels)) {
        // Checked as if it were being set now: a file edited by hand, or
        // written by a version with different limits, is not trusted whole.
        const { version, ...rest } = (raw ?? {}) as Partial<ChannelPolicy>;
        const normalized = normalizePolicy(rest, defaultPolicy());
        if (!normalized.ok) continue;
        this.channels.set(id, { ...normalized.policy, version: typeof version === "number" && version >= 0 ? Math.floor(version) : 0 });
      }
    }
  }

  private save(): void {
    if (this.dir === null) return;
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(readFileSync(join(this.dir, FILE), "utf8")) as Record<string, unknown>;
    } catch {
      // First time, or unreadable: start again rather than refuse to remember.
    }
    const saved: Saved = { global: this.globalSettings, channels: Object.fromEntries(this.channels) };
    all[String(this.port)] = saved;
    try {
      mkdirSync(this.dir, { recursive: true });
      // Whole, then renamed: a crash mid-write must not leave half a file
      // that the next start reads as "no settings".
      const tmp = join(this.dir, `${FILE}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(all, null, 2));
      renameSync(tmp, join(this.dir, FILE));
    } catch {
      // A state directory that cannot be written costs a memory, not a stream.
    }
  }
}

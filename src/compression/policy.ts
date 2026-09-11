/**
 * What an operator can set, and what a block has to achieve to be sent
 * compressed.
 *
 * Three settings that must never be confused: whether to squeeze the bytes
 * losslessly, how to package HLS, and whether to re-encode the picture.
 * Turning one on never turns another on. The first is the only one this
 * module measures; the other two are carried here so that one document
 * describes a channel, and so that the API can refuse a change that mixes
 * them up.
 */
import { type Boundary, DEFAULT_MAX_FRAME_BYTES, CEILING_FRAME_BYTES, FRAME_HEADER_BYTES } from "./envelope.ts";
import { MAX_ZSTD_LEVEL, MIN_ZSTD_LEVEL } from "./codec.ts";

export type PolicyMode = "off" | "auto" | "zstd";
export type HlsPackaging = "mpegts" | "fmp4";
/** `source` is the media as it came. Anything else re-encodes and says so. */
export type QualityProfile = "source";

export interface LosslessPolicy {
  mode: PolicyMode;
  boundary: Boundary;
  zstdLevel: number;
  /** A block is sent compressed only if it saves at least this much, both ways. */
  minSavingsPercent: number;
  minSavingsBytes: number;
  maxBlockBytes: number;
  /** From the first byte entering a block to its being flushed, at most. */
  maxHoldMs: number;
  /** After `auto` has given up on a source, how long before it tries again. */
  resampleAfterMs: number;
  /** Bytes the shared compressor may hold for a channel before it stops that relay. */
  maxChannelQueueBytes: number;
  /** Unsent bytes one relay listener may fall behind by before it is cut off. */
  maxListenerQueueBytes: number;
  /** The experimental transport-stream transform. Off unless asked for. */
  tsAware: boolean;
}

export interface ChannelPolicy {
  losslessCompression: LosslessPolicy;
  hlsPackaging: HlsPackaging;
  qualityProfile: QualityProfile;
  /** Bumped on every accepted change; a conditional update names the one it saw. */
  version: number;
}

export const DEFAULT_LOSSLESS: LosslessPolicy = {
  mode: "off",
  boundary: "channel",
  zstdLevel: 1,
  minSavingsPercent: 3,
  minSavingsBytes: 512,
  maxBlockBytes: DEFAULT_MAX_FRAME_BYTES,
  maxHoldMs: 100,
  resampleAfterMs: 60_000,
  maxChannelQueueBytes: 8 * 1024 * 1024,
  maxListenerQueueBytes: 1024 * 1024,
  tsAware: false,
};

export const DEFAULT_POLICY: ChannelPolicy = {
  losslessCompression: DEFAULT_LOSSLESS,
  hlsPackaging: "mpegts",
  qualityProfile: "source",
  version: 0,
};

/** Fresh copies, so nobody edits the defaults in place. */
export function defaultPolicy(): ChannelPolicy {
  return { ...DEFAULT_POLICY, losslessCompression: { ...DEFAULT_LOSSLESS } };
}

const RANGES: Record<Exclude<keyof LosslessPolicy, "mode" | "boundary" | "tsAware">, [number, number]> = {
  zstdLevel: [MIN_ZSTD_LEVEL, MAX_ZSTD_LEVEL],
  minSavingsPercent: [0, 100],
  minSavingsBytes: [0, CEILING_FRAME_BYTES],
  maxBlockBytes: [1024, CEILING_FRAME_BYTES],
  maxHoldMs: [1, 10_000],
  resampleAfterMs: [1000, 24 * 3600 * 1000],
  maxChannelQueueBytes: [64 * 1024, 1024 * 1024 * 1024],
  maxListenerQueueBytes: [16 * 1024, 1024 * 1024 * 1024],
};

export type Normalized = { ok: true; policy: ChannelPolicy } | { ok: false; errors: string[] };

/**
 * A change, applied over what is there, checked field by field.
 *
 * Unknown keys are errors rather than ignored: a typo that is silently
 * dropped is a setting the operator believes is on and is not. The version
 * is not settable here; the store bumps it when it accepts the result.
 */
export function normalizePolicy(input: unknown, base: ChannelPolicy): Normalized {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["a policy is an object"] };
  const change = input as Record<string, unknown>;
  const policy = { ...base, losslessCompression: { ...base.losslessCompression } };
  for (const key of Object.keys(change)) {
    if (!["losslessCompression", "hlsPackaging", "qualityProfile", "version"].includes(key)) errors.push(`unknown setting: ${key}`);
  }
  if ("hlsPackaging" in change) {
    const value = change["hlsPackaging"];
    if (value === "mpegts" || value === "fmp4") policy.hlsPackaging = value;
    else errors.push("hlsPackaging must be mpegts or fmp4");
  }
  if ("qualityProfile" in change) {
    if (change["qualityProfile"] === "source") policy.qualityProfile = "source";
    else errors.push("qualityProfile: only source is available; lower-bitrate profiles are a separate, explicit setting that this version does not ship");
  }
  if ("losslessCompression" in change) {
    const lc = change["losslessCompression"];
    if (typeof lc !== "object" || lc === null || Array.isArray(lc)) {
      errors.push("losslessCompression is an object");
    } else {
      const fields = lc as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (key === "mode") {
          if (value === "off" || value === "auto" || value === "zstd") policy.losslessCompression.mode = value;
          else errors.push("losslessCompression.mode must be off, auto or zstd");
        } else if (key === "boundary") {
          if (value === "channel" || value === "source") policy.losslessCompression.boundary = value;
          else errors.push("losslessCompression.boundary must be channel or source");
        } else if (key === "tsAware") {
          if (typeof value === "boolean") policy.losslessCompression.tsAware = value;
          else errors.push("losslessCompression.tsAware must be true or false");
        } else if (key in RANGES) {
          const [low, high] = RANGES[key as keyof typeof RANGES];
          if (typeof value === "number" && Number.isInteger(value) && value >= low && value <= high) {
            (policy.losslessCompression as unknown as Record<string, number>)[key] = value;
          } else {
            errors.push(`losslessCompression.${key} must be an integer from ${low} to ${high}`);
          }
        } else {
          errors.push(`unknown setting: losslessCompression.${key}`);
        }
      }
    }
  }
  if (policy.losslessCompression.minSavingsBytes >= policy.losslessCompression.maxBlockBytes) {
    errors.push("losslessCompression.minSavingsBytes must be smaller than maxBlockBytes, or nothing can ever qualify");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy };
}

/**
 * Whether a compressed block earns its place.
 *
 * Both representations carry the same frame header, so the comparison of
 * complete representations reduces to the payloads: the saving is what the
 * original would have cost stored, less what the encoding costs. Both
 * thresholds must hold. A tiny block can meet the percentage and still not
 * be worth the decode; a huge one can save half a kilobyte and still be
 * nothing.
 */
export function eligible(originalLength: number, encodedLength: number, policy: Pick<LosslessPolicy, "minSavingsPercent" | "minSavingsBytes">): boolean {
  if (originalLength <= 0) return false;
  const saved = originalLength - encodedLength;
  if (saved < policy.minSavingsBytes) return false;
  return (saved * 100) / originalLength >= policy.minSavingsPercent;
}

/** What a block costs on the wire in each form, header included. */
export function wireBytes(payloadLength: number): number {
  return FRAME_HEADER_BYTES + payloadLength;
}

/** Whether two policies would produce the same bytes for the same input. */
export function variantOf(policy: LosslessPolicy): string {
  return `${policy.mode}:${policy.boundary}:${policy.zstdLevel}:${policy.tsAware ? "ts" : "plain"}:${policy.maxBlockBytes}`;
}

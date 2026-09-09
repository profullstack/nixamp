/**
 * Signing in on one screen for a session on another.
 *
 * This is the device authorization grant (RFC 8628), which is the flow a
 * television has been using to sign you in for years: the terminal shows a
 * short code, you open a page on whatever device has a keyboard and a browser,
 * you type the code, and the terminal -- which was polling all along -- is
 * signed in.
 *
 * It is the right shape for nixamp for the same reason a magic link is the
 * wrong one: the thing being signed in has no browser to hand off to, and may
 * not be the device where you read your mail. It also means the CLI never sees
 * a password or a provider token, only the session it ends up with.
 *
 * Grants are held in memory. They live ten minutes, they are worth nothing
 * after they are redeemed, and a restart costing somebody a retyped code is a
 * better trade than a table to migrate.
 */
import { randomBytes } from "node:crypto";

/** Long enough to walk to another room, short enough that a stolen code is stale. */
export const GRANT_TTL_MS = 600_000;

/** What the CLI is told to wait between polls, in seconds. */
export const POLL_INTERVAL_SECONDS = 5;

/**
 * Not a timestamp, so the first poll is never mistaken for a fast one. Zero
 * would be, and a clock that starts at zero is exactly what a test has.
 */
const NEVER_POLLED = -1;

/**
 * No vowels, so the generator cannot produce a word; no 0/O or 1/I, so nobody
 * mistypes one for the other. This is the alphabet RFC 8628 suggests.
 */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export interface Grant {
  deviceCode: string;
  userCode: string;
  createdAt: number;
  expiresAt: number;
  lastPolledAt: number;
  /** Set once somebody approved it in a browser. */
  session: { token: string; email: string } | null;
  denied: boolean;
}

export type PollStatus =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "ok"; token: string; email: string };

function randomFrom(alphabet: string, length: number, bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[(bytes[index] as number) % alphabet.length];
  }
  return out;
}

/** `WXYZ-4RTB`. Hyphenated because it is read aloud and typed by hand. */
export function makeUserCode(random: (size: number) => Uint8Array): string {
  const bytes = random(8);
  return `${randomFrom(ALPHABET, 4, bytes.subarray(0, 4))}-${randomFrom(ALPHABET, 4, bytes.subarray(4, 8))}`;
}

/** Accept what a person typed however they typed it: lower case, no hyphen. */
export function normalizeUserCode(value: unknown): string {
  if (typeof value !== "string") return "";
  const bare = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (bare.length !== 8) return "";
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

export interface DeviceOptions {
  now?: () => number;
  random?: (size: number) => Uint8Array;
  /** How often a waiting terminal is told to ask. Five seconds is RFC 8628's. */
  intervalSeconds?: number;
}

export class DeviceGrants {
  private readonly byDevice = new Map<string, Grant>();
  private readonly byUser = new Map<string, Grant>();
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  /** Told to the terminal, and enforced here: the two must be the same number. */
  readonly interval: number;

  constructor(options: DeviceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((size: number) => randomBytes(size));
    this.interval = Math.max(1, options.intervalSeconds ?? POLL_INTERVAL_SECONDS);
  }

  start(): Grant {
    this.sweep();
    const at = this.now();
    // A user code can collide -- there are only 20^8 of them and they are
    // short-lived -- so it is retried rather than handed out twice.
    let userCode = makeUserCode(this.random);
    for (let tries = 0; this.byUser.has(userCode) && tries < 10; tries += 1) {
      userCode = makeUserCode(this.random);
    }
    const grant: Grant = {
      deviceCode: Buffer.from(this.random(32)).toString("base64url"),
      userCode,
      createdAt: at,
      expiresAt: at + GRANT_TTL_MS,
      lastPolledAt: NEVER_POLLED,
      session: null,
      denied: false,
    };
    this.byDevice.set(grant.deviceCode, grant);
    this.byUser.set(grant.userCode, grant);
    return grant;
  }

  /** The grant behind a code somebody typed, if it is still worth anything. */
  find(userCode: string): Grant | null {
    const grant = this.byUser.get(normalizeUserCode(userCode));
    if (!grant || grant.expiresAt <= this.now() || grant.session !== null || grant.denied) return null;
    return grant;
  }

  approve(userCode: string, session: { token: string; email: string }): boolean {
    const grant = this.find(userCode);
    if (grant === null) return false;
    grant.session = session;
    return true;
  }

  deny(userCode: string): boolean {
    const grant = this.find(userCode);
    if (grant === null) return false;
    grant.denied = true;
    return true;
  }

  /**
   * What the waiting terminal is told. A grant is forgotten the moment it
   * answers with a session, so the same device code cannot be redeemed twice.
   */
  poll(deviceCode: string): PollStatus {
    const at = this.now();
    const grant = this.byDevice.get(deviceCode);
    if (!grant || grant.expiresAt <= at) {
      this.forget(grant);
      return { status: "expired" };
    }
    // Polling faster than it was told to is answered with slow_down rather
    // than an answer, which is what RFC 8628 asks of a server.
    if (grant.lastPolledAt !== NEVER_POLLED && at - grant.lastPolledAt < this.interval * 1000 - 250) {
      return { status: "slow_down" };
    }
    grant.lastPolledAt = at;
    if (grant.denied) {
      this.forget(grant);
      return { status: "denied" };
    }
    if (grant.session === null) return { status: "pending" };
    this.forget(grant);
    return { status: "ok", token: grant.session.token, email: grant.session.email };
  }

  private forget(grant: Grant | undefined): void {
    if (!grant) return;
    this.byDevice.delete(grant.deviceCode);
    this.byUser.delete(grant.userCode);
  }

  sweep(): void {
    const at = this.now();
    for (const grant of this.byDevice.values()) {
      if (grant.expiresAt <= at) this.forget(grant);
    }
  }

  get size(): number {
    return this.byDevice.size;
  }

  /** The grants nobody has answered yet, newest last. */
  pending(): Grant[] {
    const at = this.now();
    return [...this.byDevice.values()].filter(
      (grant) => grant.expiresAt > at && grant.session === null && !grant.denied,
    );
  }
}

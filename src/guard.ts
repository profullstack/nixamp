/**
 * Saying no to somebody who is asking too often.
 *
 * There was nothing here at all: no throttle, no lockout, no 429. Against the
 * share key that is survivable -- it is 128 random bits and nobody guesses one
 * -- but the sign-in endpoints take a password, and a password with an eight
 * character floor and no composition rules is guessable at a few hundred
 * attempts a second by anyone with a word list.
 *
 * A fixed window rather than a token bucket, because the thing being counted
 * is failed attempts by one caller and the useful question is "how many in the
 * last few minutes", which a window answers exactly and a bucket only
 * approximates. Windows are kept in memory: a limiter that outlives a restart
 * would want a table, and a restart is not how somebody gets past this.
 *
 * Deliberately free of anything nixamp: it takes a name and an address and
 * answers yes or no, so it can be lifted into a package unchanged.
 */

export interface Limit {
  /** How many are allowed in one window. */
  allowed: number;
  /** How long the window is, in milliseconds. */
  windowMs: number;
}

export interface Verdict {
  /** Whether to go ahead. */
  ok: boolean;
  /** What is left in this window, after this call. */
  left: number;
  /** Seconds until the window rolls, for Retry-After. */
  retryAfter: number;
}

interface Window {
  count: number;
  until: number;
}

/** Nothing here is worth more memory than this; the oldest windows go first. */
const MAX_TRACKED = 10_000;

export class Guard {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Count one attempt against `key`, and say whether it may proceed.
   *
   * The count rises whether or not the attempt succeeds; callers who only want
   * to punish failures should call `forget` on success, which is what makes a
   * correct password cost nothing.
   */
  check(key: string, limit: Limit): Verdict {
    const at = this.now();
    this.sweep(at);

    const found = this.windows.get(key);
    const window = found && found.until > at ? found : { count: 0, until: at + limit.windowMs };
    window.count += 1;
    this.windows.set(key, window);

    const retryAfter = Math.max(1, Math.ceil((window.until - at) / 1000));
    if (window.count > limit.allowed) return { ok: false, left: 0, retryAfter };
    return { ok: true, left: limit.allowed - window.count, retryAfter };
  }

  /** A success wipes the slate, so ordinary use never approaches a limit. */
  forget(key: string): void {
    this.windows.delete(key);
  }

  private sweep(at: number): void {
    if (this.windows.size < MAX_TRACKED) return;
    for (const [key, window] of this.windows) {
      if (window.until <= at) this.windows.delete(key);
    }
    // Still full of live windows: somebody is spreading attempts across many
    // keys. Drop the oldest half rather than grow without limit -- forgetting
    // is the safe direction, since the alternative is running out of memory.
    if (this.windows.size >= MAX_TRACKED) {
      const half = Math.floor(this.windows.size / 2);
      let dropped = 0;
      for (const key of this.windows.keys()) {
        this.windows.delete(key);
        if (++dropped >= half) break;
      }
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Who is asking, for counting purposes.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * used where one is trusted. It is only trusted when told to be: anyone can
 * send `x-forwarded-for`, and believing it from a direct caller would let them
 * pick a fresh identity per request and never hit a limit at all.
 */
export function callerOf(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  behindProxy: boolean,
): string {
  if (behindProxy) {
    const raw = headers["x-forwarded-for"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    // The leftmost entry is the original client; the rest are proxies.
    const first = header?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? "unknown";
}

/**
 * Signing in. Ten wrong answers in fifteen minutes is far more than a person
 * mistypes and far less than a word list needs.
 */
export const SIGN_IN_LIMIT: Limit = { allowed: 10, windowMs: 15 * 60_000 };

/**
 * A wrong share key. Higher, because a browser with a stale link retries by
 * itself, and the key is not guessable anyway -- this is about noise and logs
 * rather than about the key falling.
 */
export const BAD_KEY_LIMIT: Limit = { allowed: 60, windowMs: 60_000 };

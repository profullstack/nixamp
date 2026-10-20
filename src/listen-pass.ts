/**
 * The listen pass: what a signed-in nixamp.com listener carries to a station
 * on another server, so its breaks go quiet for them.
 *
 * Breaks are in the stream (playlist-input.ts), one stream for every
 * listener, so a station cannot leave a spot out for one person: it can only
 * send that person silence while everybody else hears it. To do even that it
 * has to know who is signed in, and a station on server1 holds no accounts.
 * nixamp.com does, so nixamp.com signs a short pass for a signed-in account
 * (GET /api/v1/me/pass, credentialed from any *.nixamp.com page) and the
 * station asks nixamp.com whether a pass is good (GET
 * /api/v1/listen-pass/check), remembering the answer.
 *
 * A pass is `v1.<expiry seconds>.<signature>` and nothing else: no account
 * id, because a station has no use for one and a link gets pasted around.
 * Anybody holding a fresh pass hears no breaks until it expires, which is the
 * same thing a signed-in listener sharing their screen would give away.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** How long a pass is good for. The page asks again on every load. */
export const PASS_TTL_SECONDS = 24 * 60 * 60;

/** Where a pass rides on a stream link (an audio element sends no headers). */
export const PASS_PARAM = "pass";

/** The signing secret, or "" where passes cannot be signed (every server but nixamp.com). */
export function listenPassSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env["NIXAMP_LISTEN_PASS_SECRET"]) return env["NIXAMP_LISTEN_PASS_SECRET"];
  // Derived, so nixamp.com needs no new variable: a pass is not a session.
  const jwt = env["NIXAMP_JWT_SECRET"] ?? "";
  return jwt ? createHash("sha256").update(`listen-pass:${jwt}`).digest("hex") : "";
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
}

export function mintListenPass(secret: string, nowMs = Date.now(), ttlSeconds = PASS_TTL_SECONDS): { pass: string; expires: number } {
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const body = `v1.${expires}`;
  return { pass: `${body}.${sign(secret, body)}`, expires };
}

/** The expiry of a good pass in seconds, or 0. */
export function checkListenPass(secret: string, pass: string, nowMs = Date.now()): number {
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(pass);
  if (!secret || !match) return 0;
  const expires = Number(match[1]);
  if (expires * 1000 <= nowMs) return 0;
  const want = Buffer.from(sign(secret, `v1.${expires}`));
  const got = Buffer.from(match[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? expires : 0;
}

export interface VerifierOptions {
  /** nixamp.com, which signed the pass. */
  site: string;
  /** Set on nixamp.com itself, which checks its own passes without asking. */
  secret?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

/** How long a refused pass is remembered, so a bad one cannot make us ask nixamp.com per request. */
const REFUSED_MS = 5 * 60 * 1000;
const MAX_REMEMBERED = 5_000;

/** Whether a pass is good, asked of nixamp.com once and then remembered until it expires. */
export class ListenPassVerifier {
  /** pass -> whether it is good, and until when that answer stands. */
  private readonly known = new Map<string, { good: boolean; until: number }>();

  constructor(private readonly options: VerifierOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async good(pass: string): Promise<boolean> {
    if (!/^v1\.\d{1,12}\.[A-Za-z0-9_-]{32}$/.test(pass)) return false;
    if (this.options.secret) return checkListenPass(this.options.secret, pass, this.now()) > 0;
    const seen = this.known.get(pass);
    if (seen && seen.until > this.now()) return seen.good;
    let expires = 0;
    try {
      const answer = await (this.options.fetcher ?? fetch)(
        `${this.options.site.replace(/\/+$/, "")}/api/v1/listen-pass/check?${PASS_PARAM}=${encodeURIComponent(pass)}`,
        { signal: AbortSignal.timeout(2_000) },
      );
      // nixamp.com down is not a refusal: nothing is remembered, and this
      // listener hears the break this time.
      if (answer.status >= 500) return false;
      const body = (await answer.json().catch(() => ({}))) as { ok?: unknown; expires?: unknown };
      expires = body.ok === true && typeof body.expires === "number" ? body.expires : 0;
    } catch {
      return false;
    }
    if (this.known.size >= MAX_REMEMBERED) this.known.clear();
    const good = expires * 1000 > this.now();
    this.known.set(pass, { good, until: good ? expires * 1000 : this.now() + REFUSED_MS });
    return good;
  }
}

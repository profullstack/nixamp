/**
 * Publishing to the directory, and asking first.
 *
 * Listing a stream tells the world an address it can reach you on, so it is
 * never done silently. The prompt defaults to yes; a terminal that cannot ask
 * defaults to no, because "there was nobody to ask" is not consent.
 */
import { createInterface } from "node:readline/promises";
import { DEFAULT_DIRECTORY, HEARTBEAT_MS, type Listing } from "./directory.ts";

export interface PublishTarget {
  directory: string;
  name: string;
  /** The listen link: what a stranger opens. Never the control key. */
  url: string;
  /**
   * The same stream as bytes, for a listener that cannot hold a cookie.
   *
   * The phone line plays this address into a call. The listen link cannot be
   * played: it is a redirect that sets a cookie, and Telnyx fetching it once
   * gets a 401 in JSON, which is a caller hearing nothing.
   */
  audio?: string;
  /**
   * How many tracks there are, asked at every heartbeat rather than once.
   *
   * Taken as a number, it was read before the library had finished loading --
   * the port opens first now -- so a server with five thousand tracks
   * advertised nought of them for as long as it stayed up.
   */
  tracks: () => number;
  nowPlaying: () => string;
  /**
   * The account this stream belongs to, from `nixamp login`.
   *
   * The directory used to take anybody's word for a listing. It cannot any
   * more: a listing now carries a phone code people dial and minutes somebody
   * pays for, so it has to be attributable. Reading the directory is still
   * open to everyone -- it is announcing that needs a name behind it.
   */
  token?: string;
  /**
   * Called with whatever configuration the directory sent back. This is how
   * nixamp.com turns x402 on and off for a server without it restarting.
   */
  onConfig?: (config: unknown) => void;
  /** Called when the directory refused us for want of an account. */
  onRefused?: () => void;
}

/**
 * Ask, with yes as the default. Returns false without asking when there is no
 * terminal on the other end, which is the case for the daemon and for CI.
 */
export async function confirm(question: string, tty = process.stdin.isTTY === true): Promise<boolean> {
  if (!tty) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Announce, then keep announcing. The directory forgets an entry that stops
 * renewing, so stopping the heartbeat is how a stream leaves the list even if
 * the process dies without saying goodbye.
 */
export class Publisher {
  private id: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Whether we have already said that the directory wants an account. */
  private refused = false;

  constructor(
    private readonly target: PublishTarget,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async start(): Promise<Listing | null> {
    const first = await this.announce();
    this.timer = setInterval(() => void this.announce(), HEARTBEAT_MS);
    this.timer.unref?.();
    return first;
  }

  async announce(): Promise<Listing | null> {
    try {
      const response = await this.fetcher(`${this.target.directory}/api/directory`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.target.token ? { authorization: `Bearer ${this.target.token}` } : {}),
        },
        body: JSON.stringify({
          ...(this.id ? { id: this.id } : {}),
          name: this.target.name,
          url: this.target.url,
          ...(this.target.audio ? { audio: this.target.audio } : {}),
          tracks: this.target.tracks(),
          nowPlaying: this.target.nowPlaying(),
        }),
      });
      if (!response.ok) {
        // Worth telling the operator about exactly once. A heartbeat that is
        // refused every 90 seconds should not print every 90 seconds, and
        // "could not reach the directory" would be the wrong thing to say
        // about a directory that answered perfectly clearly.
        if (response.status === 401 && !this.refused) {
          this.refused = true;
          this.target.onRefused?.();
        }
        return null;
      }
      const listing = (await response.json()) as Listing & { config?: unknown };
      this.id = listing.id;
      if (listing.config !== undefined) this.target.onConfig?.(listing.config);
      return listing;
    } catch {
      // The directory being down is not a reason for a player to stop playing.
      return null;
    }
  }

  /** Leave the list now rather than waiting to be forgotten. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.id === null) return;
    try {
      await this.fetcher(`${this.target.directory}/api/directory?id=${encodeURIComponent(this.id)}`, {
        method: "DELETE",
        ...(this.target.token ? { headers: { authorization: `Bearer ${this.target.token}` } } : {}),
      });
    } catch {
      // It expires on its own within the TTL, which is the point of the TTL.
    }
    this.id = null;
  }
}

export { DEFAULT_DIRECTORY };

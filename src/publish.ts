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
  tracks: number;
  nowPlaying: () => string;
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(this.id ? { id: this.id } : {}),
          name: this.target.name,
          url: this.target.url,
          tracks: this.target.tracks,
          nowPlaying: this.target.nowPlaying(),
        }),
      });
      if (!response.ok) return null;
      const listing = (await response.json()) as Listing;
      this.id = listing.id;
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
      });
    } catch {
      // It expires on its own within the TTL, which is the point of the TTL.
    }
    this.id = null;
  }
}

export { DEFAULT_DIRECTORY };

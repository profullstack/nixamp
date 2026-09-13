/**
 * Captions in the page: the parts of it that are arithmetic.
 *
 * The server stamps every line with the wall-clock moment its sound was
 * heard at the live edge. This page's sound trails that edge: by the
 * backlog it was handed when it joined, and by a little decoding and
 * buffering after that. So a line is held until the page's sound has got
 * to where the line's sound was, and the words land close to the voice
 * rather than seconds ahead of it. Close, not exact: the lag is an
 * estimate, and a line is a five-second window rather than a word.
 */

export const CAPTIONS_KEY = "nixamp.captions";

export interface Caption {
  channel: string;
  /** Wall clock, ms: when the sound this line is from began and ended. */
  at: number;
  until: number;
  text: string;
}

/**
 * How far behind the live edge this page's sound is, in ms. The backlog
 * the server hands a newcomer, plus a second and a half of decode and
 * buffer. HLS plays a few short segments behind however small the backlog
 * was, so it is never taken to be closer than six seconds.
 */
export function lagMs(backlogSeconds: number, hls: boolean): number {
  const backlog = hls ? Math.max(backlogSeconds, 6) : Math.max(0, backlogSeconds);
  return backlog * 1000 + 1500;
}

/** The held lines split into the ones whose sound this page has reached, oldest first, and the rest. */
export function due(held: Caption[], now: number, lag: number): { ready: Caption[]; still: Caption[] } {
  const ready: Caption[] = [];
  const still: Caption[] = [];
  for (const line of held) (line.at <= now - lag ? ready : still).push(line);
  ready.sort((a, b) => a.at - b.at);
  return { ready, still };
}

/**
 * The line on the picture right now: the latest one whose sound is still
 * playing here, kept up for a grace period after it ends so a short line
 * is not a flash. Null when nothing is being said.
 */
export function showing(shown: Caption[], now: number, lag: number, graceMs = 1500): Caption | null {
  const heard = now - lag;
  for (let i = shown.length - 1; i >= 0; i--) {
    const line = shown[i] as Caption;
    if (line.at <= heard && heard <= line.until + graceMs) return line;
    if (line.until + graceMs < heard) break;
  }
  return null;
}

/** Whether this device wants captions: yes unless it said no. */
export function captionsWanted(read: (key: string) => string | null): boolean {
  try {
    return read(CAPTIONS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** A line's time, as the list shows it. */
export function whenLabel(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

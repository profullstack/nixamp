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
/** The language this device wants its captions in; "" is as spoken. */
export const CAPTIONS_LANGUAGE_KEY = "nixamp.captions.native-v2.language";

export interface Caption {
  channel: string;
  /** Wall clock, ms: when the sound this line is from began and ended. */
  at: number;
  until: number;
  text: string;
  /** The language of the words: as heard, or as translated into. */
  language?: string;
  /** What was heard, when this line is a translation of it. */
  original?: string;
  sourceLanguage?: string;
  voiceProfile?: "lower" | "higher" | "unknown";
  speaker?: string;
}

/**
 * Translation targets served by nixamp.com. Direct pairs are preferred;
 * a pair without its own model may use an English pivot. "" always preserves
 * the detected source language without running translation.
 */
export const LANGUAGE_CHOICES: { code: string; label: string }[] = [
  { code: "", label: "Original (auto-detect)" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "sv", label: "Svenska" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "da", label: "Dansk" },
  { code: "fi", label: "Suomi" },
  { code: "ru", label: "Русский" },
  { code: "uk", label: "Українська" },
  { code: "cs", label: "Čeština" },
  { code: "hu", label: "Magyar" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "id", label: "Bahasa Indonesia" },
];

/** The language this device asked for, if it is one on offer; "" otherwise. */
export function captionsLanguage(read: (key: string) => string | null): string {
  try {
    const code = (read(CAPTIONS_LANGUAGE_KEY) ?? "").trim().toLowerCase();
    return LANGUAGE_CHOICES.some((one) => one.code === code) ? code : "";
  } catch {
    return "";
  }
}

/** A translated line is marked with its language, so a reader knows it is not what was said. */
export function captionLabel(line: Caption): string {
  return line.original !== undefined && line.language ? `[${line.language}] ` : "";
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

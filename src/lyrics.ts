/**
 * The words of the song on the air, for a station's page.
 *
 * Two places they come from, in this order:
 *  1. the file itself: an ID3 USLT frame (ffprobe calls it `lyrics-eng`, or
 *     `lyrics-<description>-<lang>`), a Vorbis/APE `LYRICS` or
 *     `UNSYNCEDLYRICS` tag. Suno writes the words it sang into USLT, so our
 *     own catalog carries them already;
 *  2. nichedb.dev's lyrics, asked by artist and title, which is where a file
 *     without the tag gets them (and where ours are published back to:
 *     lyrics-publish.ts).
 * Each answer is kept: the tags with the file (by size and time, TagReader),
 * nichedb's for ten minutes, misses included, so a station of tracks nobody
 * has words for asks once per track per ten minutes and never waits long.
 */
import { readFileSync } from "node:fs";

export interface Lyrics {
  title: string;
  artist: string;
  text: string;
  /** "embedded" (the file's own tag) or "nichedb" (or what nichedb said its source was). */
  source: string;
  /** ISO 639-1 where we know the mapping, else what the tag said; "" when unsaid. */
  language: string;
  /** When a .lrc beside the file says when each line (and word) is sung: seconds from the file's start. */
  synced?: SyncedLine[];
}

export interface SyncedLine {
  start: number;
  end: number;
  text: string;
  words: Array<{ start: number; end: number; text: string }>;
}

const STAMP = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/;

function seconds(stamp: string): number {
  const match = STAMP.exec(stamp);
  if (!match) return Number.NaN;
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return Number(match[1]) * 60 + Number(match[2]) + fraction;
}

function stamp(at: number): string {
  const whole = Math.max(0, at);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

/**
 * Enhanced LRC: `[mm:ss.xx]` before each sung line, and `<mm:ss.xx>` before
 * each word when the words are timed. Tags like `[ar:...]` and lines without a
 * time are skipped. Ends are the next start (the last line runs 4 s).
 */
export function parseLrc(text: string): SyncedLine[] {
  const lines: SyncedLine[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const head = /^\[([^\]]+)\](.*)$/.exec(raw.trim());
    if (!head) continue;
    const start = seconds(head[1]!);
    if (!Number.isFinite(start)) continue;
    const body = head[2]!;
    const words: SyncedLine["words"] = [];
    const parts = body.split(/<([^>]+)>/);
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i += 2) {
        const at = seconds(parts[i]!);
        const word = (parts[i + 1] ?? "").trim();
        if (Number.isFinite(at) && word) words.push({ start: at, end: at, text: word });
      }
    }
    const plain = (parts.length > 1 ? words.map((one) => one.text).join(" ") : body).trim();
    if (!plain) continue;
    lines.push({ start, end: start, text: plain, words });
  }
  lines.sort((a, b) => a.start - b.start);
  lines.forEach((line, i) => {
    line.end = lines[i + 1]?.start ?? line.start + 4;
    line.words.forEach((word, j) => { word.end = line.words[j + 1]?.start ?? line.end; });
  });
  return lines;
}

export function formatLrc(lines: SyncedLine[], head: { title?: string; artist?: string; album?: string } = {}): string {
  const tags = [head.artist ? `[ar:${head.artist}]` : "", head.title ? `[ti:${head.title}]` : "", head.album ? `[al:${head.album}]` : ""].filter(Boolean);
  const body = lines.map((line) => `[${stamp(line.start)}]${line.words.length ? line.words.map((word) => ` <${stamp(word.start)}>${word.text}`).join("") : line.text}`);
  return `${[...tags, ...body].join("\n")}\n`;
}

/** The .lrc that sits beside a file (same name, .lrc), or "". */
export function lrcBeside(file: string): string {
  return file.replace(/\.[^./]+$/, "") + ".lrc";
}

export const NICHEDB_LYRICS = "https://nichedb.dev";
const MAX_TEXT = 20_000;

/** ID3 / ISO 639-2 codes for the languages we are likely to meet, as 639-1. */
const LANGS: Record<string, string> = {
  eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", spa: "es", ita: "it", por: "pt", nld: "nl", dut: "nl",
  swe: "sv", nor: "no", nob: "nb", dan: "da", isl: "is", ice: "is", fin: "fi", jpn: "ja", kor: "ko", zho: "zh",
  chi: "zh", rus: "ru", pol: "pl", ukr: "uk", tur: "tr", ara: "ar", heb: "he", hin: "hi", ces: "cs", cze: "cs",
  ell: "el", gre: "el", hun: "hu", ron: "ro", rum: "ro", lat: "la", gle: "ga", cym: "cy", wel: "cy",
};

function language(code: string): string {
  const lower = code.toLowerCase();
  if (lower === "" || lower === "xxx" || lower === "und" || lower === "zxx") return "";
  return LANGS[lower] ?? lower;
}

/** Text as it may be shown: newlines kept, control characters gone, trimmed, capped. */
export function cleanLyrics(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}

/** The words a file's own tags carry (lower-cased names, as TagReader gives them), or null. */
export function lyricsFromTags(tags: Record<string, string>): { text: string; language: string } | null {
  let best: { text: string; language: string } | null = null;
  for (const [name, value] of Object.entries(tags)) {
    let lang = "";
    if (name === "lyrics" || name === "unsyncedlyrics" || name === "unsynced lyrics" || name === "unsynced_lyrics" || name === "uslt") {
      lang = "";
    } else if (name.startsWith("lyrics-") || name.startsWith("lyrics_")) {
      // lyrics-eng, or lyrics-<description>-eng: the language is the last part.
      const last = name.slice("lyrics-".length).split(/[-_]/).pop() ?? "";
      lang = /^[a-z]{3}$/.test(last) ? last : "";
    } else {
      continue;
    }
    const text = cleanLyrics(value);
    if (text === "") continue;
    // The longest wins: a short descriptor-only frame is not the song.
    if (!best || text.length > best.text.length) best = { text, language: language(lang) };
  }
  return best;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface LyricsFinderOptions {
  /** The file's tags (TagReader.read). */
  tags: (file: string) => Promise<Record<string, string>>;
  /** What the library knows when the file has no tag for it. */
  known?: (file: string) => { title: string; artist: string } | null;
  /** nichedb's address; NIXAMP_LYRICS_URL, else nichedb.dev. "" turns the lookup off. */
  base?: string;
  fetcher?: Fetcher;
  /** How long nichedb's answer (or its silence) is kept. */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** Finds a file's words, from its tags, else from nichedb. */
export class LyricsFinder {
  private remote = new Map<string, { at: number; lyrics: Lyrics | null }>();
  private asking = new Map<string, Promise<Lyrics | null>>();
  private readonly base: string;
  private readonly fetcher: Fetcher;
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly now: () => number;

  constructor(private readonly options: LyricsFinderOptions) {
    this.base = (options.base ?? process.env["NIXAMP_LYRICS_URL"] ?? NICHEDB_LYRICS).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.ttl = options.ttlMs ?? 10 * 60_000;
    this.timeout = options.timeoutMs ?? 4_000;
    this.now = options.now ?? Date.now;
  }

  /** The file's words, or null. Never throws; never waits on nichedb longer than the timeout. */
  async find(file: string): Promise<Lyrics | null> {
    let tags: Record<string, string> = {};
    try { tags = await this.options.tags(file); } catch { tags = {}; }
    const known = this.options.known?.(file) ?? null;
    const title = tags["title"] || known?.title || "";
    const artist = tags["artist"] || tags["album_artist"] || known?.artist || "";
    const own = lyricsFromTags(tags);
    // Timed words beside the file (karaoke): the page follows along with them.
    let synced: SyncedLine[] = [];
    try { synced = parseLrc(readFileSync(lrcBeside(file), "utf8")); } catch { synced = []; }
    if (own) return { title, artist, text: own.text, source: "embedded", language: own.language, ...(synced.length ? { synced } : {}) };
    if (synced.length) return { title, artist, text: synced.map((line) => line.text).join("\n"), source: "embedded", language: "", synced };
    if (!title || !artist || !this.base) return null;
    return this.lookup(artist, title);
  }

  /** What nichedb has for this artist and title, kept for ten minutes. */
  lookup(artist: string, title: string): Promise<Lyrics | null> {
    const key = `${artist.toLowerCase()}\n${title.toLowerCase()}`;
    const hit = this.remote.get(key);
    if (hit && this.now() - hit.at < this.ttl) return Promise.resolve(hit.lyrics);
    const pending = this.asking.get(key);
    if (pending) return pending;
    const asked = this.ask(artist, title).then((lyrics) => {
      if (this.remote.size > 2000) this.remote.clear();
      this.remote.set(key, { at: this.now(), lyrics });
      return lyrics;
    }).finally(() => this.asking.delete(key));
    this.asking.set(key, asked);
    return asked;
  }

  private async ask(artist: string, title: string): Promise<Lyrics | null> {
    const url = `${this.base}/api/v1/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
    try {
      const response = await this.fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeout) });
      if (!response.ok) return null;
      const body = await response.json() as { lyrics?: Record<string, unknown> };
      const found = body?.lyrics;
      const text = typeof found?.["text"] === "string" ? cleanLyrics(found["text"]) : "";
      if (!text) return null;
      const string = (name: string): string => (typeof found?.[name] === "string" ? String(found[name]) : "");
      return {
        title: string("title") || title,
        artist: string("artist") || artist,
        text,
        source: "nichedb",
        language: string("language"),
      };
    } catch {
      return null;
    }
  }
}

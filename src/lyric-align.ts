/**
 * A song's words timed to its recording without ElevenLabs: nixamp.com's ear
 * (Whisper, POST /api/v1/speech/transcribe) hears the song a minute at a time
 * and says when each phrase was sung; the known lyrics are then laid over
 * what it heard, word by word, so every lyric word gets a time.
 *
 * Whisper mishears sung words (more so under guitars), so the heard text is
 * only a guide: a lyric word matched to a heard one takes its time, and the
 * words between two matches share the time between them. A song where too
 * few words matched is refused rather than given a karaoke that drifts.
 */
import type { TimedWord } from "./ai-label.ts";
import type { Session } from "./session.ts";
import { RATE, type Segment } from "./speech.ts";
import { askToHear, wavOfPcm, windowsOf, type Window } from "./transcribe.ts";
import { isQuiet } from "./captions.ts";

/** A heard word, its time spread from its phrase by its length. */
export interface HeardWord { word: string; start: number; end: number }

/** What a word is for matching: lower case, letters and digits only. */
export function wordKey(word: string): string {
  return word.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** Each phrase's words, its time shared out by how long each word is. */
export function heardWords(segments: Segment[]): HeardWord[] {
  const out: HeardWord[] = [];
  for (const segment of segments) {
    const words = segment.text.split(/\s+/).map((one) => ({ text: one, key: wordKey(one) })).filter((one) => one.key !== "");
    if (words.length === 0 || !(segment.end > segment.start)) continue;
    const weight = words.reduce((sum, one) => sum + one.key.length + 1, 0);
    let at = segment.start;
    for (const one of words) {
      const span = ((segment.end - segment.start) * (one.key.length + 1)) / weight;
      out.push({ word: one.key, start: at, end: at + span });
      at += span;
    }
  }
  return out;
}

/** Whether a sung word and a heard one are the same word, allowing Whisper one slip in a longer word. */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.slice(0, 4) === b.slice(0, 4) && Math.abs(a.length - b.length) <= 2) return true;
  return Math.abs(a.length - b.length) <= 1 && slips(a, b) <= 1;
}

function slips(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** How long a word is sung, roughly, where nothing was heard to say. */
const WORD_SECONDS = 0.35;

/**
 * One time per lyric word, in order: matched words (the longest common run
 * of words, in order) keep the time they were heard at, the rest share out
 * the time between their matched neighbours. Null when fewer than a fifth
 * of the words (and at least three) matched.
 */
export function alignWords(lyrics: string[], heard: HeardWord[]): TimedWord[] | null {
  const n = lyrics.length;
  const m = heard.length;
  if (n === 0 || m === 0) return null;
  const keys = lyrics.map(wordKey);
  // Longest common subsequence, as a table of lengths from the end.
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = keys[i] !== "" && same(keys[i]!, heard[j]!.word) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const anchor: Array<HeardWord | null> = new Array(n).fill(null);
  let matched = 0;
  for (let i = 0, j = 0; i < n && j < m;) {
    if (keys[i] !== "" && same(keys[i]!, heard[j]!.word) && table[i]![j] === table[i + 1]![j + 1]! + 1) {
      anchor[i] = heard[j]!;
      matched += 1;
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  if (matched < Math.max(3, Math.ceil(n * 0.2))) return null;
  const starts: number[] = new Array(n).fill(0);
  let previous = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && !anchor[i]) continue;
    // The words between the last anchor and this one (or the ends of the song).
    const from = previous;
    const to = i;
    for (let k = from + 1; k < to; k++) {
      if (from >= 0 && to < n) {
        const a = anchor[from]!.end;
        const b = anchor[to]!.start;
        starts[k] = a + ((b - a) * (k - from - 1)) / (to - from - 1);
      } else if (from < 0 && to < n) {
        starts[k] = Math.max(0, anchor[to]!.start - (to - k) * WORD_SECONDS);
      } else {
        starts[k] = anchor[from]!.end + (k - from - 1) * WORD_SECONDS;
      }
    }
    if (i < n) starts[i] = anchor[i]!.start;
    previous = i;
  }
  return lyrics.map((text, i) => {
    const start = Math.round(starts[i]! * 100) / 100;
    const own = anchor[i] ? anchor[i]!.end : start + WORD_SECONDS;
    const next = i + 1 < n ? starts[i + 1]! : own;
    const end = Math.round(Math.max(start + 0.05, Math.min(own, next > start ? next : own)) * 100) / 100;
    return { text, start, end };
  });
}

export interface EarDeps {
  fetcher?: typeof fetch;
  windows?: (source: string) => AsyncIterable<Window>;
  sleep?: (ms: number) => Promise<void>;
}

/** Every sung phrase of a recording with its time, heard by nixamp.com's ear a window at a time. */
export async function hearSong(session: Pick<Session, "site" | "token">, audio: string, language: string, deps: EarDeps = {}): Promise<Segment[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const out: Segment[] = [];
  for await (const window of (deps.windows ?? ((path: string) => windowsOf(path)))(audio)) {
    if (isQuiet(window.pcm)) continue;
    const wav = wavOfPcm(window.pcm);
    let answer = await askToHear(session, { wav, timestamps: true, ...(language ? { language } : {}) }, deps.fetcher);
    // The ear allows so many seconds of sound a minute: a 429 is a wait.
    for (let attempt = 0; !answer.ok && answer.status === 429 && attempt < 30; attempt++) {
      await sleep(10_000);
      answer = await askToHear(session, { wav, timestamps: true, ...(language ? { language } : {}) }, deps.fetcher);
    }
    if (!answer.ok) throw new Error(`the ear answered ${answer.status || "nothing"}: ${answer.error}`);
    const length = window.pcm.length / (RATE * 2);
    const pieces = answer.heard.segments?.length ? answer.heard.segments : answer.heard.text ? [{ start: 0, end: length, text: answer.heard.text }] : [];
    for (const piece of pieces) out.push({ start: window.offset + piece.start, end: window.offset + Math.min(piece.end, length), text: piece.text });
  }
  return out;
}

/** An aligner like ElevenLabs': the song and its words in, one time per word out, heard by nixamp.com. */
export function earAligner(session: () => Pick<Session, "site" | "token"> | null, language = "en", deps: EarDeps = {}): (audio: string, text: string) => Promise<TimedWord[]> {
  return async (audio, text) => {
    const signedIn = session();
    if (!signedIn?.token) throw new Error("this server is not signed in to nixamp.com, so its ear cannot time the words; `nixamp login`");
    const words = text.split(/\s+/).filter(Boolean);
    const timed = alignWords(words, heardWords(await hearSong(signedIn, audio, language, deps)));
    if (!timed) throw new Error("the ear heard too few of the words to time them");
    return timed;
  };
}

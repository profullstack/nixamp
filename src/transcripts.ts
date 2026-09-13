/**
 * Transcripts, kept: what a file, a link or a live said, written down once.
 *
 * Hearing costs a CPU for as long as the sound lasts, and a film heard on
 * Tuesday says the same words on Thursday. So what the ear hears is kept
 * here, on nixamp.com, under an identity of the media rather than of the
 * channel that happened to be playing it: a file is its fingerprint, a
 * link is its address, and a live is the one broadcast it was. The next
 * captioner to meet the same media reads the lines instead of hearing
 * them, and a translation is done once and kept beside the original.
 *
 * Lines are seconds into the media, not wall-clock moments. A captioner
 * turns its wall-clock stamps into offsets from the channel's start on the
 * way in, and back on the way out, so a transcript of a file means the
 * same thing whichever server plays it.
 *
 * One row per (media, language). The original is the row translated from
 * nothing; a translation says which language it came from. A row grows by
 * appending: a live is captioned as it happens and a file may be heard in
 * pieces, on different days, by different servers. A whole-media pass --
 * `nixamp transcribe FILE` -- replaces the pieces with the whole and marks
 * the row complete, after which nothing partial touches it again.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Queryable } from "./follows.ts";

/** One thing said: seconds into the media, and the words. */
export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

export type MediaKind = "file" | "url" | "live";

export interface Transcript {
  /** sha256 of the media identity: what the routes are addressed by. */
  id: string;
  /** The identity itself: file:v1:<hex>, url:<address>, live:<server>/<channel>@<started>. */
  media: string;
  kind: MediaKind;
  /** ISO 639-1 of the lines, or "" when the ear was not told and did not say. */
  language: string;
  /** The language this was translated from, or null for what was heard. */
  translatedFrom: string | null;
  model: string;
  /** Whether the whole media was heard in one pass, rather than in windows as it played. */
  complete: boolean;
  /** What it was called when it was heard, for a list. */
  title: string;
  /** Who stored it: the account the ear was asked as. */
  by: string;
  /** How far into the media the lines reach, seconds. */
  seconds: number;
  lines: TranscriptLine[];
  updatedAt: string;
}

/** A transcript without its lines, as a list shows it. */
export type TranscriptSummary = Omit<Transcript, "lines"> & { lines: number };

/** A row grows no further than this; a day of talk is under half of it. */
export const MAX_LINES = 20_000;
/** A line longer than this is not a line. */
export const MAX_LINE_CHARS = 2000;
/** How much of a file's bytes go into its fingerprint, at each end. */
export const FINGERPRINT_BYTES = 1024 * 1024;

// --- identity ----------------------------------------------------------------

/**
 * A file's identity from its size and a megabyte at each end. Hashing every
 * byte of a film takes seconds a captioner does not have at start, and the
 * ends plus the size tell two files apart as surely as anything short of
 * the whole does. The v1 says how it was made, so a better way later does
 * not collide with this one.
 */
export function fileFingerprint(path: string): string {
  const size = statSync(path).size;
  const hash = createHash("sha256");
  const sizeBytes = Buffer.alloc(8);
  sizeBytes.writeBigUInt64LE(BigInt(size));
  hash.update(sizeBytes);
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
    readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (size > FINGERPRINT_BYTES) {
      const tail = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size - FINGERPRINT_BYTES));
      readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    closeSync(fd);
  }
  return `file:v1:${hash.digest("hex")}`;
}

/** A link's identity: the address without its fragment, which no server sees. */
export function mediaOfUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return `url:${parsed.toString()}`;
  } catch {
    return `url:${trimmed}`;
  }
}

/** A broadcast's identity: the server, the channel, and when it began, so a second airing is a second transcript. */
export function mediaOfLive(server: string, channel: string, startedAt: number): string {
  let host = server.trim().replace(/\/+$/, "");
  try {
    // A bare host:port parses as a scheme and a path; give it one first.
    host = new URL(host.includes("://") ? host : `https://${host}`).host;
  } catch {
    host = host.replace(/^https?:\/\//, "");
  }
  return `live:${host}/${channel}@${Math.floor(startedAt)}`;
}

export function kindOf(media: string): MediaKind {
  if (media.startsWith("file:")) return "file";
  if (media.startsWith("live:")) return "live";
  return "url";
}

/** The id a transcript is addressed by: a hash, so a link with a key in it is not in the address bar. */
export function transcriptIdOf(media: string): string {
  return createHash("sha256").update(media).digest("hex");
}

/** A transcript id as a request names one, or null when it is not one. */
export function transcriptId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Either the id itself or a media identity, as a route accepts both. */
export function idFrom(value: string): string {
  return transcriptId(value) ?? transcriptIdOf(value);
}

// --- lines -------------------------------------------------------------------

/** Lines as a request or a row hands them in: only the well-formed ones, tidied. */
export function linesFrom(value: unknown): TranscriptLine[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const lines: TranscriptLine[] = [];
  for (const one of parsed) {
    if (!one || typeof one !== "object") continue;
    const { start, end, text } = one as Record<string, unknown>;
    if (typeof text !== "string" || typeof start !== "number" || !Number.isFinite(start) || start < 0) continue;
    const words = text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
    if (words === "") continue;
    const until = typeof end === "number" && Number.isFinite(end) && end > start ? end : start;
    lines.push({ start: round(start), end: round(until), text: words });
  }
  return lines;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Lines in order, with the duplicates gone. Two servers playing one file
 * both append what they heard, a captioner that restarted hears a window
 * again: the second copy of a moment says the same thing, later, and a
 * viewer would read it twice. A line whose span mostly overlaps one already
 * kept is that second copy.
 */
export function mergeLines(lines: TranscriptLine[]): TranscriptLine[] {
  const sorted = [...lines].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: TranscriptLine[] = [];
  for (const line of sorted) {
    const last = kept[kept.length - 1];
    if (last && overlaps(last, line)) {
      // The same moment twice: keep the longer account of it.
      if (line.text.length > last.text.length && Math.abs(line.start - last.start) < 1) kept[kept.length - 1] = line;
      continue;
    }
    kept.push(line);
  }
  return kept;
}

function overlaps(a: TranscriptLine, b: TranscriptLine): boolean {
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (shorter <= 0) return Math.abs(a.start - b.start) < 0.5;
  return shared > shorter * 0.6;
}

/** Whether the kept lines already say what this span says: over half of it is covered. */
export function covered(lines: TranscriptLine[], start: number, end: number): TranscriptLine[] {
  const span = end - start;
  if (span <= 0) return [];
  const inside = lines.filter((line) => Math.min(line.end, end) - Math.max(line.start, start) > 0);
  const shared = inside.reduce((sum, line) => sum + (Math.min(line.end, end) - Math.max(line.start, start)), 0);
  return shared > span / 2 ? inside : [];
}

/** The line for a moment, if there is one: the one that begins nearest, within a second. */
export function lineAt(lines: TranscriptLine[], start: number): TranscriptLine | null {
  let nearest: TranscriptLine | null = null;
  for (const line of lines) {
    const off = Math.abs(line.start - start);
    if (off <= 1 && (nearest === null || off < Math.abs(nearest.start - start))) nearest = line;
  }
  return nearest;
}

/** How far the lines reach, seconds. */
export function reach(lines: TranscriptLine[]): number {
  return lines.reduce((most, line) => Math.max(most, line.end), 0);
}

// --- formats -----------------------------------------------------------------

/** Seconds as a subtitle clock: 01:02:03,456 for SRT, 01:02:03.456 for VTT. */
export function stamp(seconds: number, separator: "," | "." = ","): string {
  const whole = Math.max(0, Math.floor(seconds));
  const ms = Math.max(0, Math.round((seconds - whole) * 1000));
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor((whole % 3600) / 60))}:${two(whole % 60)}${separator}${String(ms).padStart(3, "0")}`;
}

export function toSrt(lines: TranscriptLine[]): string {
  return lines
    .map((line, i) => `${i + 1}\n${stamp(line.start)} --> ${stamp(Math.max(line.end, line.start + 0.5))}\n${line.text}\n`)
    .join("\n");
}

export function toVtt(lines: TranscriptLine[]): string {
  const cues = lines.map((line) => `${stamp(line.start, ".")} --> ${stamp(Math.max(line.end, line.start + 0.5), ".")}\n${line.text}\n`);
  return `WEBVTT\n\n${cues.join("\n")}`;
}

/** The words alone, one line each, as a person reads them. */
export function toText(lines: TranscriptLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

export type Format = "json" | "srt" | "vtt" | "txt";

export function formatOf(value: unknown): Format | null {
  if (value === null || value === undefined || value === "") return "json";
  return value === "json" || value === "srt" || value === "vtt" || value === "txt" ? value : null;
}

/** A two-letter language, or "" for none; null when the value is something else. */
export function languageCode(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (code === "" || code === "original") return "";
  return /^[a-z]{2}$/.test(code) ? code : null;
}

// --- the store ---------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transcripts (
    id               TEXT NOT NULL,
    language         TEXT NOT NULL DEFAULT '',
    media            TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'url',
    translated_from  TEXT,
    model            TEXT NOT NULL DEFAULT '',
    complete         BOOLEAN NOT NULL DEFAULT false,
    title            TEXT NOT NULL DEFAULT '',
    by_account       TEXT NOT NULL DEFAULT '',
    seconds          DOUBLE PRECISION NOT NULL DEFAULT 0,
    lines            JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, language)
  );
  CREATE INDEX IF NOT EXISTS transcripts_by_account ON transcripts (by_account, updated_at DESC);
`;

export interface SaveAsk {
  media: string;
  language: string;
  translatedFrom?: string | null;
  model?: string;
  /** A whole-media pass: these lines are the transcript, not part of it. */
  complete?: boolean;
  title?: string;
  by: string;
  lines: TranscriptLine[];
}

export class Transcripts {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly onEvent: (message: string) => void = () => {},
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(SCHEMA).then(() => undefined);
    await this.ready;
  }

  /**
   * Keep lines. New media is a new row; known media grows by these lines,
   * unless the row is already whole -- then pieces are nothing it needs --
   * or these lines are the whole, which replaces whatever pieces there
   * were. Answers the row as it now stands.
   */
  async save(ask: SaveAsk): Promise<Transcript | null> {
    const lines = mergeLines(linesFrom(ask.lines)).slice(0, MAX_LINES);
    const id = transcriptIdOf(ask.media);
    const complete = ask.complete === true;
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO transcripts (id, language, media, kind, translated_from, model, complete, title, by_account, seconds, lines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (id, language) DO UPDATE SET
         lines = CASE
           WHEN EXCLUDED.complete THEN EXCLUDED.lines
           WHEN transcripts.complete THEN transcripts.lines
           WHEN jsonb_array_length(transcripts.lines) >= $12 THEN transcripts.lines
           ELSE transcripts.lines || EXCLUDED.lines
         END,
         seconds = CASE WHEN EXCLUDED.complete THEN EXCLUDED.seconds ELSE GREATEST(transcripts.seconds, EXCLUDED.seconds) END,
         complete = transcripts.complete OR EXCLUDED.complete,
         model = CASE WHEN EXCLUDED.model = '' THEN transcripts.model ELSE EXCLUDED.model END,
         title = CASE WHEN EXCLUDED.title = '' THEN transcripts.title ELSE EXCLUDED.title END,
         translated_from = COALESCE(EXCLUDED.translated_from, transcripts.translated_from),
         updated_at = now()
       RETURNING *`,
      [
        id,
        ask.language,
        ask.media,
        kindOf(ask.media),
        ask.translatedFrom ?? null,
        ask.model ?? "",
        complete,
        (ask.title ?? "").slice(0, 200),
        ask.by,
        reach(lines),
        JSON.stringify(lines),
        MAX_LINES,
      ],
    );
    const row = rows[0];
    return row ? rowToTranscript(row) : null;
  }

  /**
   * The transcript of some media in a language: the original when none is
   * named, which is the heard row -- the whole one when there is one.
   */
  async get(id: string, language = ""): Promise<Transcript | null> {
    await this.ensure();
    const { rows } = language === ""
      ? await this.db.query(
          `SELECT * FROM transcripts WHERE id = $1 AND translated_from IS NULL
           ORDER BY complete DESC, updated_at DESC LIMIT 1`,
          [id],
        )
      : await this.db.query("SELECT * FROM transcripts WHERE id = $1 AND language = $2 LIMIT 1", [id, language]);
    const row = rows[0];
    return row ? rowToTranscript(row) : null;
  }

  /** Every language some media has been written down in, with how much of it. */
  async languages(id: string): Promise<{ language: string; translatedFrom: string | null; lines: number; complete: boolean }[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT language, translated_from, complete, jsonb_array_length(lines) AS lines
       FROM transcripts WHERE id = $1 ORDER BY translated_from NULLS FIRST, language`,
      [id],
    );
    return rows.map((row) => ({
      language: String(row["language"] ?? ""),
      translatedFrom: row["translated_from"] === null || row["translated_from"] === undefined ? null : String(row["translated_from"]),
      lines: Number(row["lines"] ?? 0),
      complete: row["complete"] === true,
    }));
  }

  /** What an account has had written down, newest first. */
  async list(by: string, limit = 50): Promise<TranscriptSummary[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      `SELECT id, language, media, kind, translated_from, model, complete, title, by_account, seconds, updated_at,
              jsonb_array_length(lines) AS lines
       FROM transcripts WHERE by_account = $1 ORDER BY updated_at DESC LIMIT $2`,
      [by, Math.max(1, Math.min(500, limit))],
    );
    return rows.map((row) => ({ ...rowToTranscript({ ...row, lines: "[]" }), lines: Number(row["lines"] ?? 0) }));
  }

  /** Forget some media, in every language. Only whoever stored it may. Says whether anything went. */
  async forget(id: string, by: string): Promise<boolean> {
    await this.ensure();
    const { rows } = await this.db.query("DELETE FROM transcripts WHERE id = $1 AND by_account = $2 RETURNING language", [id, by]);
    return rows.length > 0;
  }

  /** Never throws: a store that is having a moment costs the memory, not the request. */
  async quietly<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.onEvent(`  ${what} did not persist: ${(error as Error).message}`);
      return null;
    }
  }
}

function rowToTranscript(row: Record<string, unknown>): Transcript {
  const updated = row["updated_at"];
  return {
    id: String(row["id"] ?? ""),
    media: String(row["media"] ?? ""),
    kind: kindOf(String(row["media"] ?? "")),
    language: String(row["language"] ?? ""),
    translatedFrom: row["translated_from"] === null || row["translated_from"] === undefined ? null : String(row["translated_from"]),
    model: String(row["model"] ?? ""),
    complete: row["complete"] === true,
    title: String(row["title"] ?? ""),
    by: String(row["by_account"] ?? ""),
    seconds: Number(row["seconds"] ?? 0),
    lines: mergeLines(linesFrom(row["lines"])),
    updatedAt: updated instanceof Date ? updated.toISOString() : typeof updated === "string" ? updated : "",
  };
}

/** A transcript as the routes answer it, with or without its lines. */
export function wire(transcript: Transcript, languages: { language: string; translatedFrom: string | null; lines: number; complete: boolean }[] = []): Record<string, unknown> {
  return {
    id: transcript.id,
    media: transcript.media,
    kind: transcript.kind,
    language: transcript.language,
    translatedFrom: transcript.translatedFrom,
    model: transcript.model,
    complete: transcript.complete,
    title: transcript.title,
    seconds: transcript.seconds,
    updatedAt: transcript.updatedAt,
    lines: transcript.lines,
    languages,
  };
}

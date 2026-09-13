/**
 * One address per file: nixamp.com/hash/<sha256>, and everything nixamp has
 * learned about the bytes behind it.
 *
 * The transcript store keys a file by a quick fingerprint (see
 * transcripts.ts), which is enough to know a file again. This is the other
 * half: the record of the file itself, keyed by the SHA-256 of every byte,
 * the way OpenFile (logicsrc.com/docs/openfile) names a file, so the same
 * bytes on two machines are one record and a directory reading nixamp's
 * listing dedupes on the same id as everybody else's.
 *
 * The record is an OpenFile file object. Its required keys are the id and
 * a name; `size`, `contentType` and `updated` describe the bytes, `holders`
 * says which nixamp servers have carried it, and everything nixamp itself
 * found goes under a `nixamp` key, which is where the specification tells a
 * publisher to put its own: the fingerprint, what ffprobe saw, what nichedb
 * said it was, the transcripts and their languages, and when the file was
 * last checked and is next due.
 *
 * A record is filled in by whoever meets the file: `nixamp hash`, `nixamp
 * transcribe`, and a server captioning it. Each sends what it knows and the
 * record keeps the union. A file that changes on disk gets a new hash and
 * so a new record; the machine holding it notices (media-index.ts) and says
 * which record the old one became.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Queryable } from "./follows.ts";
import type { Codecs } from "./audio.ts";
import type { Enriched } from "./enrich.ts";

/** What the nixamp key of a record may carry. Every part optional: a record grows. */
export interface MediaFacts {
  /** The transcript store's identity for the same file. */
  fingerprint?: string;
  /** Seconds. */
  duration?: number;
  codecs?: { video?: string; audio?: string; container?: string };
  width?: number;
  height?: number;
  tags?: { title?: string; artist?: string; album?: string };
  /** What nichedb said it is. */
  enrichment?: { kind?: string; title?: string; year?: number | null; image?: string | null; summary?: string | null; page?: string };
  /** The record this file became when it changed on disk, as `sha256:<hex>`. */
  supersededBy?: string;
  /** The record this file was before it changed. */
  supersedes?: string;
  /** When the machine holding it last looked, and when it will next. */
  checkedAt?: string;
  checkAfter?: string;
}

/** A place that has carried the file: an OpenFile holder. A nixamp server serves it over HTTP, which makes it a gateway. */
export interface Holder {
  kind: "gateway" | "peer" | "seeder";
  url: string;
  seenAt: string;
  /** The channel it was carried as, when it was. */
  channel?: string;
  name?: string;
}

export interface MediaRecord {
  /** The SHA-256 of the bytes, hex. */
  id: string;
  name: string;
  size: number;
  contentType: string;
  /** When the file last changed, ISO. */
  updated: string;
  facts: MediaFacts;
  holders: Holder[];
  by: string;
  createdAt: string;
  updatedAt: string;
}

/** How many places a record remembers carrying it. */
export const MAX_HOLDERS = 50;
/** The listing at /.well-known/openfile.json is this long at most. */
export const LISTING = 100;
/** A file changed an hour ago is looked at again in a quarter of an hour; one untouched for years, once a month. */
export const CHECK_MIN_MS = 15 * 60 * 1000;
export const CHECK_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
  ts: "video/mp2t", m2ts: "video/mp2t", mpg: "video/mpeg", mpeg: "video/mpeg", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/opus", wma: "audio/x-ms-wma", aiff: "audio/aiff", aif: "audio/aiff", alac: "audio/mp4",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", srt: "application/x-subrip", vtt: "text/vtt",
  m3u: "audio/x-mpegurl", m3u8: "application/vnd.apple.mpegurl", pls: "audio/x-scpls", zip: "application/zip",
};

/** The media type a file's name suggests, or octet-stream. */
export function contentTypeOf(path: string): string {
  return TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** A media id as a request names one: bare hex or `sha256:` hex; the hex, or null. */
export function mediaId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** The SHA-256 of every byte of a file, as a stream so a film does not sit in memory. */
export function contentHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** What the filesystem says about a file: its size, when it changed, and its type. */
export function fileFacts(path: string): { name: string; size: number; updated: string; contentType: string; mtimeMs: number } {
  const stat = statSync(path);
  return { name: basename(path), size: stat.size, updated: new Date(stat.mtimeMs).toISOString(), contentType: contentTypeOf(path), mtimeMs: stat.mtimeMs };
}

/**
 * How long to leave a file alone before looking at it again: a quarter of
 * the time since it last changed, between a quarter of an hour and a
 * month. A file being edited is looked at often; a film from 2019 is not
 * stat'd every hour of every day for the rest of its life.
 */
export function checkInterval(mtimeMs: number, nowMs: number): number {
  const age = Math.max(0, nowMs - mtimeMs);
  return Math.min(CHECK_MAX_MS, Math.max(CHECK_MIN_MS, Math.floor(age / 4)));
}

/** The facts ffprobe and nichedb give a server, as the record wants them. */
export function factsFrom(codecs?: Codecs | null, enriched?: Enriched | null): MediaFacts {
  const facts: MediaFacts = {};
  if (codecs) {
    if (codecs.video || codecs.audio || codecs.container) {
      facts.codecs = { ...(codecs.video ? { video: codecs.video } : {}), ...(codecs.audio ? { audio: codecs.audio } : {}), ...(codecs.container ? { container: codecs.container } : {}) };
    }
    if (codecs.duration) facts.duration = Math.round(codecs.duration * 1000) / 1000;
    if (codecs.width) facts.width = codecs.width;
    if (codecs.height) facts.height = codecs.height;
    if (codecs.tags && (codecs.tags.title || codecs.tags.artist || codecs.tags.album)) facts.tags = { ...codecs.tags };
  }
  if (enriched) {
    facts.enrichment = {
      kind: enriched.kind, title: enriched.title, year: enriched.year, image: enriched.image, summary: enriched.summary, page: enriched.page,
    };
  }
  return facts;
}

/** Facts as a request hands them in: only the keys this file names, each of the right shape. */
export function factsFromRequest(value: unknown): MediaFacts {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const facts: MediaFacts = {};
  const text = (key: string): string | undefined => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim().slice(0, 500) : undefined);
  const num = (key: string): number | undefined => (typeof raw[key] === "number" && Number.isFinite(raw[key] as number) && (raw[key] as number) >= 0 ? (raw[key] as number) : undefined);
  const fp = text("fingerprint");
  if (fp && /^file:v1:[0-9a-f]{64}$/.test(fp)) facts.fingerprint = fp;
  if (num("duration") !== undefined) facts.duration = num("duration");
  if (num("width") !== undefined) facts.width = num("width");
  if (num("height") !== undefined) facts.height = num("height");
  if (raw["codecs"] && typeof raw["codecs"] === "object") {
    const c = raw["codecs"] as Record<string, unknown>;
    const codecs: MediaFacts["codecs"] = {};
    for (const key of ["video", "audio", "container"] as const) if (typeof c[key] === "string" && c[key]) codecs[key] = (c[key] as string).slice(0, 80);
    if (Object.keys(codecs).length > 0) facts.codecs = codecs;
  }
  if (raw["tags"] && typeof raw["tags"] === "object") {
    const t = raw["tags"] as Record<string, unknown>;
    const tags: MediaFacts["tags"] = {};
    for (const key of ["title", "artist", "album"] as const) if (typeof t[key] === "string" && t[key]) tags[key] = (t[key] as string).slice(0, 300);
    if (Object.keys(tags).length > 0) facts.tags = tags;
  }
  if (raw["enrichment"] && typeof raw["enrichment"] === "object") {
    const e = raw["enrichment"] as Record<string, unknown>;
    const enrichment: MediaFacts["enrichment"] = {};
    for (const key of ["kind", "title", "image", "summary", "page"] as const) if (typeof e[key] === "string") enrichment[key] = (e[key] as string).slice(0, 2000);
    if (typeof e["year"] === "number") enrichment.year = e["year"] as number;
    if (Object.keys(enrichment).length > 0) facts.enrichment = enrichment;
  }
  for (const key of ["supersededBy", "supersedes"] as const) {
    const id = mediaId(raw[key]);
    if (id) facts[key] = `sha256:${id}`;
  }
  for (const key of ["checkedAt", "checkAfter"] as const) {
    const when = text(key);
    if (when && !Number.isNaN(Date.parse(when))) facts[key] = new Date(when).toISOString();
  }
  return facts;
}

/** A holder as a request hands it in, or null. */
export function holderFrom(value: unknown): Holder | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const url = typeof raw["url"] === "string" ? raw["url"].trim().slice(0, 500) : "";
  if (!/^https?:\/\//.test(url)) return null;
  const kind = raw["kind"] === "peer" || raw["kind"] === "seeder" ? raw["kind"] : "gateway";
  return {
    kind,
    url,
    seenAt: typeof raw["seenAt"] === "string" && !Number.isNaN(Date.parse(raw["seenAt"])) ? new Date(raw["seenAt"]).toISOString() : new Date().toISOString(),
    ...(typeof raw["channel"] === "string" && raw["channel"] ? { channel: raw["channel"].slice(0, 80) } : {}),
    ...(typeof raw["name"] === "string" && raw["name"] ? { name: raw["name"].slice(0, 200) } : {}),
  };
}

/** Holders with one entry per address, the latest sighting kept, newest first. */
export function mergeHolders(had: Holder[], added: Holder[]): Holder[] {
  const byUrl = new Map<string, Holder>();
  for (const holder of [...had, ...added]) {
    const key = holder.url.replace(/\/+$/, "");
    const before = byUrl.get(key);
    if (!before || Date.parse(holder.seenAt) >= Date.parse(before.seenAt)) byUrl.set(key, { ...before, ...holder });
  }
  return [...byUrl.values()].sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt)).slice(0, MAX_HOLDERS);
}

// --- the store ---------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS media (
    id            TEXT PRIMARY KEY,
    fingerprint   TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL DEFAULT '',
    size          BIGINT NOT NULL DEFAULT 0,
    content_type  TEXT NOT NULL DEFAULT '',
    updated       TIMESTAMPTZ,
    facts         JSONB NOT NULL DEFAULT '{}'::jsonb,
    holders       JSONB NOT NULL DEFAULT '[]'::jsonb,
    by_account    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS media_by_fingerprint ON media (fingerprint);
  CREATE INDEX IF NOT EXISTS media_recent ON media (updated_at DESC);
`;

export interface MediaAsk {
  id: string;
  name?: string;
  size?: number;
  contentType?: string;
  /** When the file last changed. */
  updated?: string;
  facts?: MediaFacts;
  holder?: Holder | null;
  by: string;
}

export class Media {
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
   * Keep what somebody knows about a file. A new id is a new record; a known
   * one keeps its union: facts merge key by key with the newer winning,
   * holders merge by address, a name or a size given replaces one that was
   * not. The account that first kept it stays its keeper.
   */
  async save(ask: MediaAsk): Promise<MediaRecord | null> {
    await this.ensure();
    const had = await this.get(ask.id);
    const facts: MediaFacts = { ...(had?.facts ?? {}), ...(ask.facts ?? {}) };
    const holders = mergeHolders(had?.holders ?? [], ask.holder ? [ask.holder] : []);
    const { rows } = await this.db.query(
      `INSERT INTO media (id, fingerprint, name, size, content_type, updated, facts, holders, by_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       ON CONFLICT (id) DO UPDATE SET
         fingerprint = CASE WHEN EXCLUDED.fingerprint = '' THEN media.fingerprint ELSE EXCLUDED.fingerprint END,
         name = CASE WHEN EXCLUDED.name = '' THEN media.name ELSE EXCLUDED.name END,
         size = CASE WHEN EXCLUDED.size = 0 THEN media.size ELSE EXCLUDED.size END,
         content_type = CASE WHEN EXCLUDED.content_type = '' THEN media.content_type ELSE EXCLUDED.content_type END,
         updated = COALESCE(EXCLUDED.updated, media.updated),
         facts = EXCLUDED.facts,
         holders = EXCLUDED.holders,
         updated_at = now()
       RETURNING *`,
      [
        ask.id,
        facts.fingerprint ?? "",
        (ask.name ?? "").slice(0, 300),
        ask.size ?? 0,
        ask.contentType ?? "",
        ask.updated ?? null,
        JSON.stringify(facts),
        JSON.stringify(holders),
        ask.by,
      ],
    );
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  async get(id: string): Promise<MediaRecord | null> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT * FROM media WHERE id = $1 LIMIT 1", [id]);
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  /** The record of the file a transcript fingerprint belongs to, the latest when there are several. */
  async byFingerprint(fingerprint: string): Promise<MediaRecord | null> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT * FROM media WHERE fingerprint = $1 ORDER BY updated_at DESC LIMIT 1", [fingerprint]);
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  /** The latest records, newest first, for the listing. */
  async recent(limit = LISTING): Promise<MediaRecord[]> {
    await this.ensure();
    const { rows } = await this.db.query("SELECT * FROM media ORDER BY updated_at DESC LIMIT $1", [Math.max(1, Math.min(LISTING, limit))]);
    return rows.map(rowToRecord);
  }

  /** Never throws: a store that is having a moment costs the record, not the request. */
  async quietly<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.onEvent(`  ${what} did not persist: ${(error as Error).message}`);
      return null;
    }
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return "";
}

function parsed<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value as T) ?? fallback;
}

function rowToRecord(row: Record<string, unknown>): MediaRecord {
  const facts = parsed<MediaFacts>(row["facts"], {});
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    size: Number(row["size"] ?? 0),
    contentType: String(row["content_type"] ?? ""),
    updated: iso(row["updated"]),
    facts: facts && typeof facts === "object" ? facts : {},
    holders: (parsed<Holder[]>(row["holders"], []) ?? []).filter((one) => one && typeof one.url === "string"),
    by: String(row["by_account"] ?? ""),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

// --- OpenFile ----------------------------------------------------------------

/** A transcript, as the record lists it: enough to pick a language and fetch it. */
export interface TranscriptRef {
  language: string;
  translatedFrom: string | null;
  lines: number;
  complete: boolean;
}

/**
 * The record as an OpenFile file object: the specification's keys at the
 * top, nixamp's own under `nixamp`. `fetch` is empty on purpose: nixamp.com
 * has no bytes to hand out, only what it knows about them; the holders are
 * where they were last carried.
 */
export function openFileOf(record: MediaRecord, site: string, transcripts: TranscriptRef[] = []): Record<string, unknown> {
  const base = site.replace(/\/+$/, "");
  const facts = { ...record.facts };
  return {
    id: `sha256:${record.id}`,
    name: record.name || record.id,
    url: `${base}/hash/${record.id}`,
    descriptor: `${base}/hash/${record.id}.openfile.json`,
    ...(record.size ? { size: record.size } : {}),
    ...(record.contentType ? { contentType: record.contentType } : {}),
    encryption: "none",
    fetch: [],
    holders: record.holders.map((holder) => ({ kind: holder.kind, url: holder.url, seenAt: holder.seenAt, ...(holder.channel ? { channel: holder.channel } : {}), ...(holder.name ? { name: holder.name } : {}) })),
    ...(record.updated ? { updated: record.updated } : {}),
    nixamp: {
      ...facts,
      transcripts: transcripts.map((one) => ({
        ...one,
        url: `${base}/hash/${record.id}.srt${one.language ? `?language=${one.language}` : ""}`,
      })),
      kept: record.createdAt,
      seen: record.updatedAt,
    },
  };
}

/** The publisher's descriptor: nixamp.com and its latest records. */
export function openFileListing(records: MediaRecord[], site: string): Record<string, unknown> {
  const base = site.replace(/\/+$/, "");
  return {
    publisher: {
      name: "nixamp",
      web: base,
      developer: {
        cli: { name: "nixamp", install: { curl: "curl -fsSL https://nixamp.com/install.sh | sh" }, docs: "https://github.com/profullstack/nixamp#readme", repo: "https://github.com/profullstack/nixamp" },
      },
    },
    updated: records[0]?.updatedAt ?? new Date(0).toISOString(),
    files: records.map((record) => openFileOf(record, base)),
  };
}

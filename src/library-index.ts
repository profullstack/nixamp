/**
 * The library, written down.
 *
 * The player used to learn its library afresh at every start: walk the tree,
 * then ffprobe every file one by one, and only when the last file had
 * answered hand any tags to the player. On a library of a few thousand files
 * that is a long time of file names, every restart. Here what was learned is
 * kept beside the keys (`library-<port>.json`) and a rescan asks only about
 * files that are new or have changed (size or modification time), so a
 * restart has its tags at once and a rescan of an unchanged library probes
 * nothing.
 *
 * Every file is an item with an id that stays the same for as long as the
 * file stays where it is, and a state:
 *
 *   pending      found, not yet asked about
 *   ready        decodes; has a duration
 *   unsupported  ffprobe answered, but there is nothing in it to play
 *   failed       ffprobe could not read it (the reason is kept)
 *   unavailable  was here, is not now (kept, with its corrections, in case
 *                the disk comes back)
 *
 * Corrections an owner makes to tags are kept apart from what the file says
 * and survive any number of rescans. Removing a source forgets its items; it
 * never touches a file.
 *
 * Sources are folders on this machine, inside approved roots: never the
 * whole filesystem, the home directory or a hidden folder (library.ts says
 * why), and a symlink is followed only when it lands back inside the source.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Track, Tools } from "./audio.ts";
import { protocolArgs } from "./decoder-policy.ts";
import { forbiddenLibrary } from "./library.ts";
import { compareNames, playable } from "./playlist.ts";

export type ItemState = "pending" | "ready" | "unsupported" | "failed" | "unavailable";

export interface Tags {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  track: number;
  disc: number;
  genre: string;
  year: number;
}

export const TAG_FIELDS: readonly (keyof Tags)[] = ["title", "artist", "album", "albumArtist", "track", "disc", "genre", "year"];

export interface LibraryItem extends Tags {
  id: string;
  sourceId: string;
  /** Absolute; never shown to anybody but the owner. */
  path: string;
  /** Inside the source, with forward slashes. */
  rel: string;
  size: number;
  mtimeMs: number;
  state: ItemState;
  error: string;
  /** Seconds; 0 until known. */
  duration: number;
  codec: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
  video: boolean;
  hasArt: boolean;
  /** The owner's corrections, applied over what the file says. */
  override: Partial<Tags>;
  firstSeen: number;
  lastSeen: number;
  probedAt: number;
}

export interface ScanReport {
  jobId: string;
  sourceId: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number;
  found: number;
  unchanged: number;
  probed: number;
  ready: number;
  failed: number;
  unsupported: number;
  missing: number;
  /** Paths that lead outside the source (symlinks), left out. */
  outside: number;
  error: string;
}

export interface LibrarySource {
  id: string;
  kind: "folder";
  root: string;
  owner: string;
  host: string;
  enabled: boolean;
  createdAt: number;
  lastScan: ScanReport | null;
  /** A folder Nixamp fills itself (imports), allowed where a library may not be. */
  managed?: boolean;
}

/** What one probe found. */
export interface Probed {
  state: "ready" | "unsupported" | "failed";
  error: string;
  tags: Partial<Tags>;
  duration: number;
  codec: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
  video: boolean;
  hasArt: boolean;
}

export class LibraryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

const BLANK_TAGS: Tags = { title: "", artist: "", album: "", albumArtist: "", track: 0, disc: 0, genre: "", year: 0 };

function idOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** "3/12" is 3; "" is 0. */
function leadingNumber(value: string | undefined): number {
  const match = /^\s*(\d+)/.exec(value ?? "");
  return match ? Number(match[1]) : 0;
}

/** Tags as ffprobe names them, in any case, from the container or the first audio stream. */
export function tagsFrom(raw: Record<string, string>): Partial<Tags> {
  const get = (...names: string[]): string => {
    for (const name of names) {
      const hit = Object.entries(raw).find(([key]) => key.toLowerCase() === name);
      if (hit && hit[1].trim()) return hit[1].trim().slice(0, 300);
    }
    return "";
  };
  return {
    title: get("title"),
    artist: get("artist", "album_artist", "albumartist"),
    album: get("album"),
    albumArtist: get("album_artist", "albumartist", "album artist"),
    track: leadingNumber(get("track", "tracknumber")),
    disc: leadingNumber(get("disc", "discnumber")),
    genre: get("genre"),
    year: leadingNumber(get("date", "year", "originaldate")),
  };
}

/** What ffprobe says about one file, read as a library needs it. */
export function readProbe(json: string): Probed {
  let parsed: {
    format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
    streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number; bit_rate?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string> }>;
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return { state: "failed", error: "ffprobe said something that is not JSON", tags: {}, duration: 0, codec: "", bitrate: 0, sampleRate: 0, channels: 0, video: false, hasArt: false };
  }
  const streams = parsed.streams ?? [];
  const audio = streams.find((one) => one.codec_type === "audio");
  const pictures = streams.filter((one) => one.codec_type === "video");
  const art = pictures.some((one) => one.disposition?.attached_pic === 1);
  const moving = pictures.some((one) => one.disposition?.attached_pic !== 1);
  const duration = Number(parsed.format?.duration ?? 0);
  const tags = tagsFrom({ ...(audio?.tags ?? {}), ...(parsed.format?.tags ?? {}) });
  if (!audio && !moving) {
    return { state: "unsupported", error: "no sound or picture in it to play", tags, duration: 0, codec: "", bitrate: 0, sampleRate: 0, channels: 0, video: false, hasArt: art };
  }
  return {
    state: "ready",
    error: "",
    tags,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    codec: audio?.codec_name ?? "",
    bitrate: Math.round(Number(audio?.bit_rate ?? parsed.format?.bit_rate ?? 0) / 1000) || 0,
    sampleRate: Number(audio?.sample_rate ?? 0) || 0,
    channels: audio?.channels ?? 0,
    video: moving,
    hasArt: art,
  };
}

/** Ask ffprobe about one file, without holding the event loop and never for ever. */
export function probeItem(tools: Tools, path: string, timeoutMs = 20_000): Promise<Probed> {
  const [command, ...prefix] = tools.ffprobe;
  const failed = (error: string): Probed => ({ state: "failed", error, tags: {}, duration: 0, codec: "", bitrate: 0, sampleRate: 0, channels: 0, video: false, hasArt: false });
  if (!command) return Promise.resolve(failed("no ffprobe on this machine"));
  return new Promise((done) => {
    const child = spawn(command, [
      ...prefix, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
      ...protocolArgs(path), path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { if (out.length < 4 * 1024 * 1024) out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (err.length < 2000) err += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); done(failed(error.message)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return done(failed("ffprobe took too long"));
      if (code !== 0) return done(failed(err.trim().split("\n").pop()?.slice(0, 300) || `ffprobe exited ${code}`));
      done(readProbe(out));
    });
  });
}

/**
 * Every playable file under a root, in name order, without leaving it.
 *
 * Directory symlinks are followed only when they land inside the root and
 * have not been seen before, so a link back to a parent is not a loop and a
 * link to somewhere else is not a door. Counted, so the scan can say how many
 * were left out.
 */
export async function walkSource(root: string, every = 200): Promise<{ files: string[]; outside: number }> {
  const base = await realpath(root);
  const inside = (real: string): boolean => real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  const seen = new Set<string>([base]);
  const files: string[] = [];
  let outside = 0;
  let since = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort(compareNames);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (++since >= every) {
        since = 0;
        await new Promise((next) => setImmediate(next));
      }
      const full = join(dir, entry);
      let link;
      try {
        link = await lstat(full);
      } catch {
        continue;
      }
      if (link.isSymbolicLink()) {
        let real: string;
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        if (!inside(real)) {
          outside += 1;
          continue;
        }
        let target;
        try {
          target = await stat(real);
        } catch {
          continue;
        }
        if (target.isDirectory()) {
          if (seen.has(real)) continue;
          seen.add(real);
          await walk(full);
        } else if (target.isFile() && playable(full)) {
          files.push(full);
        }
        continue;
      }
      if (link.isDirectory()) {
        await walk(full);
      } else if (link.isFile() && playable(full)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return { files, outside };
}

export interface SearchQuery {
  q?: string;
  artist?: string;
  album?: string;
  genre?: string;
  folder?: string;
  sourceId?: string;
  state?: ItemState | "all";
  sort?: "path" | "title" | "artist" | "album" | "recent";
  limit?: number;
  offset?: number;
}

export type Browse = "artists" | "albums" | "genres" | "folders";

/** An item as it should read: the owner's corrections over the file's tags over its name. */
export function shown(item: LibraryItem): Tags {
  const tags: Tags = { ...BLANK_TAGS };
  for (const field of TAG_FIELDS) {
    const corrected = item.override[field];
    (tags as unknown as Record<string, unknown>)[field] = corrected !== undefined && corrected !== "" ? corrected : item[field];
  }
  if (!tags.title) tags.title = basename(item.path);
  return tags;
}

/** The library of one server, in one file beside its keys. */
export class LibraryIndex {
  private items = new Map<string, LibraryItem>();
  private byPath = new Map<string, string>();
  private sourceList = new Map<string, LibrarySource>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private jobs = new Map<string, { report: ScanReport; abort: AbortController }>();
  /** Told when any scan finishes, for whatever keeps up with the library (auto stations). */
  onScanned: ((report: ScanReport) => void) | null = null;

  constructor(
    private readonly file: string,
    private readonly io: { read: (path: string) => string | null; write: (path: string, body: string) => void } = {
      read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
      write: (path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
      },
    },
    private readonly now: () => number = Date.now,
  ) {
    const body = io.read(file);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body) as { sources?: LibrarySource[]; items?: LibraryItem[] };
      for (const source of parsed.sources ?? []) {
        // A scan that was running when the server stopped did not finish.
        if (source.lastScan?.status === "running") source.lastScan = { ...source.lastScan, status: "cancelled" };
        this.sourceList.set(source.id, source);
      }
      for (const item of parsed.items ?? []) {
        if (!item || typeof item.id !== "string" || !this.sourceList.has(item.sourceId)) continue;
        this.items.set(item.id, { ...BLANK_TAGS, ...item, override: item.override ?? {}, error: item.error ?? "" });
        this.byPath.set(item.path, item.id);
      }
    } catch {
      // Unreadable: started over, and rewritten at the next save.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `library-${port}.json`);
  }

  /** Written soon, not now: a scan changes thousands of items. */
  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 2_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.io.write(this.file, JSON.stringify({ version: 1, sources: [...this.sourceList.values()], items: [...this.items.values()] }));
  }

  sources(): LibrarySource[] {
    return [...this.sourceList.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  source(id: string): LibrarySource | undefined {
    return this.sourceList.get(id);
  }

  /** The folders this server's files have to be inside: every enabled source. */
  roots(): string[] {
    return this.sources().filter((one) => one.enabled).map((one) => one.root);
  }

  /** A folder as a source: refused when it is not one a library may be. */
  addSource(root: string, owner: string, host = hostname()): LibrarySource {
    const full = resolve(root);
    const why = forbiddenLibrary(full);
    if (why) throw new LibraryError("forbidden_root", `will not index ${why}`);
    const existing = this.sources().find((one) => one.root === full);
    if (existing) return existing;
    const nested = this.sources().find((one) => full.startsWith(one.root + sep) || one.root.startsWith(full + sep));
    if (nested) throw new LibraryError("overlapping_source", `that folder overlaps the source ${nested.root}`, 409);
    const source: LibrarySource = {
      id: idOf("source", host, full),
      kind: "folder",
      root: full,
      owner,
      host,
      enabled: true,
      createdAt: this.now(),
      lastScan: null,
    };
    this.sourceList.set(source.id, source);
    this.touch();
    return source;
  }

  /**
   * A folder Nixamp fills itself -- copies handed over from BitTorrented --
   * as a source. It lives beside the state, which is hidden and so refused
   * as a library; it is allowed here because nothing in it was put there by
   * anybody but Nixamp.
   */
  addManagedSource(root: string, host = hostname()): LibrarySource {
    const full = resolve(root);
    const existing = this.sources().find((one) => one.root === full);
    if (existing) return existing;
    const source: LibrarySource = {
      id: idOf("source", host, full), kind: "folder", root: full, owner: "", host,
      enabled: true, createdAt: this.now(), lastScan: null, managed: true,
    };
    this.sourceList.set(source.id, source);
    this.touch();
    return source;
  }

  /** The folder this server was started on, as a source, made once. */
  ensureSource(root: string, owner: string): LibrarySource | null {
    try {
      return this.addSource(root, owner);
    } catch {
      return null;
    }
  }

  setEnabled(id: string, enabled: boolean): LibrarySource {
    const source = this.sourceList.get(id);
    if (!source) throw new LibraryError("not_found", "no such source", 404);
    source.enabled = enabled;
    this.touch();
    return source;
  }

  /** Forget a source and what was learned from it. Its files are not touched. */
  removeSource(id: string): number {
    if (!this.sourceList.has(id)) throw new LibraryError("not_found", "no such source", 404);
    this.jobs.forEach((job) => { if (job.report.sourceId === id) job.abort.abort(); });
    let forgotten = 0;
    for (const item of [...this.items.values()]) {
      if (item.sourceId !== id) continue;
      this.items.delete(item.id);
      this.byPath.delete(item.path);
      forgotten += 1;
    }
    this.sourceList.delete(id);
    this.touch();
    return forgotten;
  }

  item(id: string): LibraryItem | undefined {
    return this.items.get(id);
  }

  itemAt(path: string): LibraryItem | undefined {
    const id = this.byPath.get(path);
    return id ? this.items.get(id) : undefined;
  }

  get size(): number {
    return this.items.size;
  }

  job(id: string): ScanReport | undefined {
    return this.jobs.get(id)?.report;
  }

  running(sourceId: string): ScanReport | undefined {
    return [...this.jobs.values()].map((one) => one.report).find((one) => one.sourceId === sourceId && one.status === "running");
  }

  /**
   * Look at a source again: new files are found, changed ones asked about,
   * gone ones marked unavailable. Returns at once with the job; `done`
   * settles when it is finished. One scan per source at a time.
   */
  scan(
    sourceId: string,
    probe: (path: string) => Promise<Probed>,
    options: { concurrency?: number; onProgress?: (changed: LibraryItem[]) => void; force?: boolean } = {},
  ): { report: ScanReport; done: Promise<ScanReport> } {
    const source = this.sourceList.get(sourceId);
    if (!source) throw new LibraryError("not_found", "no such source", 404);
    if (!source.enabled) throw new LibraryError("source_disabled", "that source is turned off", 409);
    const already = this.running(sourceId);
    if (already) return { report: already, done: Promise.resolve(already) };
    const report: ScanReport = {
      jobId: idOf("scan", sourceId, String(this.now()), String(Math.random())),
      sourceId, status: "running", startedAt: this.now(), finishedAt: 0,
      found: 0, unchanged: 0, probed: 0, ready: 0, failed: 0, unsupported: 0, missing: 0, outside: 0, error: "",
    };
    const abort = new AbortController();
    this.jobs.set(report.jobId, { report, abort });
    source.lastScan = report;
    const done = this.runScan(source, report, probe, abort.signal, options).catch((error: unknown) => {
      report.status = "failed";
      report.error = error instanceof Error ? error.message : String(error);
      report.finishedAt = this.now();
      this.touch();
      return report;
    });
    return { report, done };
  }

  private async runScan(
    source: LibrarySource,
    report: ScanReport,
    probe: (path: string) => Promise<Probed>,
    signal: AbortSignal,
    options: { concurrency?: number; onProgress?: (changed: LibraryItem[]) => void; force?: boolean },
  ): Promise<ScanReport> {
    const { files, outside } = await walkSource(source.root);
    report.found = files.length;
    report.outside = outside;
    const now = this.now();
    const present = new Set<string>();
    const toProbe: LibraryItem[] = [];
    for (const path of files) {
      if (signal.aborted) break;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      present.add(path);
      const rel = relative(source.root, path).split(sep).join("/");
      const id = idOf("item", source.id, rel);
      const known = this.items.get(id);
      if (known && !options.force && known.size === info.size && known.mtimeMs === info.mtimeMs && known.state !== "pending" && known.state !== "unavailable") {
        known.lastSeen = now;
        report.unchanged += 1;
        continue;
      }
      const item: LibraryItem = known ?? {
        ...BLANK_TAGS, id, sourceId: source.id, path, rel, size: 0, mtimeMs: 0, state: "pending", error: "",
        duration: 0, codec: "", bitrate: 0, sampleRate: 0, channels: 0, video: false, hasArt: false,
        override: {}, firstSeen: now, lastSeen: now, probedAt: 0,
      };
      item.path = path;
      item.size = info.size;
      item.mtimeMs = info.mtimeMs;
      item.lastSeen = now;
      item.state = "pending";
      this.items.set(id, item);
      this.byPath.set(path, id);
      toProbe.push(item);
    }
    for (const item of this.items.values()) {
      if (item.sourceId !== source.id || present.has(item.path) || signal.aborted) continue;
      if (item.state !== "unavailable") {
        item.state = "unavailable";
        item.error = "the file is not there any more";
        report.missing += 1;
      }
    }
    this.touch();

    // A couple at a time: enough to get through a library, not so many that
    // a stream being served at the same time is starved of the disk.
    const width = Math.max(1, Math.min(4, options.concurrency ?? 2));
    let next = 0;
    let batch: LibraryItem[] = [];
    const worker = async (): Promise<void> => {
      while (next < toProbe.length && !signal.aborted) {
        const item = toProbe[next++]!;
        const found = await probe(item.path);
        item.state = found.state;
        item.error = found.error;
        for (const field of TAG_FIELDS) (item as unknown as Record<string, unknown>)[field] = found.tags[field] ?? BLANK_TAGS[field];
        item.duration = found.duration;
        item.codec = found.codec;
        item.bitrate = found.bitrate;
        item.sampleRate = found.sampleRate;
        item.channels = found.channels;
        item.video = found.video;
        item.hasArt = found.hasArt;
        item.probedAt = this.now();
        report.probed += 1;
        if (found.state === "ready") report.ready += 1;
        else if (found.state === "failed") report.failed += 1;
        else report.unsupported += 1;
        batch.push(item);
        if (batch.length >= 200) {
          options.onProgress?.(batch);
          batch = [];
          this.touch();
        }
      }
    };
    await Promise.all(Array.from({ length: width }, worker));
    if (batch.length) options.onProgress?.(batch);
    report.status = signal.aborted ? "cancelled" : "done";
    report.finishedAt = this.now();
    this.touch();
    if (report.status === "done") {
      try { this.onScanned?.(report); } catch { /* a listener's trouble is not the scan's */ }
    }
    return report;
  }

  /** The owner's corrections; an empty value clears that field's correction. */
  correct(id: string, patch: Record<string, unknown>): LibraryItem {
    const item = this.items.get(id);
    if (!item) throw new LibraryError("not_found", "no such item", 404);
    for (const [field, value] of Object.entries(patch)) {
      if (!TAG_FIELDS.includes(field as keyof Tags)) throw new LibraryError("invalid_field", `${field} is not a tag that can be corrected`);
      const numeric = field === "track" || field === "disc" || field === "year";
      if (value === null || value === "" || value === 0) {
        delete item.override[field as keyof Tags];
        continue;
      }
      if (numeric ? !(Number.isInteger(value) && (value as number) >= 0 && (value as number) < 100_000) : typeof value !== "string") {
        throw new LibraryError("invalid_value", `${field} must be ${numeric ? "a whole number" : "text"}`);
      }
      (item.override as Record<string, unknown>)[field] = numeric ? value : (value as string).trim().slice(0, 300);
    }
    this.touch();
    return item;
  }

  search(query: SearchQuery = {}): { items: LibraryItem[]; total: number } {
    const words = fold(query.q ?? "").split(/\s+/).filter(Boolean);
    const state = query.state ?? "ready";
    const exact = (value: string | undefined, against: string): boolean => value === undefined || fold(against) === fold(value);
    const folder = query.folder?.replace(/^\/+|\/+$/g, "");
    const hits: LibraryItem[] = [];
    for (const item of this.items.values()) {
      if (state !== "all" && item.state !== state) continue;
      if (query.sourceId && item.sourceId !== query.sourceId) continue;
      if (folder !== undefined && folder !== "" && !item.rel.startsWith(`${folder}/`)) continue;
      const tags = shown(item);
      if (!exact(query.artist, tags.artist) || !exact(query.album, tags.album) || !exact(query.genre, tags.genre)) continue;
      if (words.length) {
        const haystack = fold(`${tags.title} ${tags.artist} ${tags.albumArtist} ${tags.album} ${tags.genre} ${item.rel}`);
        if (!words.every((word) => haystack.includes(word))) continue;
      }
      hits.push(item);
    }
    const sort = query.sort ?? "path";
    const by = (pick: (one: LibraryItem) => string | number) => (a: LibraryItem, b: LibraryItem): number => {
      const x = pick(a), y = pick(b);
      return typeof x === "number" && typeof y === "number" ? x - y : compareNames(String(x), String(y));
    };
    if (sort === "recent") hits.sort((a, b) => b.firstSeen - a.firstSeen);
    else if (sort === "title") hits.sort(by((one) => shown(one).title));
    else if (sort === "artist") hits.sort((a, b) => by((one) => shown(one).artist)(a, b) || by((one) => shown(one).album)(a, b) || by((one) => shown(one).disc)(a, b) || by((one) => shown(one).track)(a, b));
    else if (sort === "album") hits.sort((a, b) => by((one) => shown(one).album)(a, b) || by((one) => shown(one).disc)(a, b) || by((one) => shown(one).track)(a, b) || by((one) => one.rel)(a, b));
    else hits.sort(by((one) => one.rel));
    const limit = Math.min(500, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    return { items: hits.slice(offset, offset + limit), total: hits.length };
  }

  /** Grouped: every artist, album, genre or top-level folder, with how many ready items. */
  browse(kind: Browse, options: { q?: string; limit?: number; offset?: number } = {}): { groups: Array<{ name: string; count: number; artist?: string }>; total: number } {
    const counts = new Map<string, { name: string; count: number; artist?: string }>();
    for (const item of this.items.values()) {
      if (item.state !== "ready") continue;
      const tags = shown(item);
      let name: string;
      let key: string;
      let artist: string | undefined;
      if (kind === "artists") { name = tags.albumArtist || tags.artist; key = fold(name); }
      else if (kind === "albums") { name = tags.album; artist = tags.albumArtist || tags.artist; key = `${fold(name)}\0${fold(artist)}`; }
      else if (kind === "genres") { name = tags.genre; key = fold(name); }
      else { name = item.rel.includes("/") ? item.rel.slice(0, item.rel.indexOf("/")) : ""; key = name; }
      if (!name) continue;
      const entry = counts.get(key) ?? { name, count: 0, ...(artist !== undefined ? { artist } : {}) };
      entry.count += 1;
      counts.set(key, entry);
    }
    const words = fold(options.q ?? "").split(/\s+/).filter(Boolean);
    const groups = [...counts.values()]
      .filter((one) => words.every((word) => fold(`${one.name} ${one.artist ?? ""}`).includes(word)))
      .sort((a, b) => compareNames(a.name, b.name));
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    return { groups: groups.slice(offset, offset + limit), total: groups.length };
  }

  /** How the player should name each file it already has, from what is known. */
  tracksFor(paths: string[]): Track[] {
    const out: Track[] = [];
    for (const path of paths) {
      const item = this.itemAt(path);
      if (!item || item.state !== "ready") continue;
      out.push(trackOf(item));
    }
    return out;
  }

  counts(): Record<ItemState, number> {
    const totals: Record<ItemState, number> = { pending: 0, ready: 0, unsupported: 0, failed: 0, unavailable: 0 };
    for (const item of this.items.values()) totals[item.state] += 1;
    return totals;
  }
}

/** A library item as the player's Track. */
export function trackOf(item: LibraryItem): Track {
  const tags = shown(item);
  return { path: item.path, title: tags.title, artist: tags.artist, album: tags.album, duration: item.duration };
}

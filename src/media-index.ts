/**
 * The files this machine has told nixamp.com about, and when to look again.
 *
 * nixamp.com keeps the record (media.ts); the bytes stay here. So whether a
 * file has changed is a question only this machine can answer, and it
 * answers it on a schedule that follows the file: a quarter of the time
 * since it last changed, never more often than every quarter of an hour
 * and never less often than monthly (see checkInterval). Looking is one
 * stat. Only a file whose size or modification time moved is hashed
 * again, and a new hash is a new record on nixamp.com, with the old one
 * told what it became.
 *
 * The index is a JSON file beside the daemon's other state. The CLI adds
 * to it when it hashes or transcribes a file, the server when it captions
 * one, and the server's watcher reads it every few minutes for what is
 * due. Written whole and renamed into place, so two of them writing at
 * once lose an entry at worst, never the file.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./daemon.ts";
import { checkInterval } from "./media.ts";

export interface IndexedFile {
  /** The SHA-256 hex nixamp.com knows it by. */
  id: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
  checkedAt: number;
  checkAfter: number;
}

export interface IndexFile {
  version: 1;
  files: Record<string, IndexedFile>;
}

export function indexPath(): string {
  return process.env["NIXAMP_MEDIA_INDEX"] ?? join(stateDir(), "media.json");
}

export function readIndex(path = indexPath()): IndexFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexFile>;
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") return { version: 1, files: parsed.files };
  } catch {
    // No index yet, or one this cannot read: start again.
  }
  return { version: 1, files: {} };
}

export function writeIndex(index: IndexFile, path = indexPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(index, null, 2));
  renameSync(temp, path);
}

/** Note a file this machine has told nixamp.com about, with when to look at it next. */
export function remember(file: string, entry: { id: string; fingerprint: string; size: number; mtimeMs: number }, now = Date.now(), path = indexPath()): IndexedFile {
  const index = readIndex(path);
  const kept: IndexedFile = { ...entry, checkedAt: now, checkAfter: now + checkInterval(entry.mtimeMs, now) };
  index.files[file] = kept;
  writeIndex(index, path);
  return kept;
}

/** The files whose turn it is. */
export function due(index: IndexFile, now = Date.now()): string[] {
  return Object.entries(index.files).filter(([, one]) => one.checkAfter <= now).map(([file]) => file);
}

export type Looked =
  | { state: "same"; entry: IndexedFile }
  | { state: "changed"; entry: IndexedFile; size: number; mtimeMs: number }
  | { state: "gone" };

/**
 * One look at a file: the same as it was, changed, or gone. Nothing is
 * hashed here; the caller hashes a changed file, since that is the part
 * that costs, and then remembers the new record.
 */
export function look(file: string, entry: IndexedFile, now = Date.now()): Looked {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(file);
  } catch {
    return { state: "gone" };
  }
  if (stat.size === entry.size && Math.floor(stat.mtimeMs) === Math.floor(entry.mtimeMs)) {
    return { state: "same", entry: { ...entry, checkedAt: now, checkAfter: now + checkInterval(entry.mtimeMs, now) } };
  }
  return { state: "changed", entry, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** How often the watcher reads the index for what is due. */
export const WATCH_EVERY_MS = 10 * 60 * 1000;

export interface WatchOptions {
  path?: string;
  now?: () => number;
  /** Hash the changed file, tell nixamp.com, and answer the new entry; null when it could not. */
  refresh: (file: string, before: IndexedFile, stat: { size: number; mtimeMs: number }) => Promise<{ id: string; fingerprint: string } | null>;
  onEvent?: (message: string) => void;
}

/**
 * One pass over what is due. Files that are the same are pushed out to
 * their next check; changed ones are refreshed; gone ones are forgotten.
 * Answers how many of each, for the log.
 */
export async function watchOnce(options: WatchOptions): Promise<{ same: number; changed: number; gone: number }> {
  const now = options.now ?? Date.now;
  const path = options.path ?? indexPath();
  const index = readIndex(path);
  const counts = { same: 0, changed: 0, gone: 0 };
  for (const file of due(index, now())) {
    const entry = index.files[file];
    if (!entry) continue;
    const looked = look(file, entry, now());
    if (looked.state === "gone") {
      delete index.files[file];
      counts.gone += 1;
      continue;
    }
    if (looked.state === "same") {
      index.files[file] = looked.entry;
      counts.same += 1;
      continue;
    }
    const fresh = await options.refresh(file, entry, { size: looked.size, mtimeMs: looked.mtimeMs });
    const at = now();
    if (fresh) {
      index.files[file] = { ...fresh, size: looked.size, mtimeMs: looked.mtimeMs, checkedAt: at, checkAfter: at + checkInterval(looked.mtimeMs, at) };
      counts.changed += 1;
      options.onEvent?.(`${file} changed: now sha256:${fresh.id.slice(0, 12)} (was ${entry.id.slice(0, 12)})`);
    } else {
      // Could not say; ask again in a quarter of an hour rather than never.
      index.files[file] = { ...entry, checkedAt: at, checkAfter: at + 15 * 60 * 1000 };
    }
  }
  writeIndex(index, path);
  return counts;
}

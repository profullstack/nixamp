/**
 * A file on this machine, described for nixamp.com's record of it.
 *
 * The same few steps whoever meets the file: hash every byte (the OpenFile
 * id), take the quick fingerprint (the transcript key), ask ffprobe what is
 * inside, ask nichedb what it is, note where it is being carried, and say
 * when this machine will look at it again. `nixamp hash` does it for a
 * file you name, `nixamp transcribe` for the one it is writing down, and a
 * server for a file it puts on the air. A file that changed since the
 * machine last looked is described again as a new record, and the two
 * records point at each other.
 */
import { basename, extname } from "node:path";
import { codecsOf, type Tools } from "./audio.ts";
import type { Enricher } from "./enrich.ts";
import { checkInterval, contentHash, factsFrom, fileFacts, type Holder, type MediaFacts } from "./media.ts";
import { remember, type IndexedFile } from "./media-index.ts";
import { keepMedia, type MediaToKeep, type Signed } from "./transcript-client.ts";
import { fileFingerprint } from "./transcripts.ts";

export interface Described {
  id: string;
  fingerprint: string;
  size: number;
  mtimeMs: number;
  keep: MediaToKeep;
}

export interface DescribeDeps {
  /** ffprobe, for what is inside. Absent: only what the filesystem says. */
  tools?: Tools | null;
  enricher?: Pick<Enricher, "lookup"> | null;
  holder?: Holder | null;
  now?: () => number;
  /** The tests hand in fakes for the two things that cost. */
  hash?: (path: string) => Promise<string>;
  fingerprint?: (path: string) => string;
}

/** Everything this machine can say about a file, ready to keep. */
export async function describeFile(path: string, deps: DescribeDeps = {}): Promise<Described> {
  const now = deps.now ?? Date.now;
  const file = fileFacts(path);
  const id = await (deps.hash ?? contentHash)(path);
  const fingerprint = (deps.fingerprint ?? fileFingerprint)(path);
  const codecs = deps.tools && deps.tools.carries !== false ? await codecsOf(deps.tools, path) : null;
  const name = codecs?.tags?.title || basename(path, extname(path));
  let enriched = null;
  try {
    enriched = deps.enricher ? await deps.enricher.lookup(name) : null;
  } catch {
    enriched = null;
  }
  const at = now();
  const facts: MediaFacts = {
    ...factsFrom(codecs, enriched),
    fingerprint,
    checkedAt: new Date(at).toISOString(),
    checkAfter: new Date(at + checkInterval(file.mtimeMs, at)).toISOString(),
  };
  return {
    id,
    fingerprint,
    size: file.size,
    mtimeMs: file.mtimeMs,
    keep: {
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      updated: file.updated,
      facts: facts as Record<string, unknown>,
      ...(deps.holder ? { holder: deps.holder } : {}),
    },
  };
}

/** Keep a described file on nixamp.com and in this machine's index. Answers the store's sentence when it refused. */
export async function keepFile(
  signed: Signed,
  path: string,
  described: Described,
  deps: { fetcher?: typeof fetch; index?: string; now?: () => number } = {},
): Promise<string | null> {
  const got = await keepMedia(signed, described.id, described.keep, deps.fetcher ?? fetch);
  if (!got.ok) return got.error;
  try {
    remember(path, { id: described.id, fingerprint: described.fingerprint, size: described.size, mtimeMs: described.mtimeMs }, (deps.now ?? Date.now)(), deps.index);
  } catch {
    // The index is a convenience; the record is what matters.
  }
  return null;
}

/**
 * A file that changed since it was last described: described again as a
 * new record that says what it was, while the old record says what it
 * became. Answers the new identity, or null when nixamp.com would not
 * keep it.
 */
export async function refreshChanged(
  signed: Signed,
  path: string,
  before: Pick<IndexedFile, "id">,
  deps: DescribeDeps & { fetcher?: typeof fetch; index?: string } = {},
): Promise<{ id: string; fingerprint: string } | null> {
  const described = await describeFile(path, deps);
  if (described.id === before.id) {
    // Touched but not changed: the same bytes, a new modification time.
    const failed = await keepFile(signed, path, described, deps);
    return failed ? null : { id: described.id, fingerprint: described.fingerprint };
  }
  described.keep.facts = { ...(described.keep.facts ?? {}), supersedes: `sha256:${before.id}` };
  const failed = await keepFile(signed, path, described, deps);
  if (failed) return null;
  await keepMedia(signed, before.id, { facts: { supersededBy: `sha256:${described.id}` } }, deps.fetcher ?? fetch);
  return { id: described.id, fingerprint: described.fingerprint };
}

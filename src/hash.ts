/**
 * `nixamp hash` -- one address for a file: nixamp.com/hash/<sha256>.
 *
 * Hashes every byte, says the address, and unless told not to tells
 * nixamp.com what this machine knows about the file (media-local.ts) so
 * the address answers with it: what is inside, what nichedb says it is,
 * and, once `nixamp transcribe` or a server has been at it, the
 * transcript in every language. The file goes into this machine's index
 * too, so the daemon looks at it again on a schedule and a changed file
 * gets a new address that points back at this one.
 */
import { detectTools } from "./audio.ts";
import { Enricher } from "./enrich.ts";
import { describeFile, keepFile, type Described } from "./media-local.ts";
import { readSession, type Session } from "./session.ts";
import { fetchMedia } from "./transcript-client.ts";

const HELP = `nixamp hash — one address for a file.

  nixamp hash FILE [FILE...]        sha256, and nixamp.com/hash/<sha256>, kept there with what is known
  nixamp hash FILE --no-keep        the hash and the address only; nothing sent
  nixamp hash FILE --json           the record as nixamp.com keeps it
  nixamp hash --get ID              what nixamp.com knows about a file, by hash or fingerprint

The address is the SHA-256 of the file's bytes, the way OpenFile
(logicsrc.com/docs/openfile) names a file, so the same file on two
machines is one page. What is kept: the size, the type, when the file last
changed, what ffprobe found inside, what nichedb.dev says it is, where it
has been carried, and its transcripts. Keeping needs a sign-in
(\`nixamp login\`); the hash needs nothing.
`;

export interface HashDeps {
  fetcher?: typeof fetch;
  session?: Pick<Session, "site" | "token"> | null;
  describe?: (path: string) => Promise<Described>;
  index?: string;
  now?: () => number;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The site an address is printed for: the session's, or nixamp.com. */
function siteOf(session: Pick<Session, "site"> | null): string {
  return (session?.site ?? "https://nixamp.com").replace(/\/+$/, "");
}

export async function hash(argv: string[], deps: HashDeps = {}): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(HELP);
    return argv.length === 0 ? 64 : 0;
  }
  const session = deps.session === undefined ? readSession() : deps.session;
  const fetcher = deps.fetcher ?? fetch;
  const asJson = argv.includes("--json");
  const site = siteOf(session);

  const get = flag(argv, "--get");
  if (argv.includes("--get")) {
    if (!get) {
      console.error("nixamp: --get needs the file's hash, or its fingerprint.");
      return 64;
    }
    const got = await fetchMedia(site, get, fetcher);
    if (!got.ok) {
      console.error(`nixamp: ${got.error}`);
      return 1;
    }
    if (asJson) console.log(JSON.stringify(got.body, null, 2));
    else console.log(describeRecord(got.body));
    return 0;
  }

  const files = argv.filter((one, at) => !one.startsWith("-") && !(at > 0 && argv[at - 1] === "--get"));
  if (files.length === 0) {
    console.error("nixamp: which file? `nixamp hash film.mkv`.");
    return 64;
  }
  const keep = !argv.includes("--no-keep");
  if (keep && session === null) console.error("nixamp: not signed in, so nothing is kept; `nixamp login` to keep the record. The hash still is:");
  let tools: ReturnType<typeof detectTools> | null = null;
  let enricher: Enricher | null = null;
  const describe = deps.describe ?? (async (path: string) => {
    tools ??= detectTools();
    enricher ??= new Enricher();
    return describeFile(path, { tools, enricher, now: deps.now });
  });
  let failed = 0;
  const records: unknown[] = [];
  for (const file of files) {
    let described: Described;
    try {
      described = await describe(file);
    } catch (error) {
      console.error(`nixamp: ${file}: ${(error as Error).message}`);
      failed += 1;
      continue;
    }
    let record: Record<string, unknown> | null = null;
    if (keep && session) {
      const refused = await keepFile({ site: session.site, token: session.token }, file, described, { fetcher, ...(deps.index ? { index: deps.index } : {}), ...(deps.now ? { now: deps.now } : {}) });
      if (refused) {
        console.error(`nixamp: ${file}: not kept: ${refused}`);
        failed += 1;
      } else if (asJson) {
        const got = await fetchMedia(site, described.id, fetcher);
        record = got.ok ? got.body : null;
      }
    }
    if (asJson) {
      records.push(record ?? { id: `sha256:${described.id}`, name: described.keep.name, url: `${site}/hash/${described.id}`, nixamp: described.keep.facts });
    } else {
      console.log(`sha256:${described.id}  ${described.keep.name ?? file}\n  ${site}/hash/${described.id}${keep && session ? "" : "  (not kept)"}`);
    }
  }
  if (asJson) console.log(JSON.stringify(records.length === 1 ? records[0] : records, null, 2));
  return failed > 0 ? 1 : 0;
}

/** A record as the terminal prints it. */
export function describeRecord(record: Record<string, unknown>): string {
  const nixamp = (record["nixamp"] ?? {}) as Record<string, unknown>;
  const lines = [`${record["name"] ?? ""}  ${record["id"] ?? ""}`, `  ${record["url"] ?? ""}`];
  if (typeof record["size"] === "number") lines.push(`  size: ${record["size"]} bytes${record["contentType"] ? `, ${record["contentType"]}` : ""}`);
  if (typeof nixamp["duration"] === "number") lines.push(`  length: ${Math.round(nixamp["duration"] as number)} s`);
  const enrichment = nixamp["enrichment"] as { title?: string; year?: number | null } | undefined;
  if (enrichment?.title) lines.push(`  nichedb: ${enrichment.title}${enrichment.year ? ` (${enrichment.year})` : ""}`);
  if (record["updated"]) lines.push(`  file changed: ${record["updated"]}`);
  if (nixamp["checkAfter"]) lines.push(`  next check: ${nixamp["checkAfter"]}`);
  const holders = (record["holders"] ?? []) as { url: string; channel?: string; seenAt: string }[];
  for (const holder of holders) lines.push(`  carried by ${holder.url}${holder.channel ? ` as ${holder.channel}` : ""} at ${holder.seenAt}`);
  const transcripts = (nixamp["transcripts"] ?? []) as { language: string; translatedFrom: string | null; lines: number; complete: boolean; url: string }[];
  for (const one of transcripts) lines.push(`  transcript ${one.language || "as spoken"}${one.translatedFrom ? ` (from ${one.translatedFrom})` : ""}: ${one.lines} lines${one.complete ? "" : " so far"}  ${one.url}`);
  if (nixamp["supersededBy"]) lines.push(`  became: ${nixamp["supersededBy"]}`);
  return lines.join("\n");
}

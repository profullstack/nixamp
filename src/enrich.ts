/**
 * What is this, really?
 *
 * A file called "Top.Gun.Maverick.2022.1080p.WEB-DL.mkv" is a film with a
 * poster, a year and a rating; a playlist entry called "US: ESPN2 HD" is a
 * channel with a logo, a country and a category; "Lakers at Celtics" is a
 * fixture with a score. nixamp knows none of that on its own -- ffprobe reads
 * tags, and a torrent's tags are its file name -- so it asks nichedb.dev,
 * which keeps the titles, channels and fixtures every profullstack site is
 * built on, and answers a name with the best match and a score.
 *
 * Asked once per name and remembered: a library of five thousand files must
 * not become five thousand requests a day, and a channel that was ESPN2
 * yesterday is ESPN2 today. Misses are remembered too, for less long, so a
 * file nichedb has never heard of is not asked about every time it plays.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMatchupName } from "./matchup.ts";

export { isMatchupName };

/** Where the answers come from, unless a deployment says otherwise. */
export const DEFAULT_SITE = "https://nichedb.dev";
/** How long a hit is believed. Titles and channels change on the order of months. */
export const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a miss is believed: nichedb's catalogue is still filling in. */
export const MISS_TTL_MS = 6 * 60 * 60 * 1000;
/** A fixture's score is stale in a minute. */
export const FIXTURE_TTL_MS = 60 * 1000;
/**
 * Below this the best match is a guess, and a wrong poster is worse than none.
 * Measured: "Severance" against a channel called "Sever" scored 0.45, and
 * "Lakers at Celtics" against "Rangers at Celtic" 0.44. Half is above both.
 */
export const MIN_SCORE = 0.5;
/** A weaker score is still taken when one name plainly begins with the other. */
export const PREFIX_SCORE = 0.42;
/** How many answers the cache keeps before the oldest go. */
export const MAX_ENTRIES = 5000;
/**
 * Which rules wrote the cache. Answers chosen by older rules are dropped on
 * load: 0.11.0 remembered "Oppenheimer" as the row without the poster for
 * seven days, and an update that chose better could not be seen through it.
 */
export const CACHE_VERSION = 2;

export type EnrichKind = "auto" | "title" | "channel" | "fixture";

export interface Enriched {
  /** What nichedb says it is. */
  kind: "title" | "channel" | "fixture";
  title: string;
  /** For a title, its year; for a fixture, when it starts. */
  year: number | null;
  /** A poster, a logo, or nothing. */
  image: string | null;
  summary: string | null;
  /** nichedb's page for it, for a link. */
  page: string;
  score: number;
  /** The rest, as the collection shapes it: rating, genres, country, scores… */
  data: Record<string, unknown>;
  tags: string[];
}

interface Cached {
  at: number;
  hit: Enriched | null;
}

/** nichedb's answer to /api/v1/match, as much of it as is read here. */
interface MatchAnswer {
  parsed?: { name?: string; year?: number | null; kind?: string; season?: number | null; episode?: number | null };
  items?: {
    kind?: string;
    title?: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: string | null;
    page?: string;
    score?: number;
    data?: Record<string, unknown>;
    tags?: string[];
  }[];
}

/** The collection and kind a name is asked about, from what the caller knows. */
export function whereToAsk(kind: EnrichKind, parsedKind?: string): { collection: string; kind: string } | null {
  const k = kind === "auto" ? parsedKind ?? "" : kind;
  switch (k) {
    case "channel":
      return { collection: "channels", kind: "channel" };
    case "fixture":
      return { collection: "sports", kind: "fixture" };
    case "title":
    case "movie":
    case "series":
      return { collection: "screen", kind: "title" };
    default:
      // Music and the rest: nichedb has no answer worth a poster yet.
      return null;
  }
}

/** The key one name is remembered under: case and spacing do not make it a different name. */
export function cacheKey(name: string, kind: EnrichKind, year: number | null): string {
  return `${kind}|${year ?? ""}|${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Whether a stored answer is still worth believing. */
export function fresh(entry: Cached, now: number): boolean {
  const ttl = entry.hit === null ? MISS_TTL_MS : entry.hit.kind === "fixture" ? FIXTURE_TTL_MS : HIT_TTL_MS;
  return now - entry.at < ttl;
}

/** The best of nichedb's answers, or nothing when the best is a guess. */
export function pickBest(answer: MatchAnswer, asked: string): Enriched | null {
  const items = answer.items ?? [];
  const wanted = asked.trim().toLowerCase();
  type Item = NonNullable<MatchAnswer["items"]>[number];
  let best: Item | undefined;
  const isExact = (item: Item | undefined): boolean =>
    item !== undefined && String(item.title ?? "").toLowerCase() === wanted;
  const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const askedPlain = plain(wanted);
  // nichedb keeps every meeting of two teams under the same title: the one
  // being played now outranks the one next month, which outranks last year's.
  const stateRank = (item: Item | undefined): number => {
    if (item?.kind !== "fixture") return 1;
    const state = String(item.data?.["state"] ?? item.tags?.find((t) => t.startsWith("state:"))?.slice(6) ?? "");
    return state === "in" ? 0 : state === "pre" ? 1 : state === "post" ? 2 : 1;
  };
  for (const item of items) {
    const exact = isExact(item);
    const score = Number(item.score ?? 0);
    const titlePlain = plain(String(item.title ?? ""));
    // Whole words: "Top Gun Maverick Extended" begins with "Top Gun Maverick",
    // but "Severance" does not begin with a channel called "Sever".
    const prefix =
      titlePlain.length >= 4 &&
      askedPlain.length >= 4 &&
      (askedPlain.startsWith(`${titlePlain} `) || titlePlain.startsWith(`${askedPlain} `));
    if (!exact && score < (prefix ? PREFIX_SCORE : MIN_SCORE)) continue;
    // An exact title beats any score; among exact titles the one with a
    // picture wins, since nichedb keeps both the IMDb row and the TMDB row of
    // a film and only one has the poster; among the rest, the score decides.
    if (!best) best = item;
    else if (exact && !isExact(best)) best = item;
    else if (exact && isExact(best) && stateRank(item) < stateRank(best)) best = item;
    else if (exact && isExact(best) && stateRank(item) === stateRank(best) && !best.image_url && item.image_url) best = item;
    else if (!isExact(best) && score > Number(best.score ?? 0)) best = item;
    else if (!isExact(best) && score === Number(best.score ?? 0) && stateRank(item) < stateRank(best)) best = item;
  }
  if (!best) return null;
  const kind = best.kind === "channel" || best.kind === "fixture" ? best.kind : "title";
  const year = typeof best.data?.["year"] === "number"
    ? (best.data["year"] as number)
    : best.published_at
      ? new Date(best.published_at).getUTCFullYear() || null
      : null;
  return {
    kind,
    title: String(best.title ?? ""),
    year: Number.isFinite(year) ? year : null,
    image: best.image_url ?? null,
    summary: best.summary ?? null,
    page: String(best.page ?? ""),
    score: Number(best.score ?? 0),
    data: best.data ?? {},
    tags: best.tags ?? [],
  };
}

export interface EnricherOptions {
  site?: string;
  fetch?: typeof globalThis.fetch;
  /** Where answers are kept between runs; none means memory only. */
  cacheFile?: string;
  now?: () => number;
  onEvent?: (message: string) => void;
}

export class Enricher {
  private readonly site: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<Enriched | null>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly options: EnricherOptions = {}) {
    this.site = (options.site ?? DEFAULT_SITE).replace(/\/+$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** How many names are remembered. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * What a name is, from the cache or from nichedb.
   *
   * `kind` narrows the question when the caller knows: a live channel is a
   * channel however its name reads. `auto` lets nichedb's parser decide from
   * the name itself, which is right for a file.
   */
  async lookup(name: string, kind: EnrichKind = "auto", year: number | null = null): Promise<Enriched | null> {
    const asked = String(name ?? "").trim();
    if (asked === "") return null;
    const key = cacheKey(asked, kind, year);
    const had = this.cache.get(key);
    if (had && fresh(had, this.now())) return had.hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.ask(asked, kind, year)
      .then((hit) => {
        this.remember(key, hit);
        return hit;
      })
      .catch((error: unknown) => {
        this.options.onEvent?.(`  nichedb did not answer for "${asked}": ${(error as Error).message}`);
        // Not remembered: a network fault is not a miss.
        return had?.hit ?? null;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async ask(name: string, kind: EnrichKind, year: number | null): Promise<Enriched | null> {
    // Two round trips at most: nichedb parses the name; when the caller did
    // not say what it is, the first answer's reading says where to look.
    const first = new URLSearchParams({ q: name, limit: "3" });
    if (year !== null) first.set("year", String(year));
    const where = whereToAsk(kind);
    if (where) {
      first.set("collection", where.collection);
      first.set("kind", where.kind);
    }
    // Two sides with "vs" or "@" between them are a fixture until nichedb's
    // sports collection says it has none: nichedb's parser reads a name, and
    // "Chiefs vs Bills" reads as a title to a parser that expects films.
    if (kind === "auto" && isMatchupName(name)) {
      const fixture = new URLSearchParams(first);
      fixture.set("collection", "sports");
      fixture.set("kind", "fixture");
      const hit = pickBest(await this.get(`/api/v1/match?${fixture}`), name);
      if (hit && hit.kind === "fixture" && hit.score >= MIN_SCORE) return hit;
    }
    const answer = await this.get(`/api/v1/match?${first}`);
    if (where) return pickBest(answer, answer.parsed?.name ?? name);
    // nichedb reads "Alien vs Predator" as a game too. Once the sports
    // collection has said it has none, the name is a title after all.
    let parsedKind = answer.parsed?.kind;
    if (parsedKind === "fixture") {
      if (!isMatchupName(name)) {
        const fixture = new URLSearchParams(first);
        fixture.set("collection", "sports");
        fixture.set("kind", "fixture");
        const hit = pickBest(await this.get(`/api/v1/match?${fixture}`), name);
        if (hit && hit.kind === "fixture" && hit.score >= MIN_SCORE) return hit;
      }
      parsedKind = "title";
    }
    const guessed = whereToAsk("auto", parsedKind);
    if (!guessed) return null;
    const second = new URLSearchParams(first);
    second.set("collection", guessed.collection);
    second.set("kind", guessed.kind);
    // The year the name carried narrows the second question.
    if (year === null && answer.parsed?.year) second.set("year", String(answer.parsed.year));
    return pickBest(await this.get(`/api/v1/match?${second}`), answer.parsed?.name ?? name);
  }

  private async get(path: string): Promise<MatchAnswer> {
    const response = await this.fetcher(`${this.site}${path}`, {
      headers: { accept: "application/json", "user-agent": "nixamp (+https://nixamp.com)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`nichedb answered ${response.status}`);
    return (await response.json()) as MatchAnswer;
  }

  private remember(key: string, hit: Enriched | null): void {
    this.cache.set(key, { at: this.now(), hit });
    if (this.cache.size > MAX_ENTRIES) {
      // Oldest first: a Map remembers insertion order.
      const drop = this.cache.size - MAX_ENTRIES;
      let n = 0;
      for (const k of this.cache.keys()) {
        if (n++ >= drop) break;
        this.cache.delete(k);
      }
    }
    this.dirty = true;
    this.scheduleSave();
  }

  private load(): void {
    if (!this.options.cacheFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.options.cacheFile, "utf8")) as {
        v?: number;
        entries?: Record<string, Cached>;
      };
      // A file from older rules is a file of answers those rules chose.
      if (parsed.v !== CACHE_VERSION) return;
      for (const [k, v] of Object.entries(parsed.entries ?? {})) {
        if (v && typeof v.at === "number") this.cache.set(k, v);
      }
    } catch {
      // No cache yet, or one that is not JSON: start empty.
    }
  }

  private scheduleSave(): void {
    if (!this.options.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  /** Write the cache now. Called on a timer, and by whoever is shutting down. */
  save(): void {
    if (!this.options.cacheFile || !this.dirty) return;
    try {
      mkdirSync(dirname(this.options.cacheFile), { recursive: true });
      const tmp = `${this.options.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, entries: Object.fromEntries(this.cache) }));
      renameSync(tmp, this.options.cacheFile);
      this.dirty = false;
    } catch (error) {
      this.options.onEvent?.(`  could not save the enrichment cache: ${(error as Error).message}`);
    }
  }
}

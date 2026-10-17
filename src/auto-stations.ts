/**
 * Auto stations: a station for every genre the library has, kept up to date.
 *
 * Radio from the music's own genre tags, folded into genres a listener would
 * recognise ("Rap/Hip-Hop", "Hip Hop" and "Gangsta" are all Hip-Hop; "Pop,
 * Rock, Metal" is in three). TV from the genres nichedb knows for each film.
 * Lectures, interviews and talk are not music and stay out of radio.
 *
 * Each genre's station is found again by its key on the next sync and its
 * files replaced, so new music lands in the right station by itself and a
 * station's link never changes. Nothing is published: an auto station is
 * unlisted, a link for whoever the owner hands it to. Making one public is
 * the owner's decision, with the rights basis that asks for.
 *
 * TV costs a core per running station (it is re-encoded), so only the
 * biggest few run; the rest are made and wait, stopped.
 */
import type { LibraryIndex, LibraryItem } from "./library-index.ts";
import { shown } from "./library-index.ts";
import type { StationRunner } from "./station-runner.ts";
import type { Station, StationStore } from "./stations.ts";

const RULES: Array<[RegExp, string]> = [
  [/metal|thrash|trash|doom|death|grind|neue deutsche|h(a|ä)rte|djent|metalcore/i, "Metal"],
  [/punk|hardcore|emo|screamo/i, "Punk"],
  [/hip.?hop|\brap\b|gangsta|trap|grime|drill/i, "Hip-Hop"],
  [/industrial/i, "Industrial"],
  [/electro|techno|house|edm|dance|trance|ambient|drum.?n.?bass|dubstep|synth/i, "Electronic"],
  [/reggae|\bska\b|\bdub\b|dancehall/i, "Reggae"],
  [/jazz|swing|bebop/i, "Jazz"],
  [/blues/i, "Blues"],
  [/classical|symphon|orchestr|baroque|opera/i, "Classical"],
  [/country|folk|bluegrass|americana/i, "Country & Folk"],
  [/soul|r&b|rnb|funk|motown|gospel/i, "Soul & R&B"],
  [/latin|reggaeton|salsa|bachata|cumbia/i, "Latin"],
  [/alternat|indie|ind(e|é)|grunge|shoegaze/i, "Alternative"],
  [/rock/i, "Rock"],
  [/pop/i, "Pop"],
];

const NOT_MUSIC = /lecture|interview|audiobook|podcast|speech|spoken|talk|course|sermon|lesson|comedy/i;

/** Never on a genre TV station, whatever nichedb calls it. */
const ADULT = /\b(xxx|porn|nsfw|onlyfans|brazzers|blacked|bangbros|milf|hentai|sex|erotic|adult)\b/i;

export function adultTitle(title: string, genres: string[] = []): boolean {
  return ADULT.test(title) || genres.some((one) => /adult|erotic|porn/i.test(one));
}

/** The genres a tag belongs to, recognisably named; [] when it is not music or not known. */
export function genreBuckets(raw: string): string[] {
  if (!raw || NOT_MUSIC.test(raw)) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[,;/|]+|\s+&\s+/)) {
    const hit = RULES.find(([pattern]) => pattern.test(part));
    if (hit) out.add(hit[1]);
  }
  return [...out];
}

export interface AutoOptions {
  /** Radio from tags; TV from nichedb's genres. */
  video: boolean;
  /** A genre needs at least this many files (radio) to get a station. */
  minItems: number;
  /** Films for a TV station. */
  minFilms: number;
  start: boolean;
  /** TV stations running at once. */
  maxVideoRunning: number;
  /** Seconds between breaks on the stations this makes. */
  breaksEvery: number;
}

export const DEFAULT_AUTO: AutoOptions = { video: true, minItems: 10, minFilms: 3, start: true, maxVideoRunning: 2, breaksEvery: 600 };

export interface AutoReport {
  radio: Array<{ genre: string; id: string; files: number; made: boolean; running: boolean }>;
  tv: Array<{ genre: string; id: string; films: number; made: boolean; running: boolean }>;
  skipped: string[];
}

export interface AutoDeps {
  index: LibraryIndex;
  store: StationStore;
  runner: StationRunner;
  owner: string;
  /** nichedb's genres for a film, from the enrichment cache or a lookup; [] when unknown. */
  filmGenres?: (title: string) => Promise<string[]>;
  /** Whether another station may be started now (the server's running limit). */
  mayStart: () => boolean;
  log?: (line: string) => void;
}

function order(items: LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) => {
    const x = shown(a), y = shown(b);
    return (x.albumArtist || x.artist).localeCompare(y.albumArtist || y.artist) || x.album.localeCompare(y.album) || x.disc - y.disc || x.track - y.track || a.rel.localeCompare(b.rel);
  });
}

async function upsert(
  deps: AutoDeps,
  key: string,
  name: string,
  paths: string[],
  video: boolean,
  options: AutoOptions,
): Promise<{ station: Station; made: boolean }> {
  const existing = deps.store.byAuto(key);
  if (existing) {
    const same = existing.items.length === paths.length && existing.items.every((one, at) => one === paths[at]);
    return { station: same ? existing : deps.store.update(existing.id, {}, paths), made: false };
  }
  const station = deps.store.create({ name, shuffle: true, repeat: true, video, breaksEvery: options.breaksEvery }, paths, deps.owner);
  deps.store.markAuto(station.id, key);
  // A link, not a listing: unlisted needs no rights basis and publishes nothing.
  deps.store.setAccess(station.id, { visibility: "unlisted" }, deps.owner || "auto");
  return { station, made: true };
}

/** Make or update a station per genre; start what the limits allow. */
export async function syncAutoStations(deps: AutoDeps, options: AutoOptions = DEFAULT_AUTO): Promise<AutoReport> {
  const report: AutoReport = { radio: [], tv: [], skipped: [] };
  const ready = deps.index.search({ state: "ready", limit: 500, offset: 0 });
  // search() pages at 500; walk them all.
  const all: LibraryItem[] = [...ready.items];
  for (let offset = 500; offset < ready.total; offset += 500) all.push(...deps.index.search({ state: "ready", limit: 500, offset }).items);

  const radio = new Map<string, LibraryItem[]>();
  for (const item of all) {
    if (item.video) continue;
    for (const genre of genreBuckets(shown(item).genre)) {
      const list = radio.get(genre) ?? [];
      list.push(item);
      radio.set(genre, list);
    }
  }
  for (const [genre, items] of [...radio].sort((a, b) => b[1].length - a[1].length)) {
    if (items.length < options.minItems) {
      report.skipped.push(`${genre} radio (${items.length} files)`);
      continue;
    }
    const { station, made } = await upsert(deps, `genre:audio:${genre.toLowerCase()}`, `${genre} Radio`, order(items).map((one) => one.path), false, options);
    let running = station.desired === "running";
    if (!running && options.start && deps.mayStart()) {
      await deps.runner.start(station.id).then(() => { running = true; }, (error: Error) => deps.log?.(`  auto stations: ${genre} Radio did not start: ${error.message}`));
    }
    report.radio.push({ genre, id: station.id, files: items.length, made, running });
  }

  if (options.video && deps.filmGenres) {
    const tv = new Map<string, LibraryItem[]>();
    for (const item of all) {
      if (!item.video || item.duration < 40 * 60) continue;
      const title = shown(item).title;
      const genres = await deps.filmGenres(title).catch(() => []);
      if (adultTitle(`${title} ${item.rel}`, genres)) continue;
      for (const genre of genres.slice(0, 2)) {
        const list = tv.get(genre) ?? [];
        list.push(item);
        tv.set(genre, list);
      }
    }
    let runningTv = deps.store.list().filter((one) => one.video && one.auto && one.desired === "running").length;
    for (const [genre, films] of [...tv].sort((a, b) => b[1].length - a[1].length)) {
      if (films.length < options.minFilms) {
        report.skipped.push(`${genre} TV (${films.length} films)`);
        continue;
      }
      const { station, made } = await upsert(deps, `genre:video:${genre.toLowerCase()}`, `${genre} TV`, films.map((one) => one.path), true, options);
      let running = station.desired === "running";
      if (!running && options.start && runningTv < options.maxVideoRunning && deps.mayStart()) {
        await deps.runner.start(station.id).then(() => { running = true; runningTv += 1; }, (error: Error) => deps.log?.(`  auto stations: ${genre} TV did not start: ${error.message}`));
      }
      report.tv.push({ genre, id: station.id, films: films.length, made, running });
    }
  }
  return report;
}

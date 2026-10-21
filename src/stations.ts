/**
 * Stations: a collection turned into a program that keeps playing.
 *
 * A channel is a running decoder, named for what it plays, and gone when it
 * stops. A station is the thing a person made and named: which files, in what
 * rotation, who may hear it, and whether it should be on. Its id is random
 * and never changes, so its link survives a rename, a restart, a moved file
 * and a renderer that died; the channel it plays through (`station-<id>`) is
 * only how it happens to be delivered right now.
 *
 * Two states, kept apart. `desired` is what the owner asked for and is
 * written down; a station deliberately stopped stays stopped after a restart,
 * and one left running comes back. `observed` is what is actually happening
 * and is never written down, because it is only true now.
 *
 * Who may listen is the station's own business, not the server's. A new
 * station is private, stopped and unlisted. Its listen token opens its stream,
 * its now-playing and its picture, and nothing of the library behind it.
 * Listing it in the public directory is a separate choice from making it
 * public, and making it public asks first on what basis it may be broadcast.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export type Visibility = "private" | "unlisted" | "public";
export type Desired = "running" | "stopped";
export type Observed = "stopped" | "starting" | "live" | "recovering" | "offline";

/** Why the owner may broadcast this publicly. A declaration, not a clearance. */
export type RightsBasis = "owned" | "permission" | "licensed" | "public-domain";
export const RIGHTS_BASES: readonly RightsBasis[] = ["owned", "permission", "licensed", "public-domain"];

export interface Rights {
  basis: RightsBasis;
  note: string;
  declaredAt: number;
  declaredBy: string;
}

export interface Station {
  id: string;
  name: string;
  description: string;
  /** Files on this machine, absolute, in the station's own order. */
  items: string[];
  shuffle: boolean;
  repeat: boolean;
  visibility: Visibility;
  /** In the public directory. Only a public station can be. */
  listed: boolean;
  desired: Desired;
  /** Opens this station's stream and nothing else. Rotated to revoke a link. */
  listenToken: string;
  /** Audio bitrate of the station's rendition, in kbps. */
  bitrate: number;
  /** A TV station: pictures as well as sound. */
  video: boolean;
  /** A break (advert or ident) at most this often, in seconds; 0 for none. */
  breaksEvery: number;
  /** Made and kept up to date by auto stations (e.g. "genre:audio:rock"); "" for one a person made. */
  auto: string;
  rights: Rights | null;
  /** nixamp.com account that made it, "" when made with the control key. */
  owner: string;
  /** Files that would not play, and how many times in a row. */
  failures: Record<string, number>;
  /** What the caller said made this one, so asking twice makes it once. */
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

/** Times an item may fail in a row before rotation leaves it out. */
export const EXCLUDE_AFTER = 3;
export const DEFAULT_BITRATE = 128;
/** Seconds between breaks on a new station that did not say. */
export const DEFAULT_BREAKS_EVERY = 600;
export const BITRATES = [64, 96, 128, 160, 192, 256, 320];
const MAX_ITEMS = 20_000;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;

/** A station's channel id. */
export function channelOf(id: string): string {
  return `station-${id}`;
}

/** The station a channel id belongs to, or "" for any other channel. */
export function stationOfChannel(channelId: string): string {
  return channelId.startsWith("station-") ? channelId.slice("station-".length) : "";
}

function newId(): string {
  // Ten characters of base32: short enough to read out, far too many to guess.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(10)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function newToken(): string {
  return randomBytes(16).toString("base64url");
}

export function tokensMatch(offered: string, held: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(held);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A path inside one of these roots, after symlinks: never outside the library. */
export function insideRoots(path: string, roots: string[]): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  return roots.some((root) => {
    let base: string;
    try {
      base = realpathSync(root);
    } catch {
      return false;
    }
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

export class StationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export interface StationInput {
  name?: unknown;
  description?: unknown;
  items?: unknown;
  shuffle?: unknown;
  repeat?: unknown;
  bitrate?: unknown;
  video?: unknown;
  breaksEvery?: unknown;
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new StationError("invalid_" + field, `${field} must be text`);
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/** The stations of one server, kept in one file beside its keys. */
export class StationStore {
  private stations = new Map<string, Station>();

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
  ) {
    const body = this.io.read(file);
    if (body === null) return;
    try {
      const parsed = JSON.parse(body) as { stations?: Station[] };
      for (const one of parsed.stations ?? []) {
        if (one && typeof one.id === "string" && Array.isArray(one.items)) {
          this.stations.set(one.id, {
            ...one,
            failures: one.failures ?? {},
            bitrate: one.bitrate ?? DEFAULT_BITRATE,
            rights: one.rights ?? null,
            owner: one.owner ?? "",
            description: one.description ?? "",
            idempotencyKey: one.idempotencyKey ?? "",
            video: one.video ?? false,
            breaksEvery: one.breaksEvery ?? 0,
            auto: one.auto ?? "",
          });
        }
      }
    } catch {
      // A file that cannot be read is not a reason to refuse to serve. It is
      // left where it is, and the next write replaces it.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `stations-${port}.json`);
  }

  /** Told after every change is written (lyrics publishing listens). */
  onSaved: (() => void) | null = null;

  private save(): void {
    this.io.write(this.file, `${JSON.stringify({ version: 1, stations: [...this.stations.values()] }, null, 2)}\n`);
    try { this.onSaved?.(); } catch { /* a listener's trouble is not the store's */ }
  }

  list(): Station[] {
    return [...this.stations.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Station | undefined {
    return this.stations.get(id);
  }

  /** New, and always private, stopped and unlisted (RAD-02). */
  /** The station a create with this key already made. */
  byIdempotencyKey(key: string): Station | undefined {
    if (key === "") return undefined;
    return [...this.stations.values()].find((one) => one.idempotencyKey === key);
  }

  create(input: StationInput, items: string[], owner: string, now = Date.now(), idempotencyKey = ""): Station {
    const name = text(input.name ?? "", MAX_NAME, "name");
    if (name === "") throw new StationError("name_required", "a station needs a name");
    if (items.length === 0) throw new StationError("empty_station", "choose at least one file that plays");
    if (items.length > MAX_ITEMS) throw new StationError("too_many_items", `a station holds at most ${MAX_ITEMS} files`);
    const station: Station = {
      id: newId(),
      name,
      description: input.description === undefined ? "" : text(input.description, MAX_DESCRIPTION, "description"),
      items,
      shuffle: input.shuffle === true,
      repeat: input.repeat !== false,
      visibility: "private",
      listed: false,
      desired: "stopped",
      listenToken: newToken(),
      bitrate: this.bitrateFrom(input.bitrate),
      video: input.video === true,
      // On unless asked for none: a station is free to listen to, and the
      // spot is what pays for it. Signed-in listeners hear silence instead.
      breaksEvery: input.breaksEvery === undefined ? DEFAULT_BREAKS_EVERY : this.breaksFrom(input.breaksEvery),
      auto: "",
      rights: null,
      owner,
      failures: {},
      idempotencyKey: idempotencyKey.slice(0, 200),
      createdAt: now,
      updatedAt: now,
    };
    this.stations.set(station.id, station);
    this.save();
    return station;
  }

  private breaksFrom(value: unknown): number {
    if (value === undefined || value === null || value === 0) return 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 120 || value > 86_400) {
      throw new StationError("invalid_breaks", "breaksEvery is seconds between breaks, from 120 to 86400, or 0 for none");
    }
    return value;
  }

  /** Mark a station as made by auto stations, so a later sync updates it rather than making another. */
  markAuto(id: string, key: string): Station {
    const station = this.require(id);
    station.auto = key;
    this.save();
    return station;
  }

  byAuto(key: string): Station | undefined {
    return [...this.stations.values()].find((one) => one.auto === key);
  }

  private bitrateFrom(value: unknown): number {
    if (value === undefined) return DEFAULT_BITRATE;
    if (typeof value !== "number" || !BITRATES.includes(value)) {
      throw new StationError("invalid_bitrate", `bitrate is one of ${BITRATES.join(", ")} kbps`);
    }
    return value;
  }

  /** Name, words, files and rotation. Who may listen is changed by publish/unpublish. */
  update(id: string, input: StationInput, items: string[] | null, now = Date.now()): Station {
    const station = this.require(id);
    if (input.name !== undefined) {
      const name = text(input.name, MAX_NAME, "name");
      if (name === "") throw new StationError("name_required", "a station needs a name");
      station.name = name;
    }
    if (input.description !== undefined) station.description = text(input.description, MAX_DESCRIPTION, "description");
    if (input.shuffle !== undefined) station.shuffle = input.shuffle === true;
    if (input.repeat !== undefined) station.repeat = input.repeat !== false;
    if (input.bitrate !== undefined) station.bitrate = this.bitrateFrom(input.bitrate);
    if (input.breaksEvery !== undefined) station.breaksEvery = this.breaksFrom(input.breaksEvery);
    if (input.video !== undefined) station.video = input.video === true;
    if (items !== null) {
      if (items.length === 0) throw new StationError("empty_station", "a station needs at least one file that plays");
      if (items.length > MAX_ITEMS) throw new StationError("too_many_items", `a station holds at most ${MAX_ITEMS} files`);
      station.items = items;
      // A file taken out and put back is given another chance.
      station.failures = Object.fromEntries(Object.entries(station.failures).filter(([file]) => items.includes(file)));
    }
    station.updatedAt = now;
    this.save();
    return station;
  }

  remove(id: string): boolean {
    const had = this.stations.delete(id);
    if (had) this.save();
    return had;
  }

  setDesired(id: string, desired: Desired, now = Date.now()): Station {
    const station = this.require(id);
    station.desired = desired;
    station.updatedAt = now;
    this.save();
    return station;
  }

  /**
   * Who may hear it, and whether the directory lists it. Public needs a
   * declared basis; listed needs public. Going private mints a new token, so
   * every link handed out before stops working, and the caller drops the
   * listeners who used one.
   */
  setAccess(
    id: string,
    access: { visibility?: unknown; listed?: unknown; rights?: { basis?: unknown; note?: unknown } | null },
    by: string,
    now = Date.now(),
  ): { station: Station; revoked: boolean } {
    const station = this.require(id);
    const visibility = access.visibility === undefined ? station.visibility : access.visibility;
    if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
      throw new StationError("invalid_visibility", "visibility is private, unlisted or public");
    }
    let listed = access.listed === undefined ? station.listed : access.listed === true;
    if (visibility !== "public") listed = false;
    if (access.rights) {
      const basis = access.rights.basis;
      if (typeof basis !== "string" || !RIGHTS_BASES.includes(basis as RightsBasis)) {
        throw new StationError("invalid_rights_basis", `the basis is one of ${RIGHTS_BASES.join(", ")}`);
      }
      station.rights = {
        basis: basis as RightsBasis,
        note: access.rights.note === undefined ? "" : text(access.rights.note, MAX_DESCRIPTION, "note"),
        declaredAt: now,
        declaredBy: by,
      };
    }
    if (visibility === "public" && station.rights === null) {
      throw new StationError(
        "rights_required",
        "before a station is public, say on what basis it may be broadcast: owned, permission, licensed or public-domain",
        409,
      );
    }
    const revoked = visibility === "private" && station.visibility !== "private";
    station.visibility = visibility;
    station.listed = listed;
    if (revoked) station.listenToken = newToken();
    station.updatedAt = now;
    this.save();
    return { station, revoked };
  }

  /** A new listen link; every earlier one stops working. */
  rotateToken(id: string, now = Date.now()): Station {
    const station = this.require(id);
    station.listenToken = newToken();
    station.updatedAt = now;
    this.save();
    return station;
  }

  /** One more failure in a row for this file; true when it is now left out. */
  recordFailure(id: string, file: string): boolean {
    const station = this.stations.get(id);
    if (!station) return false;
    const count = (station.failures[file] ?? 0) + 1;
    station.failures[file] = count;
    this.save();
    return count === EXCLUDE_AFTER;
  }

  /** Played through: its failures are forgotten. */
  recordSuccess(id: string, file: string): void {
    const station = this.stations.get(id);
    if (!station || station.failures[file] === undefined) return;
    delete station.failures[file];
    this.save();
  }

  /** Every left-out file tried again (the owner's "retry"). */
  clearFailures(id: string): Station {
    const station = this.require(id);
    station.failures = {};
    this.save();
    return station;
  }

  isExcluded(id: string, file: string): boolean {
    return (this.stations.get(id)?.failures[file] ?? 0) >= EXCLUDE_AFTER;
  }

  private require(id: string): Station {
    const station = this.stations.get(id);
    if (!station) throw new StationError("not_found", "no such station", 404);
    return station;
  }
}

/** A station-wide shuffle: one order for everybody, Fisher-Yates. */
export function shuffled(length: number, random: () => number = Math.random): number[] {
  const order = [...Array(length).keys()];
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return order;
}

/**
 * A radio shuffle: the whole list in a random order, with no artist twice in
 * a row while another is left to play. A plain shuffle of a genre where a few
 * artists have whole albums kept playing one artist in series. Each pick is
 * an artist drawn by how many of their tracks are left, so the spread stays
 * even to the end, then one of that artist's tracks at random.
 */
export function spreadByArtist(files: readonly string[], artistOf: (file: string) => string, random: () => number = Math.random): number[] {
  const groups = new Map<string, number[]>();
  files.forEach((file, index) => {
    const key = artistOf(file).trim().toLowerCase();
    const group = groups.get(key);
    if (group) group.push(index); else groups.set(key, [index]);
  });
  const left = [...groups.entries()].map(([key, indexes]) => ({ key, indexes: shuffled(indexes.length, random).map((one) => indexes[one]!) }));
  const order: number[] = [];
  let last = "";
  let total = files.length;
  while (total > 0) {
    const others = left.filter((one) => one.indexes.length > 0 && one.key !== last);
    const pool = others.length > 0 ? others : left.filter((one) => one.indexes.length > 0);
    let pick = random() * pool.reduce((sum, one) => sum + one.indexes.length, 0);
    const group = pool.find((one) => (pick -= one.indexes.length) < 0) ?? pool[pool.length - 1]!;
    order.push(group.indexes.pop()!);
    last = group.key;
    total -= 1;
  }
  return order;
}

/**
 * Restart after an unexpected end: 2 s, doubling, at most a minute apart.
 * After the last of these the station is offline but still wanted, and is
 * tried again every OFFLINE_RETRY_MS so a source that comes back is found.
 */
export const RECOVERY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
export const OFFLINE_RETRY_MS = 5 * 60_000;

/** What a listener with the link may see. Never a path, never a token. */
export interface PublicStation {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  state: Observed;
  /** Radio or TV. */
  kind: "audio" | "video";
  nowPlaying: { title: string; artist: string; album: string } | null;
  format: { codec: string; bitrateKbps: number; sampleRate: number; channels: number } | null;
  listeners: number;
}

/** What the owner sees: everything but the files' contents. */
export interface OwnerStation extends Omit<Station, "failures" | "idempotencyKey"> {
  state: Observed;
  excluded: string[];
  listeners: number;
  error: string;
}

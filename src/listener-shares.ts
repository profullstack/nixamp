/**
 * Listener shares: anybody may hand a station a track -- a link to an MP3,
 * or the file itself -- and AI sorts it onto the air.
 *
 * The person sharing says on what basis it may be broadcast (they made it,
 * they have permission or a licence, it is Creative Commons or public
 * domain) and ticks that they mean it. Nixamp copies the file here (the same
 * guarded fetch as a handoff: public addresses only, every redirect checked,
 * a size cap), ffprobe must find music in it, and then a language model
 * reads what the file says about itself and answers two things: which genre
 * station it belongs on, and whether it looks like something the sharer
 * could not have the right to (a major-label release, a rip). "clear" goes on
 * the air when the owner chose AI moderation; "doubt" waits for the owner;
 * "refuse" (not music, spam) is turned away. With no model key, or with owner
 * moderation, everything waits for the owner.
 *
 * Approved tracks play on "Shared: <genre>" stations, made and kept in step
 * here, public and listed when the owner said so. Anybody listening may
 * report what is playing: a reported track leaves the rotation at once and
 * waits for the owner, which is the takedown path, not an afterthought.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { askJson, hasModel } from "./ai-text.ts";
import { genreBuckets } from "./auto-stations.ts";
import type { LibraryIndex, Probed } from "./library-index.ts";
import { isAudio } from "./playlist.ts";
import type { StationRunner } from "./station-runner.ts";
import { StationError, type StationStore } from "./stations.ts";

export type ShareState = "fetching" | "checking" | "held" | "approved" | "rejected" | "failed" | "reported" | "withdrawn";
export type ShareBasis = "owned" | "permission" | "licensed" | "creative-commons" | "public-domain";
export const SHARE_BASES: readonly ShareBasis[] = ["owned", "permission", "licensed", "creative-commons", "public-domain"];
export const SHARE_GENRES = ["Rock", "Punk", "Metal", "Alternative", "Pop", "Hip-Hop", "Electronic", "Industrial", "Reggae", "Jazz", "Blues", "Classical", "Country & Folk", "Soul & R&B", "Latin", "Ambient", "Experimental", "World", "Mixed"];

export interface Share {
  id: string;
  /** Lets the sharer see how it went, and withdraw it. Never shown to anybody else. */
  token: string;
  via: "url" | "upload";
  /** Where it came from, for the owner. */
  url: string;
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  state: ShareState;
  /** Why it is held, refused, failed or reported, in words. */
  reason: string;
  title: string;
  artist: string;
  genre: string;
  duration: number;
  rights: { basis: ShareBasis; note: string };
  /** A name the sharer chose to be credited with, or "". */
  by: string;
  /** Who shared it, as a salted hash: enough to count, not to find them. */
  from: string;
  check: { model: string; verdict: "clear" | "doubt" | "refuse" | ""; reason: string };
  reports: Array<{ at: number; reason: string; from: string }>;
  createdAt: number;
  updatedAt: number;
}

export interface ShareSettings {
  /** Whether anybody may share at all. */
  open: boolean;
  /** "ai": a clear verdict goes on the air; "owner": everything waits. */
  moderation: "ai" | "owner";
  /** Shared stations are public and on the guide. */
  publish: boolean;
  maxBytes: number;
  /** Shares an hour from one sharer. */
  perHour: number;
}

export const SHARE_DEFAULTS: ShareSettings = { open: false, moderation: "ai", publish: true, maxBytes: 60 * 1024 * 1024, perHour: 6 };
const MAX_REDIRECTS = 3;
const MIN_SECONDS = 20;
const MAX_SECONDS = 20 * 60;
const MAX_HELD = 500;

export interface SharesDeps {
  index: LibraryIndex;
  store: StationStore;
  runner: StationRunner;
  probe: (path: string) => Promise<Probed>;
  /** "" when this address may be fetched, else why not (destinations.ts). */
  guard: (url: string) => Promise<string>;
  /** The folder shared files go in: a managed library source. */
  root: string;
  owner: string;
  mayStart: () => boolean;
  /** The file a station is playing now, "" when none. */
  nowPlaying: (stationId: string) => string;
  fetcher?: typeof fetch;
  ask?: typeof askJson;
  canAsk?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

/** What a sharer may see of their share. */
export function sharerView(share: Share): Record<string, unknown> {
  return {
    id: share.id, state: share.state, reason: share.reason, title: share.title, artist: share.artist,
    genre: share.genre, duration: share.duration, createdAt: share.createdAt, updatedAt: share.updatedAt,
  };
}

/** What the owner sees: all of it but the sharer's token. */
export function ownerShareView(share: Share): Record<string, unknown> {
  const { token: _token, ...rest } = share;
  return rest;
}

const SYSTEM = [
  "You screen tracks that members of the public share to a community internet radio station, and file each under a genre.",
  "You see only what the file says about itself, its name, where it came from and what the sharer declared.",
  "verdict \"refuse\": not music (speech, silence, a test tone), spam or advertising, or titles that are hateful or sexual.",
  "verdict \"doubt\": anything suggesting a commercially released recording by a signed or well-known artist, or a rip or leak (label or distributor names, 'Official Audio', 'VEVO', 'Remastered', bitrate or scene tags, a famous song title), unless the sharer's basis plausibly covers it (e.g. public domain for a pre-1926 recording).",
  "verdict \"clear\": plausibly the sharer's own or independent work, or Creative Commons or public domain music consistent with the declaration.",
  `genre: exactly one of ${SHARE_GENRES.join(", ")}.`,
  "Answer as JSON: {\"verdict\": \"clear|doubt|refuse\", \"reason\": \"one short sentence\", \"genre\": \"...\", \"title\": \"tidy title or empty\", \"artist\": \"tidy artist or empty\"}.",
].join(" ");

export class ListenerShares {
  private shares = new Map<string, Share>();
  private settings: ShareSettings = { ...SHARE_DEFAULTS };
  private salt = randomBytes(16).toString("hex");
  private sourceId = "";
  private recent = new Map<string, number[]>();
  private syncing: Promise<void> | null = null;

  constructor(private readonly file: string, private readonly deps: SharesDeps) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { shares?: Share[]; settings?: Partial<ShareSettings>; salt?: string };
      for (const one of parsed.shares ?? []) if (one?.id) this.shares.set(one.id, one);
      this.settings = { ...this.settings, ...(parsed.settings ?? {}) };
      if (typeof parsed.salt === "string" && parsed.salt) this.salt = parsed.salt;
    } catch {
      // Nothing yet.
    }
    // A share that was being fetched or checked when the server stopped is
    // not coming back; say so rather than leave it spinning.
    for (const one of this.shares.values()) {
      if (one.state === "fetching" || one.state === "checking") {
        one.state = "failed";
        one.reason = "the server restarted while this was being read; share it again";
      }
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `shares-${port}.json`);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, salt: this.salt, settings: this.settings, shares: [...this.shares.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private source(): string {
    if (this.sourceId && this.deps.index.source(this.sourceId)) return this.sourceId;
    mkdirSync(this.deps.root, { recursive: true });
    this.sourceId = this.deps.index.addManagedSource(this.deps.root).id;
    return this.sourceId;
  }

  setting(): ShareSettings & { model: boolean } {
    return { ...this.settings, model: (this.deps.canAsk ?? hasModel)() };
  }

  configure(input: Record<string, unknown>): ShareSettings {
    if (input["open"] !== undefined) this.settings.open = input["open"] === true;
    if (input["publish"] !== undefined) this.settings.publish = input["publish"] === true;
    if (input["moderation"] !== undefined) {
      if (input["moderation"] !== "ai" && input["moderation"] !== "owner") throw new StationError("invalid_moderation", "moderation is ai or owner");
      this.settings.moderation = input["moderation"];
    }
    if (input["maxMb"] !== undefined) {
      const mb = Number(input["maxMb"]);
      if (!Number.isInteger(mb) || mb < 1 || mb > 500) throw new StationError("invalid_size", "maxMb is 1 to 500");
      this.settings.maxBytes = mb * 1024 * 1024;
    }
    if (input["perHour"] !== undefined) {
      const perHour = Number(input["perHour"]);
      if (!Number.isInteger(perHour) || perHour < 1 || perHour > 1000) throw new StationError("invalid_rate", "perHour is 1 to 1000");
      this.settings.perHour = perHour;
    }
    this.save();
    void this.sync();
    return this.settings;
  }

  list(state?: string): Share[] {
    return [...this.shares.values()].filter((one) => !state || one.state === state).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Share | undefined {
    return this.shares.get(id);
  }

  /** The share, if this token is the one its sharer was given. */
  forSharer(id: string, token: string): Share | undefined {
    const share = this.shares.get(id);
    if (!share || token.length !== share.token.length) return undefined;
    return createHash("sha256").update(token).digest("hex") === createHash("sha256").update(share.token).digest("hex") ? share : undefined;
  }

  private fromOf(caller: string): string {
    return createHash("sha256").update(`${this.salt}:${caller}`).digest("hex").slice(0, 16);
  }

  /** Throws when shares are closed or this sharer has shared enough for the hour. */
  private admit(caller: string): string {
    if (!this.settings.open) throw new StationError("shares_closed", "this server is not taking shared tracks", 403);
    if (this.list("held").length >= MAX_HELD) throw new StationError("queue_full", "too many tracks are waiting to be checked; try again later", 503);
    const from = this.fromOf(caller);
    const at = this.now();
    const times = (this.recent.get(from) ?? []).filter((one) => one > at - 3600_000);
    if (times.length >= this.settings.perHour) throw new StationError("rate_limited", `at most ${this.settings.perHour} shares an hour`, 429);
    times.push(at);
    this.recent.set(from, times);
    return from;
  }

  private declared(input: Record<string, unknown>): { basis: ShareBasis; note: string; by: string } {
    const basis = input["basis"];
    if (typeof basis !== "string" || !SHARE_BASES.includes(basis as ShareBasis)) {
      throw new StationError("rights_required", `say on what basis it may be broadcast: ${SHARE_BASES.join(", ")}`);
    }
    if (input["agree"] !== true && input["agree"] !== "1" && input["agree"] !== "true") {
      throw new StationError("agreement_required", "confirm you have the right to share this for broadcast");
    }
    return { basis: basis as ShareBasis, note: clean(input["note"], 300), by: clean(input["by"], 60) };
  }

  private blank(via: "url" | "upload", url: string, name: string, rights: { basis: ShareBasis; note: string; by: string }, from: string): Share {
    const id = randomBytes(6).toString("hex");
    const ext = extname(name).toLowerCase();
    const safe = name.split(/[\\/]/).pop()!.replace(/[^\w .()-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "track";
    return {
      id, token: randomBytes(16).toString("base64url"), via, url, name: safe,
      file: join(this.deps.root, id, isAudio(`x${ext}`) ? safe : `${safe}.mp3`),
      bytes: 0, sha256: "", state: "fetching", reason: "", title: "", artist: "", genre: "", duration: 0,
      rights: { basis: rights.basis, note: rights.note }, by: rights.by, from,
      check: { model: "", verdict: "", reason: "" }, reports: [], createdAt: this.now(), updatedAt: this.now(),
    };
  }

  /** A link to a music file. Answers at once; the fetch and the check carry on. */
  fromUrl(input: Record<string, unknown>, caller: string): Share {
    const rights = this.declared(input);
    const link = clean(input["url"], 2000);
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      throw new StationError("invalid_url", "paste a link to a music file (https://.../song.mp3)");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new StationError("invalid_url", "links are http or https");
    if ([...this.shares.values()].some((one) => one.url === link && one.state !== "failed" && one.state !== "withdrawn")) {
      throw new StationError("already_shared", "that link has been shared already", 409);
    }
    const from = this.admit(caller);
    const share = this.blank("url", link, decodeURIComponent(parsed.pathname.split("/").pop() || "track.mp3"), rights, from);
    this.shares.set(share.id, share);
    this.save();
    void this.fetchAndCheck(share);
    return share;
  }

  /** The file itself, as the request body. Resolves once it is all here; the check carries on. */
  async fromUpload(request: IncomingMessage, input: Record<string, unknown>, caller: string): Promise<Share> {
    const rights = this.declared(input);
    const name = clean(input["name"], 200) || "upload.mp3";
    const type = String(request.headers["content-type"] ?? "");
    if (!type.startsWith("audio/") && !isAudio(name)) throw new StationError("not_audio", "share a music file (MP3, OGG, FLAC, M4A, WAV)");
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (declaredLength > this.settings.maxBytes) throw new StationError("too_big", `files up to ${Math.round(this.settings.maxBytes / 1048576)} MB`, 413);
    const from = this.admit(caller);
    const share = this.blank("upload", "", name, rights, from);
    this.shares.set(share.id, share);
    try {
      await this.write(share, request);
    } catch (error) {
      this.fail(share, (error as Error).message);
      throw error instanceof StationError ? error : new StationError("upload_failed", share.reason);
    }
    void this.check(share);
    return share;
  }

  /** The sharer takes it back: off the air and its copy gone. */
  withdraw(share: Share): Share {
    share.state = "withdrawn";
    share.reason = "withdrawn by the person who shared it";
    rmSync(dirname(share.file), { recursive: true, force: true });
    share.updatedAt = this.now();
    this.save();
    void this.sync();
    return share;
  }

  /** A listener says what is playing should not be: off the air at once, for the owner to look at. */
  report(input: { station?: unknown; share?: unknown; reason?: unknown }, caller: string): { reported: boolean; title: string } {
    let share: Share | undefined;
    if (typeof input.share === "string") share = this.shares.get(input.share);
    else if (typeof input.station === "string") {
      const file = this.deps.nowPlaying(input.station);
      share = [...this.shares.values()].find((one) => one.file === file);
    }
    if (!share || share.state !== "approved") return { reported: false, title: "" };
    share.reports.push({ at: this.now(), reason: clean(input.reason, 300), from: this.fromOf(caller) });
    share.state = "reported";
    share.reason = `reported by a listener${share.reports.at(-1)!.reason ? `: ${share.reports.at(-1)!.reason}` : ""}`;
    share.updatedAt = this.now();
    this.save();
    this.deps.log?.(`  shares: "${share.title || share.name}" was reported and is off the air until the owner looks at it`);
    // Off the air now, not when the song ends: the station moves past it.
    const playingOn = typeof input.station === "string" ? input.station : "";
    void this.sync().then(() => { if (playingOn) this.deps.runner.skip(playingOn); });
    return { reported: true, title: share.title || share.name };
  }

  /** The owner's decision. */
  decide(id: string, decision: "approve" | "reject" | "delete", reason = ""): Share | null {
    const share = this.shares.get(id);
    if (!share) throw new StationError("not_found", "no such share", 404);
    if (decision === "delete") {
      rmSync(dirname(share.file), { recursive: true, force: true });
      this.shares.delete(id);
    } else if (decision === "approve") {
      if (!["held", "rejected", "reported"].includes(share.state)) throw new StationError("not_waiting", `it is ${share.state}`, 409);
      share.state = "approved";
      share.reason = reason || "approved by the owner";
    } else {
      share.state = "rejected";
      share.reason = reason || "not accepted by the owner";
    }
    if (share) share.updatedAt = this.now();
    this.save();
    void this.sync();
    return decision === "delete" ? null : share;
  }

  private fail(share: Share, reason: string): void {
    share.state = "failed";
    share.reason = reason;
    share.updatedAt = this.now();
    rmSync(dirname(share.file), { recursive: true, force: true });
    this.save();
  }

  /** Bytes to the share's file, counted, capped and hashed. */
  private async write(share: Share, body: NodeJS.ReadableStream): Promise<void> {
    mkdirSync(dirname(share.file), { recursive: true });
    const part = `${share.file}.part`;
    const hash = createHash("sha256");
    let bytes = 0;
    const max = this.settings.maxBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > max) return done(new StationError("too_big", `files up to ${Math.round(max / 1048576)} MB`, 413));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(part, { mode: 0o640 }));
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
    const sha256 = hash.digest("hex");
    if ([...this.shares.values()].some((one) => one.id !== share.id && one.sha256 === sha256 && one.state !== "withdrawn" && one.state !== "failed")) {
      rmSync(part, { force: true });
      throw new StationError("already_shared", "that track has been shared already", 409);
    }
    renameSync(part, share.file);
    share.bytes = bytes;
    share.sha256 = sha256;
    share.state = "checking";
    share.updatedAt = this.now();
    this.save();
  }

  private async fetchAndCheck(share: Share): Promise<void> {
    try {
      const send = this.deps.fetcher ?? fetch;
      let at = share.url;
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const refused = await this.deps.guard(at);
        if (refused) throw new Error(refused);
        response = await send(at, { redirect: "manual", signal: AbortSignal.timeout(5 * 60_000), headers: { "user-agent": "nixamp-shares" } });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          at = new URL(location, at).toString();
          continue;
        }
        break;
      }
      if (!response || !response.ok || !response.body) throw new Error(`the link answered HTTP ${response?.status ?? "nothing"}`);
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("text/html")) throw new Error("that link is a web page, not a music file; link the .mp3 itself");
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > this.settings.maxBytes) throw new Error(`the file is over ${Math.round(this.settings.maxBytes / 1048576)} MB`);
      await this.write(share, Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
    } catch (error) {
      this.fail(share, (error as Error).message);
      return;
    }
    await this.check(share);
  }

  /** ffprobe, then the model: on the air, waiting, or turned away. */
  private async check(share: Share): Promise<void> {
    try {
      await this.deps.index.scan(this.source(), this.deps.probe).done;
      const item = this.deps.index.itemAt(share.file);
      if (!item || item.state !== "ready") throw new Error(item?.error || "there is no music in that file that a station can play");
      if (item.duration > 0 && item.duration < MIN_SECONDS) throw new Error(`it is ${Math.round(item.duration)} s; a track is at least ${MIN_SECONDS} s`);
      if (item.duration > MAX_SECONDS) throw new Error("it is over 20 minutes; share a track, not a mix or a show");
      share.duration = Math.round(item.duration);
      share.title = item.title || share.name.replace(/\.[a-z0-9]+$/i, "");
      share.artist = item.artist;
      share.genre = genreBuckets(item.genre)[0] ?? "";
      let verdict: Share["check"]["verdict"] = "doubt";
      let reason = "waiting for the owner (no AI check on this server)";
      if ((this.deps.canAsk ?? hasModel)()) {
        try {
          const answer = await (this.deps.ask ?? askJson)({
            system: SYSTEM,
            prompt: JSON.stringify({
              file: share.name, title: item.title, artist: item.artist, album: item.album, genreTag: item.genre, year: item.year,
              seconds: share.duration, from: share.url ? new URL(share.url).host : "uploaded", declared: share.rights,
            }),
          });
          const said = answer.value;
          verdict = said["verdict"] === "clear" || said["verdict"] === "refuse" ? said["verdict"] : "doubt";
          reason = clean(said["reason"], 300) || verdict;
          const genre = SHARE_GENRES.find((one) => one.toLowerCase() === String(said["genre"] ?? "").toLowerCase());
          if (!share.genre && genre) share.genre = genre;
          if (!item.title && clean(said["title"], 200)) share.title = clean(said["title"], 200);
          if (!item.artist && clean(said["artist"], 200)) share.artist = clean(said["artist"], 200);
          share.check = { model: answer.model, verdict, reason };
        } catch (error) {
          reason = `waiting for the owner (the AI check failed: ${(error as Error).message})`;
        }
      }
      share.genre ||= "Mixed";
      if (verdict === "refuse") {
        share.state = "rejected";
        share.reason = reason;
        rmSync(dirname(share.file), { recursive: true, force: true });
      } else if (verdict === "clear" && this.settings.moderation === "ai") {
        share.state = "approved";
        share.reason = "";
      } else {
        share.state = "held";
        share.reason = verdict === "clear" ? "waiting for the owner" : reason;
      }
      share.updatedAt = this.now();
      this.save();
      this.deps.log?.(`  shares: "${share.title}" (${share.genre}) is ${share.state}${share.reason ? `: ${share.reason}` : ""}`);
      await this.sync();
    } catch (error) {
      this.fail(share, (error as Error).message);
    }
  }

  /** Each genre's shared station, with exactly the approved tracks; one with none goes quiet. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing.then(() => this.sync());
    this.syncing = (async () => {
      const byGenre = new Map<string, string[]>();
      for (const share of this.shares.values()) {
        if (share.state !== "approved") continue;
        byGenre.set(share.genre, [...(byGenre.get(share.genre) ?? []), share.file]);
      }
      const genres = new Set([...byGenre.keys(), ...this.deps.store.list().filter((one) => one.auto.startsWith("share:")).map((one) => one.auto.slice(6))]);
      for (const genre of genres) {
        const files = (byGenre.get(genre) ?? []).filter((file) => this.deps.index.itemAt(file)?.state === "ready");
        const existing = this.deps.store.byAuto(`share:${genre}`);
        if (files.length === 0) {
          if (existing && existing.desired === "running") this.deps.runner.stop(existing.id);
          if (existing && existing.listed) this.deps.store.setAccess(existing.id, { listed: false }, this.deps.owner || "shares");
          continue;
        }
        let station = existing;
        if (!station) {
          station = this.deps.store.create({ name: `Shared: ${genre}`, description: `${genre} shared by listeners. Share yours, or report a track, from the guide.`, shuffle: true, repeat: true }, files, this.deps.owner);
          this.deps.store.markAuto(station.id, `share:${genre}`);
        } else {
          this.deps.store.update(station.id, {}, files);
        }
        if (this.settings.publish) {
          this.deps.store.setAccess(station.id, {
            visibility: "public",
            listed: true,
            rights: { basis: "permission", note: "Each track was shared by someone who declared the right to have it broadcast; listeners can report any track off the air." },
          }, this.deps.owner || "shares");
        } else if (station.visibility === "public") {
          this.deps.store.setAccess(station.id, { visibility: "unlisted" }, this.deps.owner || "shares");
        }
        if (station.desired !== "running" && this.deps.mayStart()) await this.deps.runner.start(station.id).catch(() => undefined);
      }
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }
}

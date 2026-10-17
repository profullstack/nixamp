/**
 * Music handed over from BitTorrented: copied here, checked, indexed, and
 * made into a private station draft.
 *
 * BitTorrented keeps its own collections and downloads; Nixamp keeps what it
 * was handed. A handoff names the files a person chose, each with a link that
 * opens that one file for a short while and nothing else. Nixamp copies each
 * file into its own imports folder, so a station plays from a copy on this
 * machine and does not depend on anybody still seeding it. A file is "ready"
 * only once the copy has the size it was said to have and ffprobe can read
 * it; until then it is pending, and a station never plays it.
 *
 * Asking twice with the same idempotency key is one handoff and one station.
 * Removing the item in BitTorrented does not touch the copy here; deleting the
 * handoff here removes the copies it made (and only those), which is the one
 * place a Nixamp action deletes files, so it is said wherever it is offered.
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LibraryError, type LibraryIndex, type Probed } from "./library-index.ts";
import { playable } from "./playlist.ts";
import type { StationStore } from "./stations.ts";

export type FileState = "pending" | "downloading" | "ready" | "failed" | "expired" | "unsupported";

export interface HandoffFile {
  fileId: string;
  name: string;
  size: number;
  mediaType: string;
  /** Whether BitTorrented said the download was complete when it handed it over. */
  complete: boolean;
  state: FileState;
  error: string;
  attempts: number;
  /** Where the copy is (or will be). Shown to the owner only. */
  path: string;
  bytes: number;
  sha256: string;
  /** The grant; kept until the copy is made, never shown. */
  url: string;
  expiresAt: number;
  tags: { title?: string; artist?: string; album?: string; track?: number };
}

export interface Handoff {
  id: string;
  version: 1;
  provider: "bittorrented";
  idempotencyKey: string;
  owner: string;
  name: string;
  source: { torrentId: string; infohash: string; collectionId: string };
  stationId: string;
  files: HandoffFile[];
  createdAt: number;
  updatedAt: number;
}

export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 4 * 1024 ** 3;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 3;

export interface ImporterDeps {
  index: LibraryIndex;
  stations: StationStore;
  /** The folder copies go into: a managed library source. */
  root: string;
  probe: (path: string) => Promise<Probed>;
  /** "" when this address may be fetched, else why not (destinations.ts). */
  guard: (url: string) => Promise<string>;
  fetcher?: typeof fetch;
  /** Plain http, for tests on loopback only. */
  allowHttp?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

function safeName(name: string, at: number): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return `${String(at + 1).padStart(3, "0")} ${cleaned || "file"}`;
}

export function publicHandoff(handoff: Handoff): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const file of handoff.files) counts[file.state] = (counts[file.state] ?? 0) + 1;
  return {
    id: handoff.id,
    version: handoff.version,
    provider: handoff.provider,
    idempotencyKey: handoff.idempotencyKey,
    name: handoff.name,
    source: handoff.source,
    stationId: handoff.stationId,
    status: counts["pending"] || counts["downloading"] ? "importing" : (counts["ready"] ?? 0) === handoff.files.length ? "ready" : counts["ready"] ? "partial" : "failed",
    counts,
    files: handoff.files.map(({ url: _url, path: _path, ...file }) => file),
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
  };
}

export class Importer {
  private handoffs = new Map<string, Handoff>();
  private running = new Set<string>();
  private sourceId = "";

  constructor(private readonly file: string, private readonly deps: ImporterDeps) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { handoffs?: Handoff[] };
      for (const one of parsed.handoffs ?? []) if (one?.id) this.handoffs.set(one.id, one);
    } catch {
      // Nothing yet.
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, handoffs: [...this.handoffs.values()] }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private source(): string {
    if (this.sourceId && this.deps.index.source(this.sourceId)) return this.sourceId;
    mkdirSync(this.deps.root, { recursive: true });
    this.sourceId = this.deps.index.addManagedSource(this.deps.root).id;
    return this.sourceId;
  }

  list(owner: string | null): Handoff[] {
    return [...this.handoffs.values()].filter((one) => owner === null || one.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Handoff | undefined {
    return this.handoffs.get(id);
  }

  /** A handoff, or the one this key already made. `created` says which. */
  create(input: Record<string, unknown>, owner: string): { handoff: Handoff; created: boolean } {
    if (input["version"] !== 1) throw new LibraryError("unsupported_version", "this server understands handoff version 1");
    const key = typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"].trim().slice(0, 200) : "";
    if (!key) throw new LibraryError("idempotency_key_required", "a handoff needs an idempotencyKey, so a retry is not a second one");
    const again = [...this.handoffs.values()].find((one) => one.idempotencyKey === key && one.owner === owner);
    if (again) return { handoff: again, created: false };
    const files = input["files"];
    if (!Array.isArray(files) || files.length === 0) throw new LibraryError("files_required", "choose at least one file");
    if (files.length > MAX_FILES) throw new LibraryError("too_many_files", `at most ${MAX_FILES} files in one handoff`);
    const id = randomBytes(8).toString("hex");
    const folder = join(this.deps.root, id);
    const now = this.now();
    const seen = new Set<string>();
    const accepted: HandoffFile[] = files.map((raw, at) => {
      const one = (raw ?? {}) as Record<string, unknown>;
      const fileId = typeof one["fileId"] === "string" ? one["fileId"].slice(0, 200) : "";
      const name = typeof one["name"] === "string" ? one["name"] : "";
      const size = Number(one["size"]);
      const url = typeof one["url"] === "string" ? one["url"] : "";
      const mediaType = typeof one["mediaType"] === "string" ? one["mediaType"].slice(0, 100) : "";
      if (!fileId || seen.has(fileId)) throw new LibraryError("invalid_file", `file ${at + 1} needs a fileId of its own`);
      seen.add(fileId);
      if (!name) throw new LibraryError("invalid_file", `file ${at + 1} needs a name`);
      if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new LibraryError("invalid_file", `file ${at + 1} needs a size in bytes, up to 4 GiB`);
      if (!(mediaType.startsWith("audio/") || playable(name))) throw new LibraryError("not_audio", `${name} is not a file a station can play`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new LibraryError("invalid_file", `file ${at + 1} needs a url to fetch it from`);
      }
      if (parsed.protocol !== "https:" && !(this.deps.allowHttp && parsed.protocol === "http:")) {
        throw new LibraryError("insecure_url", "files are fetched over https only");
      }
      const tags = (one["metadata"] ?? {}) as Record<string, unknown>;
      return {
        fileId, name, size, mediaType,
        complete: one["complete"] === true,
        state: "pending", error: "", attempts: 0,
        path: join(folder, safeName(name, at) + (extname(name) ? "" : ".mp3")),
        bytes: 0, sha256: "",
        url,
        expiresAt: Number.isFinite(Number(one["expiresAt"])) ? Number(one["expiresAt"]) : 0,
        tags: {
          ...(typeof tags["title"] === "string" ? { title: tags["title"].slice(0, 300) } : {}),
          ...(typeof tags["artist"] === "string" ? { artist: tags["artist"].slice(0, 300) } : {}),
          ...(typeof tags["album"] === "string" ? { album: tags["album"].slice(0, 300) } : {}),
          ...(Number.isInteger(tags["track"]) ? { track: tags["track"] as number } : {}),
        },
      };
    });
    const sourceInput = (input["source"] ?? {}) as Record<string, unknown>;
    const name = (typeof input["name"] === "string" && input["name"].trim() ? input["name"].trim() : "From BitTorrented").slice(0, 120);
    this.source();
    // The draft, private and stopped, with every file it will have: a file
    // that is not copied yet is simply not there, and a station plays what is.
    const station = this.deps.stations.create({ name }, accepted.map((one) => one.path), owner, now, `handoff:${key}`);
    const handoff: Handoff = {
      id, version: 1, provider: "bittorrented", idempotencyKey: key, owner, name,
      source: {
        torrentId: String(sourceInput["torrentId"] ?? "").slice(0, 200),
        infohash: String(sourceInput["infohash"] ?? "").slice(0, 80),
        collectionId: String(sourceInput["collectionId"] ?? "").slice(0, 200),
      },
      stationId: station.id,
      files: accepted,
      createdAt: now,
      updatedAt: now,
    };
    this.handoffs.set(id, handoff);
    this.save();
    void this.run(id);
    return { handoff, created: true };
  }

  /** New links for files whose links ran out, and another try for the failed ones. */
  retry(id: string, input: Record<string, unknown>): Handoff {
    const handoff = this.handoffs.get(id);
    if (!handoff) throw new LibraryError("not_found", "no such handoff", 404);
    const fresh = Array.isArray(input["files"]) ? (input["files"] as Array<Record<string, unknown>>) : [];
    for (const file of handoff.files) {
      const update = fresh.find((one) => one["fileId"] === file.fileId);
      if (update && typeof update["url"] === "string") {
        const parsed = new URL(update["url"]);
        if (parsed.protocol !== "https:" && !(this.deps.allowHttp && parsed.protocol === "http:")) throw new LibraryError("insecure_url", "files are fetched over https only");
        file.url = update["url"];
        file.expiresAt = Number(update["expiresAt"] ?? 0) || 0;
      }
      if (file.state === "failed" || file.state === "expired") {
        file.state = "pending";
        file.error = "";
        file.attempts = 0;
      }
    }
    handoff.updatedAt = this.now();
    this.save();
    void this.run(id);
    return handoff;
  }

  /** The copies this handoff made, removed; the station loses those files. */
  remove(id: string): number {
    const handoff = this.handoffs.get(id);
    if (!handoff) throw new LibraryError("not_found", "no such handoff", 404);
    const removed = handoff.files.filter((one) => one.state === "ready").length;
    rmSync(join(this.deps.root, id), { recursive: true, force: true });
    this.handoffs.delete(id);
    this.save();
    void this.deps.index.scan(this.source(), this.deps.probe).done;
    return removed;
  }

  /** Every handoff that was part-way when the server stopped, carried on. */
  resume(): void {
    for (const handoff of this.handoffs.values()) {
      let again = false;
      for (const file of handoff.files) {
        if (file.state === "downloading") file.state = "pending";
        if (file.state === "pending") again = true;
      }
      if (again) void this.run(handoff.id);
    }
  }

  private async run(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const handoff = this.handoffs.get(id);
      if (!handoff) return;
      let next = 0;
      const queue = handoff.files.filter((one) => one.state === "pending");
      const worker = async (): Promise<void> => {
        while (next < queue.length) {
          const file = queue[next++]!;
          await this.copy(handoff, file);
          handoff.updatedAt = this.now();
          this.save();
        }
      };
      await Promise.all([worker(), worker()]);
      // What was copied, read and indexed; then each file says what it is.
      await this.deps.index.scan(this.source(), this.deps.probe).done;
      for (const file of handoff.files) {
        if (file.state !== "ready") continue;
        const item = this.deps.index.itemAt(file.path);
        if (!item || item.state === "failed") {
          file.state = "failed";
          file.error = item?.error || "it could not be read after copying";
        } else if (item.state === "unsupported") {
          file.state = "unsupported";
          file.error = "there is nothing in it a station can play";
        } else if (item.state === "ready") {
          // What BitTorrented knew, where the file itself says nothing.
          const patch: Record<string, unknown> = {};
          if (!item.title && file.tags.title) patch["title"] = file.tags.title;
          if (!item.artist && file.tags.artist) patch["artist"] = file.tags.artist;
          if (!item.album && file.tags.album) patch["album"] = file.tags.album;
          if (Object.keys(patch).length) this.deps.index.correct(item.id, patch);
        }
      }
      handoff.updatedAt = this.now();
      this.save();
    } finally {
      this.running.delete(id);
    }
  }

  private async copy(handoff: Handoff, file: HandoffFile): Promise<void> {
    if (file.expiresAt && file.expiresAt <= this.now()) {
      file.state = "expired";
      file.error = "the link to this file ran out before it was copied; ask BitTorrented for a new one";
      return;
    }
    file.state = "downloading";
    file.attempts += 1;
    const send = this.deps.fetcher ?? fetch;
    const part = `${file.path}.part`;
    try {
      let at = file.url;
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const refused = await this.deps.guard(at);
        if (refused) throw new Error(refused);
        response = await send(at, { redirect: "manual", headers: { "user-agent": "nixamp-handoff" } });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          at = new URL(location, at).toString();
          continue;
        }
        break;
      }
      if (!response) throw new Error("no answer");
      if ([401, 403, 410].includes(response.status)) {
        file.state = "expired";
        file.error = `BitTorrented no longer lets this file be fetched (HTTP ${response.status}); ask for a new link`;
        return;
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared && declared !== file.size) throw new Error(`the file is ${declared} bytes, not the ${file.size} it was said to be`);
      mkdirSync(dirname(file.path), { recursive: true });
      const hash = createHash("sha256");
      let bytes = 0;
      const counted = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > file.size) counted.destroy(new Error(`more than the ${file.size} bytes it was said to be`));
        hash.update(chunk);
      });
      await pipeline(counted, createWriteStream(part, { mode: 0o640 }));
      if (bytes !== file.size) throw new Error(`incomplete: ${bytes} of ${file.size} bytes`);
      renameSync(part, file.path);
      file.bytes = bytes;
      file.sha256 = hash.digest("hex");
      file.state = "ready";
      file.error = "";
      // The grant has done its job.
      file.url = "";
    } catch (error) {
      rmSync(part, { force: true });
      file.error = error instanceof Error ? error.message : String(error);
      file.state = file.attempts < MAX_ATTEMPTS ? "pending" : "failed";
      if (file.state === "pending") await this.copy(handoff, file);
    }
  }

  /** The bytes a ready copy takes on disk, for the owner's view. */
  static sizeOn(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }
}

/**
 * What belongs to one listener of a library: their playlists, and where
 * they are in what they were playing.
 *
 * A listener here is somebody this server can recognise next time from
 * another device: a nixamp.com account, or the owner holding the control key
 * (who is "owner"). Somebody with only the listen link is not anybody in
 * particular, so they get a player and no memory, which is what the PRD means
 * by resuming "after authentication".
 *
 * Playlists hold item ids, not paths: a playlist survives a rescan, and an
 * item that went missing stays in it, shown as unavailable, until somebody
 * takes it out. Every change bumps a revision; an edit that names an older
 * revision is refused rather than quietly overwriting what another device
 * just did.
 *
 * The queue is one per listener, written whenever playback moves on, so a
 * phone picks up where the laptop stopped.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LibraryError } from "./library-index.ts";

export interface Playlist {
  id: string;
  owner: string;
  name: string;
  items: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type Repeat = "off" | "all" | "one";

export interface Queue {
  owner: string;
  items: string[];
  /** Index into items of what is on. */
  at: number;
  /** Seconds into it. */
  position: number;
  shuffle: boolean;
  repeat: Repeat;
  /** Which device moved it last, as it named itself. */
  device: string;
  revision: number;
  updatedAt: number;
}

const MAX_PLAYLISTS = 500;
const MAX_ITEMS = 10_000;

export class ListenerStore {
  private playlists = new Map<string, Playlist>();
  private queues = new Map<string, Queue>();
  private timer: ReturnType<typeof setTimeout> | null = null;

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
      const parsed = JSON.parse(body) as { playlists?: Playlist[]; queues?: Queue[] };
      for (const one of parsed.playlists ?? []) if (one?.id) this.playlists.set(one.id, one);
      for (const one of parsed.queues ?? []) if (one?.owner) this.queues.set(one.owner, one);
    } catch {
      // Started over.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `listeners-${port}.json`);
  }

  private touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.io.write(this.file, JSON.stringify({ version: 1, playlists: [...this.playlists.values()], queues: [...this.queues.values()] }));
  }

  playlistsOf(owner: string): Playlist[] {
    return [...this.playlists.values()].filter((one) => one.owner === owner).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Somebody's own playlist; anybody else's is the same "not found". */
  playlist(owner: string, id: string): Playlist {
    const found = this.playlists.get(id);
    if (!found || found.owner !== owner) throw new LibraryError("not_found", "no such playlist", 404);
    return found;
  }

  private items(value: unknown, known: (id: string) => boolean): string[] {
    if (!Array.isArray(value) || value.some((one) => typeof one !== "string")) throw new LibraryError("invalid_items", "items is a list of item ids");
    if (value.length > MAX_ITEMS) throw new LibraryError("too_many_items", `a list holds at most ${MAX_ITEMS} items`);
    const unknown = (value as string[]).filter((one) => !known(one));
    if (unknown.length) throw new LibraryError("unknown_items", `${unknown.length} of those items are not in this library`);
    return value as string[];
  }

  private name(value: unknown): string {
    const name = typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : "";
    if (!name) throw new LibraryError("name_required", "a playlist needs a name");
    return name;
  }

  create(owner: string, input: { name?: unknown; items?: unknown }, known: (id: string) => boolean): Playlist {
    if (this.playlistsOf(owner).length >= MAX_PLAYLISTS) throw new LibraryError("too_many_playlists", `at most ${MAX_PLAYLISTS} playlists each`, 409);
    const now = this.now();
    const playlist: Playlist = {
      id: randomBytes(8).toString("hex"),
      owner,
      name: this.name(input.name),
      items: input.items === undefined ? [] : this.items(input.items, known),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.playlists.set(playlist.id, playlist);
    this.touch();
    return playlist;
  }

  /** Rename, reorder or replace the items; `revision` must be the one the caller saw. */
  update(owner: string, id: string, input: { name?: unknown; items?: unknown; revision?: unknown }, known: (id: string) => boolean): Playlist {
    const playlist = this.playlist(owner, id);
    if (input.revision !== undefined && input.revision !== playlist.revision) {
      throw new LibraryError("stale_revision", `the playlist changed (revision ${playlist.revision}); fetch it and try again`, 409);
    }
    if (input.name !== undefined) playlist.name = this.name(input.name);
    if (input.items !== undefined) playlist.items = this.items(input.items, known);
    playlist.revision += 1;
    playlist.updatedAt = this.now();
    this.touch();
    return playlist;
  }

  /** Items added, at the end or at a place. */
  add(owner: string, id: string, input: { items?: unknown; at?: unknown }, known: (id: string) => boolean): Playlist {
    const playlist = this.playlist(owner, id);
    const added = this.items(input.items, known);
    const at = typeof input.at === "number" && Number.isInteger(input.at) ? Math.max(0, Math.min(playlist.items.length, input.at)) : playlist.items.length;
    if (playlist.items.length + added.length > MAX_ITEMS) throw new LibraryError("too_many_items", `a list holds at most ${MAX_ITEMS} items`);
    playlist.items.splice(at, 0, ...added);
    playlist.revision += 1;
    playlist.updatedAt = this.now();
    this.touch();
    return playlist;
  }

  remove(owner: string, id: string): void {
    this.playlist(owner, id);
    this.playlists.delete(id);
    this.touch();
  }

  queueOf(owner: string): Queue {
    return this.queues.get(owner) ?? { owner, items: [], at: 0, position: 0, shuffle: false, repeat: "off", device: "", revision: 0, updatedAt: 0 };
  }

  /**
   * A new queue (items given) or where playback has got to (at/position).
   * Last writer wins for where you are -- that is what moving to another
   * device means -- but a whole new list names the revision it replaces.
   */
  setQueue(owner: string, input: Record<string, unknown>, known: (id: string) => boolean): Queue {
    const queue = { ...this.queueOf(owner) };
    if (input["items"] !== undefined) {
      if (input["revision"] !== undefined && input["revision"] !== queue.revision) {
        throw new LibraryError("stale_revision", `the queue changed on another device (revision ${queue.revision})`, 409);
      }
      queue.items = this.items(input["items"], known);
      queue.at = 0;
      queue.position = 0;
    }
    if (input["at"] !== undefined) {
      if (!Number.isInteger(input["at"]) || (input["at"] as number) < 0 || (input["at"] as number) >= Math.max(1, queue.items.length)) {
        throw new LibraryError("invalid_value", "at is a place in the queue");
      }
      queue.at = input["at"] as number;
      if (input["position"] === undefined) queue.position = 0;
    }
    if (input["position"] !== undefined) {
      const position = Number(input["position"]);
      if (!Number.isFinite(position) || position < 0) throw new LibraryError("invalid_value", "position is seconds into the item");
      queue.position = Math.round(position * 10) / 10;
    }
    if (input["shuffle"] !== undefined) queue.shuffle = input["shuffle"] === true;
    if (input["repeat"] !== undefined) {
      if (!["off", "all", "one"].includes(String(input["repeat"]))) throw new LibraryError("invalid_value", "repeat is off, all or one");
      queue.repeat = input["repeat"] as Repeat;
    }
    if (typeof input["device"] === "string") queue.device = input["device"].slice(0, 80);
    queue.revision += 1;
    queue.updatedAt = this.now();
    this.queues.set(owner, queue);
    this.touch();
    return queue;
  }
}

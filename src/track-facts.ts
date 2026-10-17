/**
 * What a listener may know about the track on the air: who made it, whether
 * it was made by AI, who holds its copyright, and how to support them.
 *
 * Gathered from what is already known, never guessed into a fact:
 *  - the file's own tags (title, artist, album, year, genre, and the
 *    copyright, publisher, comment and encoder tags ffprobe reads);
 *  - where it came from on this server: composed by AI radio, shared by a
 *    listener (with their declaration), or the station's own declared basis;
 *  - the copyright holders the owner registered (`nixamp station holder`),
 *    matched by artist or station, with the link that supports them.
 * "AI-generated" is true only on evidence (a tag naming Suno, Udio,
 * ElevenLabs...; AI radio's own files), and null -- not stated -- otherwise.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Station } from "./stations.ts";
import { StationError } from "./stations.ts";

export interface TrackFacts {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  ai: { generated: boolean | null; by: string; evidence: string };
  rights: { holder: string; basis: string; note: string; license: string; source: "tag" | "holder" | "share" | "ai-radio" | "station" | "" };
  support: { holder: string; url: string; label: string } | null;
  /** The track's own cover, on this station's link (it changes with the track); "" when it has none. */
  art: string;
  /** Where the track's words are, on this station's link; "" when none are known. */
  lyrics: string;
}

export interface Holder {
  id: string;
  name: string;
  /** Artist names (as tagged) whose tracks are theirs; case does not matter. */
  artists: string[];
  /** Stations whose every track is theirs. */
  stations: string[];
  /** Where a listener supports them: a subscription or donation page (https). */
  support: string;
  /** The button's words, e.g. "Subscribe" or "Donate". */
  label: string;
  /** e.g. "All rights reserved", "CC BY 4.0". */
  license: string;
}

/** The tags ffprobe reads from a file, lower-cased, cached by size and time. */
export class TagReader {
  private cache = new Map<string, { key: string; tags: Record<string, string> }>();

  constructor(private readonly ffprobe: string[]) {}

  /** Known now, or {} while it is read in the background. */
  known(path: string): Record<string, string> | null {
    const hit = this.cache.get(path);
    if (!hit) return null;
    try {
      const info = statSync(path);
      return hit.key === `${info.size}:${info.mtimeMs}` ? hit.tags : null;
    } catch {
      return hit.tags;
    }
  }

  read(path: string): Promise<Record<string, string>> {
    const known = this.known(path);
    if (known) return Promise.resolve(known);
    const [command, ...prefix] = this.ffprobe;
    if (!command) return Promise.resolve({});
    return new Promise((done) => {
      const child = spawn(command, [...prefix, "-v", "error", "-print_format", "json", "-show_entries", "format_tags:stream_tags", path], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timer.unref?.();
      child.stdout.on("data", (chunk: Buffer) => { if (out.length < 1024 * 1024) out += chunk.toString("utf8"); });
      child.on("error", () => { clearTimeout(timer); done({}); });
      child.on("close", () => {
        clearTimeout(timer);
        const tags: Record<string, string> = {};
        try {
          const parsed = JSON.parse(out) as { format?: { tags?: Record<string, unknown> }; streams?: Array<{ tags?: Record<string, unknown> }> };
          for (const source of [...(parsed.streams ?? []).map((one) => one.tags ?? {}), parsed.format?.tags ?? {}]) {
            for (const [name, value] of Object.entries(source)) {
              if (typeof value !== "string") continue;
              const lower = name.toLowerCase();
              // A song's words run longer than any other tag (lyrics.ts).
              tags[lower] = value.slice(0, /lyrics/.test(lower) ? 20_000 : 2000);
            }
          }
        } catch {
          // No tags is an answer too.
        }
        try {
          const info = statSync(path);
          if (this.cache.size > 5000) this.cache.clear();
          this.cache.set(path, { key: `${info.size}:${info.mtimeMs}`, tags });
        } catch {
          // Gone already.
        }
        done(tags);
      });
    });
  }
}

const AI_MARKS: Array<[RegExp, string]> = [
  [/\bsuno\b/i, "Suno"],
  [/\budio\b/i, "Udio"],
  [/elevenlabs|eleven labs/i, "ElevenLabs Music"],
  [/musicgen|audiocraft/i, "MusicGen"],
  [/stable audio/i, "Stable Audio"],
  [/riffusion/i, "Riffusion"],
  [/ace-?step/i, "ACE-Step"],
  [/mubert/i, "Mubert"],
  [/made with mozart|mozart ai/i, "Mozart AI"],
  [/\b(ai[- ]generated|generated (by|with) ai|made (by|with) ai)\b/i, "AI"],
];

/** Whether these tags say the track was made by AI, and with what. */
export function aiFromTags(tags: Record<string, string>): { by: string; evidence: string } | null {
  for (const field of ["comment", "description", "encoded_by", "encoder", "software", "tsse", "publisher", "copyright", "genre", "album"]) {
    const value = tags[field];
    if (!value) continue;
    // The encoder field is usually just "Lavf..." -- only a named model counts.
    for (const [pattern, by] of AI_MARKS) {
      if (pattern.test(value)) return { by, evidence: `${field} tag: "${value.slice(0, 120)}"` };
    }
  }
  if (/^ai$/i.test(tags["genre"] ?? "")) return { by: "AI", evidence: 'genre tag: "AI"' };
  return null;
}

export interface FactSources {
  station: Station;
  file: string;
  tags: Record<string, string>;
  /** What the library knows when the file has no tag for it. */
  known?: { title: string; artist: string; album: string } | null;
  holders: Holder[];
  /** A listener's share of this file, when it is one. */
  share?: { basis: string; note: string; by: string } | null;
  /** AI radio's record of this file, when it composed it. */
  aiTrack?: { made: string } | null;
  /** Where its cover is served, when it has one. */
  art?: string;
  /** Where its words are served, when it has them. */
  lyrics?: string;
}

export function factsFor(input: FactSources): TrackFacts {
  const { station, tags } = input;
  const title = tags["title"] || input.known?.title || "";
  const artist = tags["artist"] || tags["album_artist"] || input.known?.artist || "";
  const album = tags["album"] || input.known?.album || "";
  const year = (tags["date"] || tags["year"] || tags["tdrc"] || "").slice(0, 4);
  const genre = tags["genre"] || "";

  const tagged = aiFromTags(tags);
  const ai: TrackFacts["ai"] = input.aiTrack
    ? { generated: true, by: input.aiTrack.made.split("+").pop()?.trim() || "AI", evidence: "composed for this station by AI radio" }
    : tagged
      ? { generated: true, by: tagged.by, evidence: tagged.evidence }
      : { generated: null, by: "", evidence: "" };

  const lower = artist.toLowerCase();
  const holder = input.holders.find((one) => one.stations.includes(station.id))
    ?? (lower ? input.holders.find((one) => one.artists.some((name) => name.toLowerCase() === lower)) : undefined);
  const copyright = tags["copyright"] || tags["tcop"] || "";
  let rights: TrackFacts["rights"];
  if (copyright) {
    rights = { holder: copyright.replace(/^(\(c\)|©|copyright)\s*/i, "").slice(0, 200), basis: "", note: "", license: holder?.license ?? "", source: "tag" };
  } else if (holder) {
    rights = { holder: holder.name, basis: station.rights?.basis ?? "", note: "", license: holder.license, source: "holder" };
  } else if (input.share) {
    rights = { holder: input.share.by || "the person who shared it", basis: input.share.basis, note: input.share.note, license: input.share.basis === "creative-commons" || input.share.basis === "public-domain" ? input.share.note : "", source: "share" };
  } else if (input.aiTrack) {
    rights = { holder: "this station's owner", basis: "owned", note: station.rights?.note ?? "", license: "", source: "ai-radio" };
  } else if (station.rights) {
    rights = { holder: "", basis: station.rights.basis, note: station.rights.note, license: "", source: "station" };
  } else {
    rights = { holder: "", basis: "", note: "", license: "", source: "" };
  }
  const support = holder && holder.support ? { holder: holder.name, url: holder.support, label: holder.label || "Support" } : null;
  return { title, artist, album, year, genre, ai, rights, support, art: input.art ?? "", lyrics: input.lyrics ?? "" };
}

function slug(text: string): string {
  return text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "holder";
}

/** The copyright holders this server's owner registered. */
export class HolderStore {
  private holders = new Map<string, Holder>();

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { holders?: Holder[] };
      for (const one of parsed.holders ?? []) if (one?.id) this.holders.set(one.id, one);
    } catch {
      // None yet.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `holders-${port}.json`);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, holders: [...this.holders.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  list(): Holder[] {
    return [...this.holders.values()];
  }

  /** Make or change a holder, found by id or by name. */
  set(input: Record<string, unknown>): Holder {
    const name = typeof input["name"] === "string" ? input["name"].replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) : "";
    const id = typeof input["id"] === "string" && input["id"] ? input["id"] : slug(name);
    const existing = this.holders.get(id);
    if (!existing && !name) throw new StationError("name_required", "a copyright holder needs a name");
    const words = (value: unknown): string[] | undefined => Array.isArray(value)
      ? value.filter((one): one is string => typeof one === "string").map((one) => one.trim().slice(0, 120)).filter(Boolean).slice(0, 100)
      : undefined;
    const support = typeof input["support"] === "string" ? input["support"].trim() : undefined;
    if (support) {
      let url: URL;
      try { url = new URL(support); } catch { throw new StationError("invalid_support", "the support link is a web address (https://...)"); }
      if (url.protocol !== "https:") throw new StationError("invalid_support", "the support link must be https");
    }
    const holder: Holder = {
      id,
      name: name || existing!.name,
      artists: words(input["artists"]) ?? existing?.artists ?? [],
      stations: (words(input["stations"]) ?? existing?.stations ?? []).filter((one) => /^[a-z0-9]{10}$/.test(one)),
      support: support ?? existing?.support ?? "",
      label: typeof input["label"] === "string" ? input["label"].trim().slice(0, 30) : existing?.label ?? "Support",
      license: typeof input["license"] === "string" ? input["license"].trim().slice(0, 120) : existing?.license ?? "",
    };
    this.holders.set(id, holder);
    this.save();
    return holder;
  }

  remove(id: string): boolean {
    const had = this.holders.delete(id);
    if (had) this.save();
    return had;
  }
}

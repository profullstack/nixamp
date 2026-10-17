/**
 * Our own songs' words, published back to nichedb.dev.
 *
 * A station whose owner declared the music theirs (basis "owned") and put it
 * on the public guide (public and listed) is music we may publish the words
 * of. For each of its files whose own tags carry lyrics (lyrics.ts), the
 * words go to nichedb's POST /api/v1/lyrics with the key the owner set
 * (NIXAMP_LYRICS_KEY, or `nixamp station lyrics key` into ai.json), once per
 * text: what was sent is remembered by a hash of the words, so a file is sent
 * again only when its words change. One at a time, a second apart, and a
 * refusal of the key (401/403) or a 429 stops the run.
 *
 * Nothing is published without a key, and nothing for a station that is not
 * owned, whatever else is true of it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lyricsFromTags, NICHEDB_LYRICS } from "./lyrics.ts";
import type { Station } from "./stations.ts";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Whether a station's lyrics may be published: owned, public and listed. */
export function mayPublishLyrics(station: Pick<Station, "visibility" | "listed" | "rights">): boolean {
  return station.rights?.basis === "owned" && station.visibility === "public" && station.listed === true;
}

/** Why not, in words, or "" when it may. */
export function whyNotPublish(station: Pick<Station, "visibility" | "listed" | "rights">): string {
  if (station.rights?.basis !== "owned") return "its music is not declared owned (nixamp station publish ID --basis owned)";
  if (station.visibility !== "public") return "it is not public";
  if (!station.listed) return "it is not listed on the guide";
  return "";
}

export interface PublishReport {
  station: string;
  published: number;
  unchanged: number;
  /** Files with no words in their tags, or no artist or title to file them under. */
  without: number;
  failed: number;
  stopped: string;
}

export interface LyricsPublisherOptions {
  file: string;
  /** The key nichedb takes, read each run (it may be set while the server runs); "" when unset. */
  key: () => string;
  stations: () => Station[];
  tags: (file: string) => Promise<Record<string, string>>;
  known?: (file: string) => { title: string; artist: string; album: string } | null;
  base?: string;
  fetcher?: Fetcher;
  /** Between two posts. */
  gapMs?: number;
  /** After a change, before a run (changes come in bursts). */
  debounceMs?: number;
  log?: (line: string) => void;
}

interface Sent { hash: string; at: number; artist: string; title: string }

export class LyricsPublisher {
  private sent: Record<string, Sent> = {};
  private running: Promise<PublishReport[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: { at: number; reports: PublishReport[] } | null = null;
  private lastError = "";
  private readonly base: string;
  private readonly fetcher: Fetcher;

  constructor(private readonly options: LyricsPublisherOptions) {
    this.base = (options.base ?? process.env["NIXAMP_LYRICS_URL"] ?? NICHEDB_LYRICS).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    try {
      const parsed = JSON.parse(readFileSync(options.file, "utf8")) as { sent?: Record<string, Sent> };
      this.sent = parsed.sent ?? {};
    } catch {
      this.sent = {};
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `lyrics-published-${port}.json`);
  }

  private save(): void {
    mkdirSync(dirname(this.options.file), { recursive: true });
    const temporary = `${this.options.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sent: this.sent }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.options.file);
  }

  /** Something changed (a station, the library): publish what is new, shortly. Nothing without a key. */
  soon(): void {
    // A run is already due: changes in a burst ride on it (a busy store saves often).
    if (!this.options.key() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publishAll().catch(() => undefined);
    }, this.options.debounceMs ?? 30_000);
    this.timer.unref?.();
  }

  status(): Record<string, unknown> {
    const eligible = this.options.stations().filter(mayPublishLyrics);
    return {
      key: this.options.key() !== "",
      target: this.base,
      published: Object.keys(this.sent).length,
      running: this.running !== null,
      last: this.last,
      lastError: this.lastError,
      stations: this.options.stations().map((one) => ({
        id: one.id,
        name: one.name,
        eligible: mayPublishLyrics(one),
        why: whyNotPublish(one),
        files: one.items.length,
        published: one.items.filter((file) => this.sent[file]).length,
      })),
      eligible: eligible.length,
    };
  }

  /** Every eligible station, one after another; a run already going is joined, not doubled. */
  publishAll(): Promise<PublishReport[]> {
    if (this.running) return this.running;
    this.running = (async () => {
      const reports: PublishReport[] = [];
      for (const station of this.options.stations().filter(mayPublishLyrics)) {
        const report = await this.publishOne(station);
        reports.push(report);
        if (report.stopped) break;
      }
      this.last = { at: Date.now(), reports };
      const sent = reports.reduce((sum, one) => sum + one.published, 0);
      if (sent > 0) this.options.log?.(`  lyrics: published ${sent} to ${this.base}.`);
      return reports;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** One station, now. Refused (stopped says why) when it may not be published or there is no key. */
  async publish(station: Station): Promise<PublishReport> {
    if (this.running) await this.running.catch(() => undefined);
    return this.publishOne(station);
  }

  private async publishOne(station: Station): Promise<PublishReport> {
    const report: PublishReport = { station: station.id, published: 0, unchanged: 0, without: 0, failed: 0, stopped: "" };
    const why = whyNotPublish(station);
    if (why) { report.stopped = `not published: ${why}`; return report; }
    const key = this.options.key();
    if (!key) { report.stopped = "no key: set NIXAMP_LYRICS_KEY or `nixamp station lyrics key`"; return report; }
    if (!this.base) { report.stopped = "no target: NIXAMP_LYRICS_URL is empty"; return report; }
    let first = true;
    for (const file of station.items) {
      let tags: Record<string, string> = {};
      try { tags = await this.options.tags(file); } catch { tags = {}; }
      const words = lyricsFromTags(tags);
      const known = this.options.known?.(file) ?? null;
      const title = tags["title"] || known?.title || "";
      const artist = tags["artist"] || tags["album_artist"] || known?.artist || "";
      const album = tags["album"] || known?.album || "";
      if (!words || !title || !artist) { report.without += 1; continue; }
      const hash = createHash("sha256").update(`${artist}\n${title}\n${words.text}`).digest("hex");
      if (this.sent[file]?.hash === hash) { report.unchanged += 1; continue; }
      if (!first) await new Promise((done) => setTimeout(done, this.options.gapMs ?? 1_000));
      first = false;
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}/api/v1/lyrics`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ artist, title, album, language: words.language, text: words.text, source: "embedded" }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        report.failed += 1;
        this.lastError = `could not reach ${this.base}: ${(error as Error).message}`;
        report.stopped = this.lastError;
        break;
      }
      if (response.ok) {
        this.sent[file] = { hash, at: Date.now(), artist, title };
        this.save();
        report.published += 1;
        continue;
      }
      report.failed += 1;
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      this.lastError = `nichedb answered ${response.status} for "${title}"${detail ? `: ${detail}` : ""}`;
      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
        report.stopped = this.lastError;
        break;
      }
    }
    return report;
  }
}

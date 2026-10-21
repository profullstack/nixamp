/**
 * AI radio: stations whose music is composed for them, a few tracks a day.
 *
 * An AI station is a style the owner wrote ("late-night lo-fi, dusty drums,
 * Rhodes"). On its schedule a language model writes the next track's title
 * and brief from that style and the titles already made (so it does not
 * repeat itself), a music model composes it, ffmpeg writes the tags, and the
 * file lands in a folder of Nixamp's own -- a managed library source -- and
 * joins the station's rotation on its next track. The station is an ordinary
 * station: same link, same runner, same breaks, same guide.
 *
 * Composition costs money, so it is metered in seconds of music per calendar
 * month across every AI station on this server, and stops for the month at
 * the cap rather than at the provider's bill. A provider that says the
 * account is out of credit stops it too, until the owner says go again.
 *
 * The music is the owner's to broadcast (a paid plan's commercial licence,
 * or a model of their own via `command`), so a station made with `publish`
 * is public and listed on the guide with the basis `owned`, and the note
 * says how it was made. Nobody else's music is ever asked for: the brief
 * names no artist and quotes no lyric.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aiKey } from "./ai-keys.ts";
import { NoModel, askJson, hasModel } from "./ai-text.ts";
import type { LibraryIndex, Probed } from "./library-index.ts";
import type { StationRunner } from "./station-runner.ts";
import { StationError, type StationStore } from "./stations.ts";

export interface AiTrack {
  file: string;
  title: string;
  /** The brief the music model was given. */
  prompt: string;
  seconds: number;
  /** Who wrote the brief and who composed it, e.g. "gemini-flash-latest + elevenlabs/music_v1". */
  made: string;
  createdAt: number;
}

export interface AiStation {
  key: string;
  name: string;
  /** The owner's words for the music. Every brief starts from these. */
  style: string;
  description: string;
  vocals: boolean;
  /** Length of each track, 30-300 s. */
  trackSeconds: number;
  /** New tracks a day once the first few exist. */
  perDay: number;
  enabled: boolean;
  /** Public, listed, basis owned, as soon as it has a track. */
  publish: boolean;
  /** The station it plays on; "" until the first track exists. */
  stationId: string;
  tracks: AiTrack[];
  lastAttemptAt: number;
  lastError: string;
  /** Failures in a row; backs off after each. */
  failures: number;
  createdAt: number;
}

export interface Preset {
  name: string;
  style: string;
  description: string;
  vocals: boolean;
}

/** Styles to start from: `nixamp station ai create --preset lofi`. */
export const PRESETS: Record<string, Preset> = {
  lofi: { name: "AI Lo-Fi Beats", style: "mellow lo-fi hip hop, dusty swung drums, warm Rhodes and jazz guitar chords, vinyl crackle, 70-85 BPM, relaxed and nostalgic", description: "Lo-fi beats to study and drift to, composed by AI.", vocals: false },
  synthwave: { name: "AI Synthwave", style: "retro 80s synthwave, gated reverb drums, analog bass arpeggios, neon pads, soaring lead synth, 95-118 BPM, night-drive mood", description: "Neon night drives, composed by AI.", vocals: false },
  ambient: { name: "AI Ambient", style: "slow evolving ambient, soft drones, granular textures, distant piano, field-recording air, no drums, calm and spacious", description: "Slow, spacious ambient, composed by AI.", vocals: false },
  chiptune: { name: "AI Chiptune", style: "8-bit and 16-bit video game chiptune, square-wave leads, noise-channel drums, fast arpeggios, upbeat and playful, 130-160 BPM", description: "Chiptune for an imaginary console, composed by AI.", vocals: false },
  punk: { name: "AI Punk", style: "fast loud garage punk rock, distorted power chords, driving bass, pounding drums, shouted gang vocals, raw and energetic, 170-200 BPM", description: "Three chords and the truth, composed by AI.", vocals: true },
  jazz: { name: "AI Late Night Jazz", style: "smoky late-night jazz trio and quartet, upright bass, brushed drums, piano comping, muted trumpet or tenor sax solos, swing and ballads", description: "A jazz club that never closes, composed by AI.", vocals: false },
};

export const DEFAULTS = { trackSeconds: 120, perDay: 2, monthlySeconds: 900, seedTracks: 3 };
const MAX_STYLE = 600;
const MAX_TRACKS = 5_000;
/** Between tries after a failure: 5 min, doubling, at most 6 h. */
const BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000, 80 * 60_000, 6 * 3600_000];

export interface Composer {
  /** e.g. "elevenlabs/music_v1". */
  name: string;
  /** Writes an MP3 to `out`. Throws OutOfCredit when the account cannot pay. `lyrics` are the words to sing, when there are any. */
  compose(input: { prompt: string; seconds: number; vocals: boolean; out: string; lyrics?: string }): Promise<void>;
}

export class OutOfCredit extends Error {}

/** ElevenLabs' music models; NIXAMP_MUSIC_MODEL picks one, the newest by default. */
export const MUSIC_MODELS = ["music_v1", "music_v2", "music_v2_5"] as const;

/** ElevenLabs Music: a paid plan's music may be broadcast. Given lyrics, it sings those words. */
export function elevenLabsComposer(key: string, fetcher: typeof fetch = fetch, model = "music_v2_5"): Composer {
  return {
    name: `elevenlabs/${model}`,
    async compose({ prompt, seconds, vocals, out, lyrics }) {
      const words = vocals && lyrics?.trim() ? lyrics.trim() : "";
      const ask = async (text: string): Promise<Response> => fetcher("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
        method: "POST",
        signal: AbortSignal.timeout(10 * 60_000),
        headers: { "content-type": "application/json", "xi-api-key": key },
        body: JSON.stringify({
          prompt: text, music_length_ms: Math.round(seconds * 1000), model_id: model,
          ...(words ? { lyrics_text: words } : { force_instrumental: !vocals }),
        }),
      });
      let response = await ask(prompt);
      if (response.status === 400) {
        // A brief it will not make (an artist's name, a lyric) comes back
        // with one it will; take it once.
        const body = await response.json().catch(() => ({})) as { detail?: { status?: string; data?: { prompt_suggestion?: string } } };
        const suggestion = body.detail?.data?.prompt_suggestion;
        if (!suggestion) throw new Error(`elevenlabs refused the brief (${body.detail?.status ?? "HTTP 400"})`);
        response = await ask(suggestion);
      }
      if (response.status === 401 || response.status === 402) throw new OutOfCredit(`elevenlabs answered HTTP ${response.status}: the key or the plan's credit`);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (/quota|credit/i.test(text)) throw new OutOfCredit(`elevenlabs is out of credit: ${text.slice(0, 200)}`);
        throw new Error(`elevenlabs answered HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1024) throw new Error("elevenlabs answered with no music");
      writeFileSync(out, bytes);
    },
  };
}

/**
 * A model of the owner's own (MusicGen, ACE-Step...): NIXAMP_AI_MUSIC_COMMAND
 * is run with {prompt}, {seconds}, {vocals}, {lyrics} (a file of the words to
 * sing, "" when there are none) and {out} replaced, each as one argument, and
 * must leave an MP3 at {out}.
 */
export function commandComposer(template: string): Composer {
  const words = template.trim().split(/\s+/);
  return {
    name: `command/${words[0]?.split("/").pop() ?? "music"}`,
    compose: ({ prompt, seconds, vocals, out, lyrics }) => new Promise((resolve, reject) => {
      const lyricsFile = lyrics?.trim() ? `${out}.lyrics.txt` : "";
      if (lyricsFile) writeFileSync(lyricsFile, `${lyrics!.trim()}\n`);
      const argv = words.map((one) => one.replace("{prompt}", prompt).replace("{seconds}", String(seconds)).replace("{vocals}", vocals ? "1" : "0").replace("{lyrics}", lyricsFile).replace("{out}", out));
      execFile(argv[0]!, argv.slice(1), { timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error) => {
        if (lyricsFile) rmSync(lyricsFile, { force: true });
        if (error) return reject(new Error(`the music command failed: ${error.message}`));
        try {
          if (statSync(out).size < 1024) return reject(new Error("the music command left no music"));
        } catch {
          return reject(new Error("the music command left no file at {out}"));
        }
        resolve();
      });
    }),
  };
}

/** The composer this server can use, or null with the reason. */
export function composerFromEnv(env: Record<string, string | undefined> = process.env): Composer | null {
  const command = (env["NIXAMP_AI_MUSIC_COMMAND"] ?? "").trim();
  if (command) return commandComposer(command);
  const key = aiKey("ELEVENLABS_API_KEY", env);
  const model = aiKey("NIXAMP_MUSIC_MODEL", env);
  return key ? elevenLabsComposer(key, fetch, (MUSIC_MODELS as readonly string[]).includes(model) ? model : "music_v2_5") : null;
}

const MOODS = ["dreamy", "driving", "melancholy", "bright", "hazy", "tense", "playful", "warm", "nocturnal", "triumphant"];
const WORDS = ["Neon", "Harbor", "Velvet", "Static", "Paper", "Lantern", "Satellite", "Ember", "Glass", "Tide", "Orchard", "Signal"];
const PLACES = ["Avenue", "Hours", "Drift", "Motel", "Rooftops", "Weather", "Lines", "Garden", "Frequency", "Afterglow", "Window", "Run"];

/** A brief without a language model: the style, with a mood and a name drawn for it. */
export function plainBrief(station: Pick<AiStation, "style" | "tracks">, random: () => number = Math.random): { title: string; prompt: string } {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const taken = new Set(station.tracks.map((one) => one.title.toLowerCase()));
  let title = "";
  for (let tries = 0; tries < 20 && (title === "" || taken.has(title.toLowerCase())); tries++) title = `${pick(WORDS)} ${pick(PLACES)}`;
  if (taken.has(title.toLowerCase())) title = `${title} ${station.tracks.length + 1}`;
  return { title, prompt: `${station.style}. A ${pick(MOODS)} piece called "${title}", with a clear intro, development and ending.` };
}

const SYSTEM = [
  "You write briefs for an AI music generator that composes original tracks for an internet radio station.",
  "Each brief is one paragraph of at most 400 characters: genre, tempo, key or mode, instruments, structure, mood.",
  "Never name a real artist, band, song, album or label, and never quote existing lyrics.",
  "Answer as JSON: {\"title\": \"a fresh 1-5 word track title\", \"prompt\": \"the brief\"}.",
].join(" ");

export async function writeBrief(
  station: Pick<AiStation, "name" | "style" | "vocals" | "tracks">,
  ask: typeof askJson = askJson,
): Promise<{ title: string; prompt: string; model: string }> {
  const recent = station.tracks.slice(-15).map((one) => one.title);
  const answer = await ask({
    system: SYSTEM,
    prompt: [
      `Station: ${station.name}`,
      `Style: ${station.style}`,
      station.vocals ? "The track has sung vocals; describe the voice and what the song is about (the generator writes the words)." : "Instrumental: no vocals.",
      recent.length ? `Titles already on the station (do not reuse or echo them; vary tempo, mood and instruments within the style): ${recent.join("; ")}` : "This is the station's first track.",
    ].join("\n"),
  });
  const title = String(answer.value["title"] ?? "").replace(/[\r\n"]/g, " ").trim().slice(0, 80);
  const prompt = String(answer.value["prompt"] ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 600);
  if (!title || !prompt) throw new Error("the model wrote no title or brief");
  return { title, prompt, model: answer.model };
}

function slug(text: string): string {
  return text.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, " ").slice(0, 80) || "track";
}

export interface AiRadioDeps {
  index: LibraryIndex;
  store: StationStore;
  runner: StationRunner;
  probe: (path: string) => Promise<Probed>;
  /** ffmpeg argv prefix, for the tags. */
  ffmpeg: string[];
  /** The folder the music goes in: a managed library source. */
  root: string;
  owner: string;
  /** Who holds the rights in what is made ("Profullstack, Inc."), written as publisher and copyright; "" for none. */
  holder?: () => string;
  /** Whether another station may be started now (the server's running limit). */
  mayStart: () => boolean;
  composer?: () => Composer | null;
  /** Writes `from` with these tags to `to`; ffmpeg's stream copy by default. */
  tag?: (from: string, to: string, tags: Record<string, string>) => Promise<void>;
  ask?: typeof askJson;
  canAsk?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface AiRadioSettings {
  /** Seconds of music a month across every AI station; 0 for no cap. */
  monthlySeconds: number;
  /** Set by a provider that is out of credit; cleared by `resume`. */
  pausedReason: string;
}

function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** Write title/artist/album/genre into the file, so every player shows them. */
function tag(ffmpeg: string[], from: string, to: string, tags: Record<string, string>): Promise<void> {
  const args = [...ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-y", "-i", from, "-map", "0:a", "-c", "copy", "-id3v2_version", "3"];
  for (const [name, value] of Object.entries(tags)) args.push("-metadata", `${name}=${value}`);
  args.push(to);
  return new Promise((resolve, reject) => {
    execFile(ffmpeg[0]!, args, { timeout: 120_000 }, (error) => (error ? reject(new Error(`tagging failed: ${error.message}`)) : resolve()));
  });
}

export class AiRadio {
  private stations = new Map<string, AiStation>();
  private settings: AiRadioSettings = { monthlySeconds: DEFAULTS.monthlySeconds, pausedReason: "" };
  private usage: Record<string, number> = {};
  private busy: string | null = null;
  private sourceId = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly file: string, private readonly deps: AiRadioDeps) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { stations?: AiStation[]; settings?: Partial<AiRadioSettings>; usage?: Record<string, number> };
      for (const one of parsed.stations ?? []) if (one?.key) this.stations.set(one.key, { ...one, tracks: one.tracks ?? [] });
      this.settings = { ...this.settings, ...(parsed.settings ?? {}) };
      this.usage = parsed.usage ?? {};
    } catch {
      // Nothing yet.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `ai-radio-${port}.json`);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, settings: this.settings, usage: this.usage, stations: [...this.stations.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private source(): string {
    if (this.sourceId && this.deps.index.source(this.sourceId)) return this.sourceId;
    mkdirSync(this.deps.root, { recursive: true });
    this.sourceId = this.deps.index.addManagedSource(this.deps.root).id;
    return this.sourceId;
  }

  private composer(): Composer | null {
    return this.deps.composer ? this.deps.composer() : composerFromEnv();
  }

  list(): AiStation[] {
    return [...this.stations.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(key: string): AiStation | undefined {
    return this.stations.get(key);
  }

  /** The track AI radio composed at this path, if it did. */
  trackAt(file: string): AiTrack | undefined {
    for (const station of this.stations.values()) {
      const hit = station.tracks.find((one) => one.file === file);
      if (hit) return hit;
    }
    return undefined;
  }

  /** What the owner sees: the stations, this month's seconds, and why nothing is being made. */
  status(): Record<string, unknown> {
    const month = monthOf(this.now());
    const composer = this.composer();
    return {
      composer: composer?.name ?? null,
      writer: (this.deps.canAsk ?? hasModel)() ? "language model" : "plain (no model key)",
      busy: this.busy,
      month,
      secondsThisMonth: this.usage[month] ?? 0,
      monthlySeconds: this.settings.monthlySeconds,
      paused: this.settings.pausedReason || (composer ? "" : "no composer: set ELEVENLABS_API_KEY (nixamp station ai key ELEVENLABS_API_KEY) or NIXAMP_AI_MUSIC_COMMAND"),
      presets: Object.keys(PRESETS),
      stations: this.list().map((one) => ({ ...one, tracks: one.tracks.length, latest: one.tracks.slice(-5).map(({ title, seconds, made, createdAt }) => ({ title, seconds, made, createdAt })), nextAt: this.nextAt(one) })),
    };
  }

  /** Change the month's cap; `resume` clears a stop for lack of credit. */
  configure(input: Record<string, unknown>): AiRadioSettings {
    if (input["monthlySeconds"] !== undefined) {
      const value = Number(input["monthlySeconds"]);
      if (!Number.isInteger(value) || value < 0 || value > 1_000_000) throw new StationError("invalid_budget", "monthlySeconds is whole seconds, 0 for no cap");
      this.settings.monthlySeconds = value;
    }
    if (input["resume"] === true) this.settings.pausedReason = "";
    this.save();
    return this.settings;
  }

  create(input: Record<string, unknown>): AiStation {
    const preset = typeof input["preset"] === "string" ? PRESETS[input["preset"]] : undefined;
    if (input["preset"] !== undefined && !preset) throw new StationError("unknown_preset", `presets: ${Object.keys(PRESETS).join(", ")}`);
    const name = String(input["name"] ?? preset?.name ?? "").trim().slice(0, 120);
    const style = String(input["style"] ?? preset?.style ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, MAX_STYLE);
    if (!name) throw new StationError("name_required", "an AI station needs a name (or a preset)");
    if (style.length < 10) throw new StationError("style_required", "describe the music in a few words: genre, instruments, mood, tempo");
    const seconds = input["trackSeconds"] === undefined ? DEFAULTS.trackSeconds : Number(input["trackSeconds"]);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300) throw new StationError("invalid_length", "trackSeconds is 30 to 300");
    const perDay = input["perDay"] === undefined ? DEFAULTS.perDay : Number(input["perDay"]);
    if (!Number.isInteger(perDay) || perDay < 0 || perDay > 48) throw new StationError("invalid_rate", "perDay is 0 to 48 tracks");
    const station: AiStation = {
      key: randomBytes(5).toString("hex"),
      name,
      style,
      description: String(input["description"] ?? preset?.description ?? "").trim().slice(0, 500),
      vocals: input["vocals"] === undefined ? preset?.vocals ?? false : input["vocals"] === true,
      trackSeconds: seconds,
      perDay,
      enabled: input["enabled"] !== false,
      publish: input["publish"] !== false,
      stationId: "",
      tracks: [],
      lastAttemptAt: 0,
      lastError: "",
      failures: 0,
      createdAt: this.now(),
    };
    this.stations.set(station.key, station);
    this.save();
    void this.tick();
    return station;
  }

  update(key: string, input: Record<string, unknown>): AiStation {
    const station = this.require(key);
    if (typeof input["style"] === "string" && input["style"].trim().length >= 10) station.style = input["style"].replace(/[\r\n]+/g, " ").trim().slice(0, MAX_STYLE);
    if (typeof input["name"] === "string" && input["name"].trim()) station.name = input["name"].trim().slice(0, 120);
    if (typeof input["description"] === "string") station.description = input["description"].trim().slice(0, 500);
    if (input["vocals"] !== undefined) station.vocals = input["vocals"] === true;
    if (input["enabled"] !== undefined) station.enabled = input["enabled"] !== false;
    if (input["publish"] !== undefined) station.publish = input["publish"] !== false;
    if (input["perDay"] !== undefined) {
      const perDay = Number(input["perDay"]);
      if (!Number.isInteger(perDay) || perDay < 0 || perDay > 48) throw new StationError("invalid_rate", "perDay is 0 to 48 tracks");
      station.perDay = perDay;
    }
    if (input["trackSeconds"] !== undefined) {
      const seconds = Number(input["trackSeconds"]);
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300) throw new StationError("invalid_length", "trackSeconds is 30 to 300");
      station.trackSeconds = seconds;
    }
    station.failures = 0;
    station.lastError = "";
    if (station.stationId && this.deps.store.get(station.stationId)) {
      this.deps.store.update(station.stationId, { name: station.name, description: station.description }, null);
    }
    this.save();
    return station;
  }

  /** Forget an AI station. Its music and its station stay unless `files` is true. */
  remove(key: string, files = false): void {
    const station = this.require(key);
    if (files) {
      if (station.stationId) this.deps.runner.remove(station.stationId);
      rmSync(join(this.deps.root, station.key), { recursive: true, force: true });
      void this.deps.index.scan(this.source(), this.deps.probe).done;
    }
    this.stations.delete(key);
    this.save();
  }

  /** When this station's next track is due; 0 when now, -1 when never. */
  nextAt(station: AiStation): number {
    if (!station.enabled) return -1;
    if (station.failures > 0) return station.lastAttemptAt + BACKOFF_MS[Math.min(station.failures, BACKOFF_MS.length) - 1]!;
    if (station.tracks.length < DEFAULTS.seedTracks) return 0;
    if (station.perDay === 0) return -1;
    const last = station.tracks[station.tracks.length - 1]!.createdAt;
    return last + Math.floor(86_400_000 / station.perDay);
  }

  /** Every 5 minutes: the station most overdue gets its next track. One at a time. */
  startSchedule(everyMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    void this.tick();
  }

  stopSchedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private budgetLeft(): number {
    if (this.settings.monthlySeconds === 0) return Number.POSITIVE_INFINITY;
    return this.settings.monthlySeconds - (this.usage[monthOf(this.now())] ?? 0);
  }

  async tick(): Promise<void> {
    if (this.busy || this.settings.pausedReason) return;
    const now = this.now();
    const due = this.list()
      .map((one) => ({ one, at: this.nextAt(one) }))
      .filter(({ one, at }) => at !== -1 && at <= now && one.tracks.length < MAX_TRACKS && one.trackSeconds <= this.budgetLeft())
      .sort((a, b) => a.at - b.at)[0];
    if (!due || !this.composer()) return;
    await this.generate(due.one.key).catch(() => undefined);
  }

  /** Compose one track for this station now (the owner's "generate"), within the month's cap. */
  async generate(key: string): Promise<AiTrack> {
    const station = this.require(key);
    if (this.busy) throw new StationError("busy", `already composing for ${this.busy}; one track at a time`, 409);
    if (this.settings.pausedReason) throw new StationError("paused", this.settings.pausedReason, 409);
    if (station.trackSeconds > this.budgetLeft()) throw new StationError("budget_used", `this month's ${this.settings.monthlySeconds} s of AI music is used; raise it with monthlySeconds`, 429);
    const composer = this.composer();
    if (!composer) throw new StationError("no_composer", "set ELEVENLABS_API_KEY (nixamp station ai key ELEVENLABS_API_KEY) or NIXAMP_AI_MUSIC_COMMAND", 409);
    this.busy = key;
    station.lastAttemptAt = this.now();
    const log = this.deps.log ?? (() => undefined);
    const folder = join(this.deps.root, station.key);
    const raw = join(folder, `.${randomBytes(4).toString("hex")}.raw.mp3`);
    try {
      let brief: { title: string; prompt: string; model: string };
      try {
        brief = await writeBrief(station, this.deps.ask ?? askJson);
      } catch (error) {
        // No model, or one that failed: the station still gets music.
        if (!(error instanceof NoModel)) log(`  ai radio: ${station.name}: brief from the model failed (${(error as Error).message}); using the style as it is`);
        brief = { ...plainBrief(station), model: "plain" };
      }
      mkdirSync(folder, { recursive: true });
      log(`  ai radio: composing "${brief.title}" for ${station.name} (${station.trackSeconds} s, ${composer.name})`);
      await composer.compose({ prompt: brief.prompt, seconds: station.trackSeconds, vocals: station.vocals, out: raw });
      const month = monthOf(this.now());
      this.usage[month] = (this.usage[month] ?? 0) + station.trackSeconds;
      const file = join(folder, `${String(station.tracks.length + 1).padStart(4, "0")} ${slug(brief.title)}.mp3`);
      const year = new Date(this.now()).getUTCFullYear().toString();
      const holder = this.deps.holder?.() ?? "";
      await (this.deps.tag ?? ((from, to, tags) => tag(this.deps.ffmpeg, from, to, tags)))(raw, file, {
        title: brief.title,
        artist: `${station.name} (AI)`,
        album: station.name,
        genre: "AI",
        comment: `Composed by ${composer.name} from a brief by ${brief.model}`,
        date: year,
        ...(holder ? { publisher: holder, copyright: `℗ ${year} ${holder}` } : {}),
      });
      const track: AiTrack = { file, title: brief.title, prompt: brief.prompt, seconds: station.trackSeconds, made: `${brief.model} + ${composer.name}`, createdAt: this.now() };
      station.tracks.push(track);
      station.failures = 0;
      station.lastError = "";
      this.save();
      await this.place(station);
      log(`  ai radio: "${brief.title}" is on ${station.name} (${station.tracks.length} tracks)`);
      return track;
    } catch (error) {
      station.failures += 1;
      station.lastError = (error as Error).message;
      if (error instanceof OutOfCredit) {
        this.settings.pausedReason = `${(error as Error).message}; resume with \`nixamp station ai resume\` once there is credit`;
      }
      this.save();
      log(`  ai radio: ${station.name}: ${station.lastError}`);
      throw error instanceof StationError ? error : new StationError("compose_failed", station.lastError, 502);
    } finally {
      rmSync(raw, { force: true });
      this.busy = null;
    }
  }

  /** The station gets its tracks: made with the first one, then kept in step. */
  private async place(station: AiStation): Promise<void> {
    await this.deps.index.scan(this.source(), this.deps.probe).done;
    const files = station.tracks.map((one) => one.file).filter((file) => this.deps.index.itemAt(file)?.state === "ready");
    if (files.length === 0) return;
    const existing = station.stationId ? this.deps.store.get(station.stationId) : undefined;
    if (existing) {
      this.deps.store.update(existing.id, {}, files);
      return;
    }
    const made = this.deps.store.create({ name: station.name, description: station.description, shuffle: true, repeat: true }, files, this.deps.owner);
    this.deps.store.markAuto(made.id, `ai:${station.key}`);
    if (station.publish) {
      this.deps.store.setAccess(made.id, {
        visibility: "public",
        listed: true,
        rights: { basis: "owned", note: `Original music composed for this station by AI (${this.composer()?.name ?? "a music model"}); no third-party recordings.` },
      }, this.deps.owner || "ai-radio");
    } else {
      this.deps.store.setAccess(made.id, { visibility: "unlisted" }, this.deps.owner || "ai-radio");
    }
    station.stationId = made.id;
    this.save();
    if (this.deps.mayStart()) await this.deps.runner.start(made.id).catch(() => undefined);
  }

  private require(key: string): AiStation {
    const station = this.stations.get(key);
    if (!station) throw new StationError("not_found", "no such AI station", 404);
    return station;
  }
}

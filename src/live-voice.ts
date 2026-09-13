/** ElevenLabs Flash for live captions. The key stays on the account server. */
import { createHash, randomBytes } from "node:crypto";
import { SpeechError, decodeWav, encodeWav, quietSamples } from "./speech.ts";
import { speakerTurns, type ScribeResult, type SpeakerTranscript } from "./speaker-turns.ts";
import type { VoiceProfile } from "./voice-profile.ts";
import { Guard } from "./guard.ts";
import type { TranslationMeter } from "./translation-passes.ts";
import type { Queryable } from "./follows.ts";

export const LIVE_VOICE_MODEL = "eleven_flash_v2_5";
export const LIVE_VOICE_RATE = 16_000;
export const LIVE_VOICE_LANGUAGES = new Set("en ja zh de hi fr ko pt it es id nl tr fil pl sv bg ro ar cs el fi hr ms sk da ta uk ru hu no vi".split(" "));
export interface LiveVoiceChoice { id: string; name: string; gender: string; language: string; }
export interface VoiceRequest { text: string; language: string; voice?: string; profile?: VoiceProfile; channel?: string; speaker?: string; }
const HEADERS = { "content-type": "audio/pcm", "cache-control": "no-store", "x-audio-sample-rate": String(LIVE_VOICE_RATE) };
const budget = (value: number | undefined, fallback: number): number => Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;

export class LiveVoice {
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private catalog: Promise<LiveVoiceChoice[]> | null = null;
  private catalogUntil = 0;
  private readonly cache = new Map<string, { until: number; bytes: Uint8Array }>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly usage = new Map<string, { minute: number; chars: number }>();
  private readonly charsPerMinute: number;
  private readonly requests: Guard;
  private readonly grants = new Map<string, { by: string; channel: string; expires: number; remaining: number }>();
  private readonly activeBy = new Map<string, number>();
  private readonly db?: Queryable;
  private readonly billing?: TranslationMeter;
  private schema: Promise<unknown> | null = null;
  private readonly dailyChars: number;
  private cleanupAt = 0;
  private readonly hearing = new Set<string>();
  private readonly dailyAudioSeconds: number;
  private readonly userDailyChars: number;
  private readonly userDailyAudioSeconds: number;

  constructor(options: { apiKey?: string; fetcher?: typeof fetch; now?: () => number; charsPerMinute?: number; dailyChars?: number; dailyAudioSeconds?: number; userDailyChars?: number; userDailyAudioSeconds?: number; db?: Queryable; billing?: TranslationMeter } = {}) {
    this.key = options.apiKey ?? process.env["ELEVENLABS_API_KEY"] ?? "";
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.charsPerMinute = budget(options.charsPerMinute, 3000);
    this.dailyChars = budget(options.dailyChars, 200_000);
    this.dailyAudioSeconds = budget(options.dailyAudioSeconds, 86_400);
    this.userDailyChars = budget(options.userDailyChars, 120_000);
    this.userDailyAudioSeconds = budget(options.userDailyAudioSeconds, 43_200);
    this.requests = new Guard(this.now);
    this.db = options.db;
    this.billing = options.billing;
  }

  available(): boolean { return this.key !== ""; }

  /** Optional diarization, billed only while a signed-in listener requests it.
   * Rolling audio is bounded to 15 seconds, including overlap. Every second
   * submitted (also repeated context) consumes the persistent provider budget. */
  async hear(bytes: Uint8Array, by: string, signal?: AbortSignal, meter = this.billing): Promise<SpeakerTranscript> {
    if (!this.available()) throw new SpeechError("speaker voices are unavailable", 503);
    await meter?.require(by);
    const wav = decodeWav(bytes);
    const seconds = wav.samples.length / wav.rate;
    if (wav.rate !== 16000 || wav.channels !== 1 || seconds < 0.2 || seconds > 15.1) throw new SpeechError("send up to 15 seconds of mono 16 kHz WAV", 400);
    if (wav.samples.some(sample => !Number.isFinite(sample))) throw new SpeechError("invalid audio samples", 400);
    if (!this.requests.check(`hear:${by}`, { allowed: 36, windowMs: 60_000 }).ok) throw new SpeechError("too many speaker transcription requests", 429);
    if (quietSamples(wav.samples)) return { language: "", seconds, turns: [] };
    if (this.hearing.has(by) || this.hearing.size >= 4) throw new SpeechError("speaker transcription is busy", 429);
    this.hearing.add(by);
    let reservation: string | undefined;
    let accepted = false;
    try {
      const billed = Math.ceil(seconds);
      await this.reserve(`scribe:user:${by}`, billed, 300, 60_000);
      await this.reserve("scribe:server", billed, 600, 60_000);
      await this.reserve(`scribe:user:${by}`, billed, this.userDailyAudioSeconds, 86_400_000);
      await this.reserve("scribe:server", billed, this.dailyAudioSeconds, 86_400_000);
      signal?.throwIfAborted();
      const form = new FormData();
      // Canonical PCM prevents a crafted container from billing more audio
      // than the duration we validated, and removes uploaded metadata.
      form.set("file", new Blob([new Uint8Array(encodeWav(wav.samples))], { type: "audio/wav" }), "listening.wav");
      form.set("model_id", "scribe_v2");
      form.set("diarize", "true");
      form.set("tag_audio_events", "false");
      form.set("timestamps_granularity", "word");
      // No language_code: preserve the source language, including Spanish.
      reservation = await meter?.reserve(by, "transcription", wav.samples.length);
      const answer = await this.fetcher("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST", headers: { "xi-api-key": this.key }, body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!answer.ok) throw new SpeechError("speaker transcription could not run; check provider quota and permissions", answer.status === 429 ? 429 : 502);
      accepted = true;
      if (reservation) await meter!.commit(reservation);
      return speakerTurns(await answer.json() as ScribeResult, wav);
    } catch (error) {
      if (reservation && !accepted) await meter!.refund(reservation);
      throw error;
    } finally { this.hearing.delete(by); }
  }

  async voices(): Promise<LiveVoiceChoice[]> {
    if (!this.available()) throw new SpeechError("translated audio needs ELEVENLABS_API_KEY on the account server", 503);
    if (!this.catalog || this.now() >= this.catalogUntil) {
      this.catalogUntil = this.now() + 3600_000;
      this.catalog = this.fetcher("https://api.elevenlabs.io/v2/voices?page_size=100&voice_type=default", {
        headers: { "xi-api-key": this.key }, signal: AbortSignal.timeout(8000),
      }).then(async response => {
        if (!response.ok) throw new SpeechError("ElevenLabs could not list voices; check the server key and its voice permissions", 503);
        const body = await response.json() as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
        return body.voices.filter(voice => /^[a-zA-Z0-9_-]+$/.test(voice.voice_id)).map(voice => ({
          id: voice.voice_id, name: voice.name, gender: voice.labels?.["gender"] ?? "neutral", language: voice.labels?.["language"] ?? "",
        }));
      }).catch(error => { this.catalog = null; throw error; });
    }
    return this.catalog;
  }

  /** A 90-second capability for one channel, never the viewer's account credential. */
  async grant(by: string, channel: string): Promise<{ token: string; expires: number }> {
    if (!/^[\w-]{1,80}$/.test(channel)) throw new SpeechError("choose a playback session or live channel", 400);
    if (!this.requests.check(`grant:${by}`, { allowed: 10, windowMs: 60_000 }).ok) throw new SpeechError("too many audio authorization requests", 429);
    await this.billing?.require(by);
    for (const [token, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(token);
    if (this.grants.size >= 5000) throw new SpeechError("audio authorization is busy", 503);
    const token = `nxd_${randomBytes(32).toString("base64url")}`;
    const expires = this.now() + 90_000;
    if (this.db) {
      await this.ensure();
      await this.db.query("INSERT INTO live_voice_grants (token_hash, by_account, channel, expires_at, remaining) VALUES ($1, $2, $3, $4, 2000)", [createHash("sha256").update(token).digest("hex"), by, channel, new Date(expires)]);
    } else this.grants.set(token, { by, channel, expires, remaining: 2000 });
    return { token, expires };
  }

  async authorize(token: string, channel: string, chars: number): Promise<string> {
    if (!/^nxd_[A-Za-z0-9_-]{43}$/.test(token)) throw new SpeechError("sign in to enable translated audio", 401);
    if (!Number.isFinite(chars) || chars < 1 || chars > 600) throw new SpeechError("invalid caption length", 400);
    if (this.db) {
      await this.ensure();
      const result = await this.db.query(`UPDATE live_voice_grants SET remaining = remaining - $3
        WHERE token_hash = $1 AND channel = $2 AND expires_at > $4 AND remaining >= $3 RETURNING by_account`, [createHash("sha256").update(token).digest("hex"), channel, chars, new Date(this.now())]);
      if (!result.rows.length) throw new SpeechError("audio authorization expired or reached its limit; enable translated audio again", 401);
      return String(result.rows[0]?.["by_account"]);
    }
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= this.now() || grant.channel !== channel) throw new SpeechError("sign in to renew translated audio", 401);
    if (grant.remaining < chars) throw new SpeechError("this audio authorization reached its character limit", 429);
    grant.remaining -= chars;
    return grant.by;
  }

  private async ensure(): Promise<void> {
    if (!this.db) return;
    this.schema ??= (async () => {
      await this.db!.query("CREATE TABLE IF NOT EXISTS live_voice_usage (bucket TEXT PRIMARY KEY, chars BIGINT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)");
      await this.db!.query("CREATE TABLE IF NOT EXISTS live_voice_grants (token_hash TEXT PRIMARY KEY, by_account TEXT NOT NULL, channel TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, remaining INTEGER NOT NULL)");
    })().catch(error => { this.schema = null; throw error; });
    await this.schema;
    if (this.now() >= this.cleanupAt) {
      this.cleanupAt = this.now() + 60_000;
      // Keep only live windows; accounting survives restarts and is shared by replicas.
      await this.db.query("DELETE FROM live_voice_usage WHERE expires_at <= $1", [new Date(this.now())]);
      await this.db.query("DELETE FROM live_voice_grants WHERE expires_at <= $1", [new Date(this.now())]);
    }
  }

  private async reserve(bucket: string, chars: number, limit: number, windowMs: number): Promise<void> {
    if (chars > limit) throw new SpeechError("translated audio reached its character budget; try again later", 429);
    const window = Math.floor(this.now() / windowMs);
    const key = `${bucket}:${windowMs}:${window}`;
    if (this.db) {
      await this.ensure();
      const result = await this.db.query(`INSERT INTO live_voice_usage (bucket, chars, expires_at) VALUES ($1, $2, $4)
        ON CONFLICT (bucket) DO UPDATE SET chars = live_voice_usage.chars + EXCLUDED.chars
        WHERE live_voice_usage.chars + EXCLUDED.chars <= $3 RETURNING chars`, [key, chars, limit, new Date((window + 1) * windowMs)]);
      if (!result.rows.length) throw new SpeechError("translated audio reached its character budget; try again later", 429);
      return;
    }
    // Local/single-process installations without a database. Account servers pass their pool.
    const record = this.usage.get(key) ?? { minute: (window + 1) * windowMs, chars: 0 };
    if (record.chars + chars > limit) throw new SpeechError("translated audio reached its character budget; try again later", 429);
    record.chars += chars; this.usage.set(key, record);
  }

  private async charge(by: string, channel: string, chars: number): Promise<void> {
    for (const [key, record] of this.usage) if (record.minute <= this.now()) this.usage.delete(key);
    await this.reserve(`user:${by}`, chars, this.charsPerMinute, 60_000);
    await this.reserve(`channel:${channel}`, chars, 6000, 60_000);
    await this.reserve("server", chars, 12_000, 60_000);
    await this.reserve(`user:${by}`, chars, this.userDailyChars, 86400_000);
    await this.reserve("server", chars, this.dailyChars, 86400_000);
  }

  private checkRequest(by: string): void {
    if (!this.requests.check(`audio:${by}`, { allowed: 60, windowMs: 60_000 }).ok) throw new SpeechError("too many translated audio requests", 429);
  }

  /** Stream the first request immediately; concurrent listeners share its cached result. */
  async stream(ask: VoiceRequest, by: string, signal?: AbortSignal, meter = this.billing): Promise<Response> {
    this.checkRequest(by);
    await meter?.require(by);
    const text = typeof ask.text === "string" ? ask.text.trim() : "";
    if (!text || text.length > 600) throw new SpeechError("translated audio needs a caption of 1–600 characters", 400);
    if (!LIVE_VOICE_LANGUAGES.has(ask.language)) throw new SpeechError("this language is not supported by Flash voices", 400);
    const voices = await this.voices();
    signal?.throwIfAborted();
    // The browser chooses unique voices for speakers. Legacy callers get a
    // stable stock voice; pitch is not used to infer gender.
    const seed = createHash("sha256").update(`${ask.channel ?? ""}|${ask.speaker ?? ""}`).digest().readUInt32BE(0);
    const voice = ask.voice && ask.voice !== "auto"
      ? voices.find(voice => voice.id === ask.voice)
      : voices[seed % voices.length];
    if (!voice) throw new SpeechError("choose an available voice", 400);
    const id = createHash("sha256").update(JSON.stringify([LIVE_VOICE_MODEL, voice.id, ask.language, text])).digest("hex");
    for (const [key, item] of this.cache) if (item.until < this.now()) this.cache.delete(key);
    const cached = this.cache.get(id);
    const pending = this.pending.get(id);
    if (cached || pending) {
      const bytes = cached?.bytes ?? await pending!;
      signal?.throwIfAborted();
      const paid = await meter?.reserve(by, "voice", text.length);
      if (paid) await meter!.commit(paid);
      return new Response(new Uint8Array(bytes), { headers: HEADERS });
    }
    if (this.pending.size >= 4) throw new SpeechError("translated audio is busy; waiting for the next caption", 429);
    if ((this.activeBy.get(by) ?? 0) >= 2) throw new SpeechError("two voice requests are already active for this account", 429);
    // Register before the first provider await, so identical requests cannot both bill.
    let done!: (bytes: Uint8Array) => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<Uint8Array>((resolve, reject) => { done = resolve; fail = reject; });
    this.pending.set(id, finished);
    this.activeBy.set(by, (this.activeBy.get(by) ?? 0) + 1);
    const release = (): void => { this.pending.delete(id); this.activeBy.set(by, Math.max(0, (this.activeBy.get(by) ?? 1) - 1)); if (!this.activeBy.get(by)) this.activeBy.delete(by); };
    void finished.catch(() => undefined);
    let reservation: string | undefined;
    let accepted = false;
    try {
      await this.charge(by, ask.channel ?? "direct", text.length);
      signal?.throwIfAborted();
      reservation = await meter?.reserve(by, "voice", text.length);
      const response = await this.fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/stream?output_format=pcm_16000`, {
        method: "POST",
        headers: { "xi-api-key": this.key, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: LIVE_VOICE_MODEL, language_code: ask.language }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.body) throw new SpeechError(response.status === 429 ? "ElevenLabs audio quota is temporarily exhausted" : "ElevenLabs could not generate audio; check the server key and quota", response.status === 429 ? 429 : 502);
      // Once the provider accepts, aborting playback cannot refund heard audio.
      accepted = true;
      if (reservation) await meter!.commit(reservation);
      const [play, keep] = response.body.tee();
      void (async () => {
        const reader = keep.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done: ended, value } = await reader.read();
            if (ended) break;
            size += value.length;
            if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new SpeechError("voice response was too long", 502); }
            chunks.push(value);
          }
          if (!size || size % 2) throw new SpeechError("voice response contained incomplete audio", 502);
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
          this.cache.set(id, { until: this.now() + 60_000, bytes });
          // At most a few MB for recent lines, never a recording archive.
          while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value as string);
          done(bytes);
        } catch (error) { fail(error); }
        finally { reader.releaseLock(); release(); }
      })();
      return new Response(play, { headers: HEADERS });
    } catch (error) {
      fail(error); release();
      if (reservation && !accepted) await meter!.refund(reservation);
      throw error;
    }
  }
}

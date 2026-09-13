import type { Caption } from "./captions.ts";
import type { VoiceChoice } from "./live-voice.ts";
import type { SpeakerTranscript, SpeakerTurn } from "../../src/speaker-turns.ts";
import type { AudioWindow } from "./audio-capture.ts";
import { encodeWav } from "./dictate.ts";

export interface Speaker { id: string; profile: string; voice: string; }
/** Match provider labels across overlapping timestamps. A speaker absent from
 * the rolling context gets a new label; pitch alone never identifies someone. */
export class SpeakerTracker {
  private previous: { start: number; end: number; speaker: string }[] = [];
  private sequence = 0;
  readonly speakers = new Map<string, Speaker>();
  constructor(private readonly random: () => number = Math.random) {}
  reset(): void { this.previous = []; this.sequence = 0; this.speakers.clear(); }

  reconcile(turns: SpeakerTurn[], at: number, voices: VoiceChoice[]): Map<string, Speaker> {
    const links = new Map<string, Speaker>();
    const used = new Set<string>();
    const candidates: { local: string; global: string; overlap: number }[] = [];
    const totals = new Map<string, number>();
    for (const turn of turns) for (const old of this.previous) {
      const overlap = Math.min(at + turn.end * 1000, old.end) - Math.max(at + turn.start * 1000, old.start);
      if (overlap > 120) { const key = `${turn.speaker}|${old.speaker}`; totals.set(key, (totals.get(key) ?? 0) + overlap); }
    }
    for (const [key, overlap] of totals) { const [local, global] = key.split("|"); candidates.push({ local: local!, global: global!, overlap }); }
    for (const one of candidates.sort((a, b) => b.overlap - a.overlap)) {
      const speaker = this.speakers.get(one.global);
      if (speaker && !links.has(one.local) && !used.has(one.global)) { links.set(one.local, speaker); used.add(one.global); }
    }
    for (const turn of turns) {
      let speaker = links.get(turn.speaker);
      if (!speaker) {
        // Assign contrasting stock voices, without guessing a person's
        // gender from pitch or a noisy, short opening phrase.
        const taken = new Set([...this.speakers.values()].map(one => one.voice));
        const available = voices.filter(voice => !taken.has(voice.id));
        const pool = available.length ? available : voices;
        const voice = pool[Math.floor(this.random() * pool.length)];
        speaker = { id: `speaker-${++this.sequence}`, profile: turn.profile, voice: voice?.id ?? "auto" };
        this.speakers.set(speaker.id, speaker); links.set(turn.speaker, speaker);
      }
    }
    this.previous = turns.map(turn => ({ start: at + turn.start * 1000, end: at + turn.end * 1000, speaker: links.get(turn.speaker)!.id }));
    const present = new Set(this.previous.map(turn => turn.speaker));
    for (const key of this.speakers.keys()) if (this.speakers.size > 64 && !present.has(key)) this.speakers.delete(key);
    return links;
  }
}

/** Listener-local interpretation for the playing media. One request in flight and only the latest pending audio window. */
export class Interpreter {
  readonly tracker = new SpeakerTracker();
  private generation = 0;
  private pending: AudioWindow | null = null;
  private running: number | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly options: {
    language: () => string; speakers: () => boolean; voices: () => VoiceChoice[];
    channel: () => string; lines: (lines: Caption[]) => void;
    status: (text: string) => void; failed: () => void;
    fetcher?: typeof fetch;
  }) {}

  reset(): void { this.generation++; this.controller?.abort(); this.pending = null; this.running = null; this.tracker.reset(); }
  push(window: AudioWindow): void {
    this.pending = window;
    if (this.running === null) void this.run(this.generation);
  }
  private async json(path: string, init: RequestInit, signal: AbortSignal): Promise<any> {
    const response = await (this.options.fetcher ?? fetch)(path, { ...init, signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Audio translation is unavailable.");
    return body;
  }
  private async run(generation: number): Promise<void> {
    this.running = generation;
    try {
      while (this.pending && generation === this.generation) {
        const window = this.pending; this.pending = null;
        if (Date.now() - window.until > 12_000) continue;
        const controller = new AbortController(); this.controller = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        const speakers = this.options.speakers(), target = this.options.language();
        const heard = await this.json(speakers ? "/api/v1/speech/speakers" : "/api/v1/speech/transcribe?live=1", {
          method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(encodeWav(speakers ? window.samples : window.samples.slice(-80_000))),
        }, signal) as SpeakerTranscript & { text?: string };
        if (generation !== this.generation) return;
        const language = heard.language;
        let lines: Caption[] = [];
        if (speakers) {
          const links = this.tracker.reconcile(heard.turns ?? [], window.at, this.options.voices());
          for (const turn of heard.turns ?? []) {
            const words = turn.words.filter(word => window.at + (word.start + word.end) * 500 >= window.freshAt);
            if (!words.length) continue;
            const speaker = links.get(turn.speaker)!;
            lines.push({ channel: this.options.channel(), at: window.at + words[0]!.start * 1000, until: window.at + words.at(-1)!.end * 1000,
              text: words.map(word => word.text).join(" ").trim(), language, speaker: speaker.id, voiceProfile: turn.profile });
          }
        } else if (heard.text) {
          lines = [{ channel: this.options.channel(), at: window.freshAt, until: window.until, text: heard.text, language }];
        }
        if (!lines.length) continue;
        if (target && language !== target) {
          if (!language) throw new Error("The audio language could not be detected. Waiting for clearer speech.");
          const translated = await this.json("/api/v1/translate?live=1", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ texts: lines.map(line => line.text), from: language, to: target }),
          }, signal) as { texts: string[] };
          lines = lines.map((line, i) => ({ ...line, original: line.text, sourceLanguage: language, language: target, text: translated.texts[i] ?? "" }));
        }
        if (generation !== this.generation) return;
        if (Date.now() - window.until > 12_000) throw new Error("Translation fell behind. Try again after the language model has warmed up.");
        this.options.lines(lines.filter(line => line.text.trim() !== "" && line.text.length <= 600));
        this.options.status(target ? `${language} → ${target} · live translation` : `Original audio language: ${language || "detecting…"}`);
      }
    } catch (error) {
      if (generation === this.generation) { this.reset(); this.options.failed(); this.options.status(error instanceof Error ? error.message : "Live translation stopped."); }
    } finally { if (this.running === generation) this.running = null; }
  }
}

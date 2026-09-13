import { audioError, transientAudioError } from "./live-recovery.ts";
import { encodeWav } from "./pcm-wav.ts";
import type { SpeakerTranscript, SpeakerTurn } from "./speaker-turns.ts";
export interface Caption { channel: string; at: number; until: number; text: string; language?: string; original?: string; sourceLanguage?: string; speaker?: string; voiceProfile?: "lower" | "higher" | "unknown"; }
export interface VoiceChoice { id: string; name: string; gender: string; language: string; }
export interface AudioWindow { samples: Float32Array; at: number; until: number; freshAt: number; }

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
  private committedUntil: number | null = null;
  private running: number | null = null;
  private controller: AbortController | null = null;
  private translating: number | null = null;
  private translationController: AbortController | null = null;
  private recognitionFailures = 0;
  private translationFailures = 0;
  private translations: { lines: Caption[]; language: string; target: string; until: number }[] = [];
  constructor(private readonly options: {
    language: () => string; speakers: () => boolean; voices: () => VoiceChoice[];
    channel: () => string; lines: (lines: Caption[]) => void;
    status: (text: string) => void; failed: (message: string) => void;
    fetcher?: typeof fetch;
  }) {}

  reset(): void {
    this.generation++; this.controller?.abort(); this.translationController?.abort();
    this.pending = null; this.running = null; this.translating = null;
    this.recognitionFailures = this.translationFailures = 0;
    this.translations = []; this.committedUntil = null; this.tracker.reset();
  }
  push(window: AudioWindow): void {
    this.committedUntil ??= window.freshAt;
    this.pending = window;
    if (this.running === null) void this.run(this.generation);
  }
  private async json(path: string, init: RequestInit, signal: AbortSignal): Promise<any> {
    const response = await (this.options.fetcher ?? fetch)(path, { ...init, signal });
    const body = await response.json();
    if (!response.ok) throw audioError(body.error || "Audio translation is unavailable.", response.status);
    return body;
  }
  private async run(generation: number): Promise<void> {
    this.running = generation;
    try {
      while (this.pending && generation === this.generation) {
        const window = this.pending; this.pending = null;
        try {
          if (Date.now() - window.until > 12_000) continue;
          const controller = new AbortController(); this.controller = controller;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
          const speakers = this.options.speakers(), target = this.options.language();
          const heard = await this.json(speakers ? "/api/v1/speech/speakers" : "/api/v1/speech/transcribe?live=1", {
            method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(encodeWav(speakers ? window.samples : window.samples.slice(-80_000))),
          }, signal) as SpeakerTranscript & { text?: string };
          if (generation !== this.generation) return;
          this.recognitionFailures = 0;
          const language = heard.language;
          let lines: Caption[] = [];
          if (speakers) {
            const links = this.tracker.reconcile(heard.turns ?? [], window.at, this.options.voices());
            // The watermark follows emitted words, not the newest capture
            // interval: an overlapping window can recover audio that arrived
            // while recognition/translation was busy. Keep unfinished phrases
            // in that overlap so short capture intervals do not split every
            // sentence (especially damaging when German changes word order).
            const cutoff = this.committedUntil ?? window.freshAt;
            const turns = heard.turns ?? [];
            for (const [index, turn] of turns.entries()) {
              const speaker = links.get(turn.speaker)!;
              const words = turn.words.filter(word =>
                window.at + (word.start + word.end) * 500 >= cutoff &&
                (window.at + word.end * 1000 <= window.until - 100 || /[.!?。！？]$/.test(word.text)));
              let phrase: typeof words = [];
              const emit = (): void => {
                if (!phrase.length) return;
                lines.push({ channel: this.options.channel(), at: window.at + phrase[0]!.start * 1000,
                  until: window.at + phrase.at(-1)!.end * 1000, text: phrase.map(word => word.text).join(" ").trim(),
                  language, speaker: speaker.id, voiceProfile: turn.profile });
                phrase = [];
              };
              for (const word of words) {
                if (phrase.length && word.start - phrase.at(-1)!.end >= 0.45) emit();
                phrase.push(word);
                if (/[.!?。！？]$/.test(word.text) || phrase.map(word => word.text).join(" ").length >= 400) emit();
              }
              if (phrase.length && (index < turns.length - 1 ||
                window.until - (window.at + phrase.at(-1)!.end * 1000) >= 350 ||
                window.until - (window.at + phrase[0]!.start * 1000) >= 3000)) emit();
            }
          } else if (heard.text) {
            lines = [{ channel: this.options.channel(), at: window.freshAt, until: window.until, text: heard.text, language }];
          }
          if (!lines.length) continue;
          this.committedUntil = Math.max(this.committedUntil ?? window.freshAt, ...lines.map(line => line.until));
          // Drop expired work instead of turning off an otherwise healthy stream.
          this.translations = this.translations.filter(item => Date.now() - item.until <= 12_000).slice(-11);
          this.translations.push({ lines, language, target, until: window.until });
          // Recognition of the next audio window can proceed while the text
          // model translates this phrase. Voice synthesis is a third stage.
          if (this.translating === null) void this.translate(this.generation);
        } catch (error) {
          if (generation !== this.generation) return;
          if (!transientAudioError(error) || ++this.recognitionFailures >= 3) throw error;
          this.options.status("Speech recognition interrupted · listening for the next phrase…");
        }
      }
    } catch (error) {
      if (generation === this.generation) { const message = error instanceof Error ? error.message : "Live translation stopped."; this.reset(); this.options.failed(message); this.options.status(message); }
    } finally { if (this.running === generation) this.running = null; }
  }

  private async translate(generation: number): Promise<void> {
    this.translating = generation;
    try {
      while (this.translations.length && generation === this.generation) {
        const item = this.translations.shift()!;
        try {
          let { lines } = item;
          const { language, target, until } = item;
          if (Date.now() - until > 12_000) continue;
          const controller = new AbortController(); this.translationController = controller;
          if (target && language !== target) {
            if (!language) throw audioError("The audio language could not be detected. Waiting for clearer speech.", 502);
            const translated = await this.json("/api/v1/translate?live=1", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ texts: lines.map(line => line.text), from: language, to: target }),
            }, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])) as { texts: string[] };
            if (translated.texts.length !== lines.length || translated.texts.some(text => !text.trim())) throw audioError("Translation omitted a phrase. Waiting for the next phrase.", 502);
            lines = lines.map((line, i) => ({ ...line, original: line.text, sourceLanguage: language, language: target, text: translated.texts[i]! }));
          }
          if (generation !== this.generation) return;
          if (Date.now() - until > 12_000) continue;
          this.translationFailures = 0;
          this.options.lines(lines.flatMap(line => splitCaption(line)));
          this.options.status(target ? `${language} → ${target} · live translation` : `Original audio language: ${language || "detecting…"}`);
        } catch (error) {
          if (generation !== this.generation) return;
          if (!transientAudioError(error) || ++this.translationFailures >= 3) throw error;
          this.options.status("Translation interrupted · catching up with live speech…");
        }
      }
    } catch (error) {
      if (generation === this.generation) { const message = error instanceof Error ? error.message : "Live translation stopped."; this.reset(); this.options.failed(message); this.options.status(message); }
    } finally { if (this.translating === generation) this.translating = null; }
  }
}

/** Preserve all words while respecting the speech API's character limit. */
export function splitCaption(line: Caption): Caption[] {
  const text = line.text.trim();
  if (!text) return [];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 600) {
    const space = rest.lastIndexOf(" ", 600);
    const end = space > 300 ? space : 600;
    parts.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  let offset = 0;
  return parts.map(part => {
    const at = line.at + (line.until - line.at) * offset / text.length;
    offset += part.length + 1;
    return { ...line, text: part, at, until: Math.min(line.until, line.at + (line.until - line.at) * offset / text.length) };
  });
}

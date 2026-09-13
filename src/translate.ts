/**
 * Translation: a line in one language, said in another, on this CPU.
 *
 * The models are the Helsinki-NLP OPUS-MT pairs, one small Marian model
 * per direction, run through Transformers.js like the ear (speech.ts):
 * open weights, nothing sent anywhere, nothing billed. A pair is about a
 * hundred megabytes and a sentence takes about a second; the many-language
 * models that could do any pair in one model were measured and were not
 * worth it -- NLLB-200 wants two gigabytes of memory and ten to twenty
 * seconds a sentence here, and the multi-target Marian models echo their
 * target prefix back and translate nothing. So a pair that has no model of
 * its own goes through English: Swedish to German is Swedish to English,
 * then English to German, twice the wait and the cost of the pivot in
 * meaning, and still the honest choice.
 *
 * Pairs are loaded when first asked for and the least recently used is
 * let go when there are more than a few, because each loaded pair holds a
 * few hundred megabytes and a deployment has a ceiling. Batches are kept
 * to a handful of lines with a cap on how much they may say: a Marian
 * model handed twenty lines at once ran one of them into a wall of full
 * stops until it hit the limit.
 */
import { join } from "node:path";
import { stateDir } from "./daemon.ts";
import { SpeechError, loadTransformers } from "./speech.ts";

/** Where the pair models come from: this prefix and `<from>-<to>`. */
export const MODEL_PREFIX = "Xenova/opus-mt-";
/** How many pairs stay loaded at once. Each holds three to five hundred megabytes beside the ear's four. */
export const KEEP_LOADED = 3;
/** How many lines a model is handed at a time. Past eight one of them may run away. */
export const BATCH = 8;
/** How much one account may have translated in a minute, in characters. Twelve captions a minute is under a thousand. */
export const CHARS_PER_MINUTE = 20_000;
/** How many may wait on the CPU at once. */
export const QUEUE_LIMIT = 16;
/** A translation is never longer than this many tokens: the runaway guard. */
export const MAX_NEW_TOKENS = 160;

/**
 * The directions a pair model exists for, as of the models that were
 * measured. Anything else goes through English, and what English cannot
 * reach is refused with a sentence rather than guessed at.
 */
export const PAIRS: ReadonlySet<string> = new Set([
  // Each of these answered 200 from the hub on 2026-09-13; de-sv, sv-de, de-it, de-nl and the Greek pairs did not.
  "en-de", "en-sv", "en-es", "en-fr", "en-it", "en-nl", "en-ru", "en-zh", "en-ar", "en-fi", "en-da", "en-hu", "en-cs", "en-uk", "en-vi", "en-id", "en-hi",
  "de-en", "sv-en", "es-en", "fr-en", "it-en", "nl-en", "pl-en", "ru-en", "ja-en", "zh-en", "ko-en", "ar-en", "tr-en", "fi-en", "da-en", "hu-en", "cs-en", "uk-en", "vi-en", "id-en", "hi-en",
  "de-fr", "fr-de", "de-es", "es-de", "fr-es", "es-fr",
]);

/** What the page and the CLI call a language. */
export const LANGUAGES: Record<string, { name: string; native: string }> = {
  en: { name: "English", native: "English" },
  de: { name: "German", native: "Deutsch" },
  sv: { name: "Swedish", native: "Svenska" },
  es: { name: "Spanish", native: "Español" },
  fr: { name: "French", native: "Français" },
  it: { name: "Italian", native: "Italiano" },
  nl: { name: "Dutch", native: "Nederlands" },
  pl: { name: "Polish", native: "Polski" },
  ru: { name: "Russian", native: "Русский" },
  ja: { name: "Japanese", native: "日本語" },
  zh: { name: "Chinese", native: "中文" },
  ko: { name: "Korean", native: "한국어" },
  ar: { name: "Arabic", native: "العربية" },
  tr: { name: "Turkish", native: "Türkçe" },
  fi: { name: "Finnish", native: "Suomi" },
  da: { name: "Danish", native: "Dansk" },
  hu: { name: "Hungarian", native: "Magyar" },
  cs: { name: "Czech", native: "Čeština" },
  uk: { name: "Ukrainian", native: "Українська" },
  vi: { name: "Vietnamese", native: "Tiếng Việt" },
  id: { name: "Indonesian", native: "Bahasa Indonesia" },
  hi: { name: "Hindi", native: "हिन्दी" },
};

/**
 * A Marian model's line, tidied. Given a short line it tends to run on in
 * punctuation until the token cap ("Och sånt.............."), and to put a
 * comma and a full stop where one was meant. A space before a mark, a mark
 * repeated, and a run of different marks each become the one mark, the
 * first of them.
 */
export function tidyTranslation(text: string): string {
  return text
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])[.,;:]+/g, "$1")
    .replace(/([!?])[!?]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The models a translation from one language to another goes through, or null when there is no way. */
export function route(from: string, to: string, pairs: ReadonlySet<string> = PAIRS): [string, string][] | null {
  if (from === to) return [];
  if (pairs.has(`${from}-${to}`)) return [[from, to]];
  if (from !== "en" && to !== "en" && pairs.has(`${from}-en`) && pairs.has(`en-${to}`)) return [[from, "en"], ["en", to]];
  return null;
}

export function modelFor(from: string, to: string): string {
  return `${MODEL_PREFIX}${from}-${to}`;
}

/** Lines in, lines out, one model. What a loaded pair is, to this file. */
export type Pair = {
  translate: (texts: string[]) => Promise<string[]>;
  dispose?: () => Promise<void> | void;
};

export interface TranslatorOptions {
  cacheDir?: string;
  /** How a pair is loaded. The tests hand in a fake; nothing else does. */
  load?: (model: string, cacheDir: string) => Promise<Pair>;
  now?: () => number;
  keep?: number;
  pairs?: ReadonlySet<string>;
}

export interface Translated {
  texts: string[];
  from: string;
  to: string;
  /** The model, or the two, that did it. */
  model: string;
}

interface TranslationPipeline {
  (texts: string[], options: Record<string, unknown>): Promise<{ translation_text: string }[]>;
  dispose?: () => Promise<void>;
}

interface Transformers {
  env: { cacheDir?: string };
  pipeline(task: "translation", model: string, options: { dtype: string }): Promise<TranslationPipeline>;
}

async function loadMarian(model: string, cacheDir: string): Promise<Pair> {
  const transformers = await loadTransformers<Transformers>();
  transformers.env.cacheDir = cacheDir;
  const pipeline = await transformers.pipeline("translation", model, { dtype: "q8" });
  return {
    translate: async (texts) => {
      const out: string[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        // Twice the input and a little: a translation is about as long as
        // what it translates, and a model that keeps going has gone wrong.
        const longest = Math.max(...batch.map((text) => text.length));
        const answers = await pipeline(batch, { max_new_tokens: Math.min(MAX_NEW_TOKENS, Math.ceil(longest / 2) + 16) });
        out.push(...answers.map((answer) => answer.translation_text));
      }
      return out;
    },
    dispose: () => pipeline.dispose?.(),
  };
}

export class Translator {
  private readonly cacheDir: string;
  private readonly load: (model: string, cacheDir: string) => Promise<Pair>;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly pairs: ReadonlySet<string>;
  private readonly loaded = new Map<string, { pair: Promise<Pair>; usedAt: number }>();
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly asked = new Map<string, { minute: number; chars: number }>();
  lastFailure = "";

  constructor(options: TranslatorOptions = {}) {
    this.cacheDir = options.cacheDir ?? process.env["NIXAMP_STT_CACHE"] ?? join(stateDir(), "models");
    this.load = options.load ?? loadMarian;
    this.now = options.now ?? (() => Date.now());
    this.keep = options.keep ?? KEEP_LOADED;
    this.pairs = options.pairs ?? PAIRS;
  }

  /** Whether one language can be said in another here, at all. */
  can(from: string, to: string): boolean {
    return route(from, to, this.pairs) !== null;
  }

  /** The languages something in `from` can be translated into. */
  targets(from: string): string[] {
    return Object.keys(LANGUAGES).filter((to) => to !== from && this.can(from, to));
  }

  private pair(from: string, to: string): Promise<Pair> {
    const model = modelFor(from, to);
    const held = this.loaded.get(model);
    if (held) {
      held.usedAt = this.now();
      return held.pair;
    }
    const pair = this.load(model, this.cacheDir).catch((error: unknown) => {
      // A failed load is tried again next time, not remembered forever.
      this.loaded.delete(model);
      throw error;
    });
    this.loaded.set(model, { pair, usedAt: this.now() });
    if (this.loaded.size > this.keep) {
      let oldest: [string, { pair: Promise<Pair>; usedAt: number }] | null = null;
      for (const entry of this.loaded) if (entry[0] !== model && (oldest === null || entry[1].usedAt < oldest[1].usedAt)) oldest = entry;
      if (oldest) {
        this.loaded.delete(oldest[0]);
        void oldest[1].pair.then((old) => old.dispose?.()).catch(() => undefined);
      }
    }
    return pair;
  }

  /** Load pairs now, so the first line is not the one that waits. Says whether every one of them could; never throws. */
  async warm(pairs: string[]): Promise<boolean> {
    let all = true;
    for (const name of pairs) {
      const [from, to] = name.split("-");
      if (!from || !to) continue;
      try {
        await this.pair(from, to);
      } catch (error) {
        this.lastFailure = (error as Error).message;
        all = false;
      }
    }
    return all;
  }

  /** The pairs loaded right now, by model name. */
  loadedModels(): string[] {
    return [...this.loaded.keys()];
  }

  /** Whether this account may have this much translated now, and the bookkeeping if so. */
  allow(accountId: string, chars: number): void {
    const minute = Math.floor(this.now() / 60_000);
    const record = this.asked.get(accountId) ?? { minute, chars: 0 };
    if (record.minute !== minute) {
      record.minute = minute;
      record.chars = 0;
    }
    if (record.chars + chars > CHARS_PER_MINUTE) {
      throw new SpeechError(`${CHARS_PER_MINUTE} characters a minute is plenty; try again in a moment`, 429);
    }
    record.chars += chars;
    this.asked.set(accountId, record);
    if (this.asked.size > 5000) {
      for (const [id, one] of this.asked) if (one.minute !== minute) this.asked.delete(id);
    }
  }

  /**
   * Texts in another language. Refuses a pair nobody can do, too much for
   * one account, or too many waiting, each with a status. Empty texts come
   * back empty and cost nothing.
   */
  async translate(texts: string[], from: string, to: string, options: { by?: string } = {}): Promise<Translated> {
    const hops = route(from, to, this.pairs);
    if (hops === null) {
      const known = Object.keys(LANGUAGES).includes(from) && Object.keys(LANGUAGES).includes(to);
      throw new SpeechError(known ? `there is no model here from ${from} to ${to}` : `translation is between two-letter language codes, such as en and de`, 400);
    }
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    if (options.by) this.allow(options.by, chars);
    const model = hops.map(([a, b]) => modelFor(a, b)).join(" then ");
    if (hops.length === 0 || chars === 0) return { texts: [...texts], from, to, model };
    if (this.waiting >= QUEUE_LIMIT) throw new SpeechError("too much is being translated at once; try again in a moment", 503);
    this.waiting += 1;
    const turn = this.tail.then(async () => {
      // Only the lines with something in them go to the model; the rest keep their place.
      const spoken = texts.map((text) => text.trim());
      const which = spoken.map((text, i) => (text === "" ? -1 : i)).filter((i) => i >= 0);
      let current = which.map((i) => spoken[i] as string);
      for (const [a, b] of hops) {
        const pair = await this.pair(a, b);
        current = await pair.translate(current);
      }
      const out = [...spoken];
      which.forEach((i, at) => {
        out[i] = tidyTranslation(current[at] ?? "");
      });
      return out;
    });
    this.tail = turn.catch(() => undefined);
    try {
      return { texts: await turn, from, to, model };
    } finally {
      this.waiting -= 1;
    }
  }
}

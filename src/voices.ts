/**
 * The voice a person's words are read in, on the phone.
 *
 * A trollbox line is text; the party line is a phone call. Reading one into
 * the other needs a voice, and the voice should be theirs as far as a
 * machine can manage: a man's line in a man's voice, a woman's in a woman's,
 * and two people in one room in two different voices, so a caller can tell
 * who is talking without being told every time. Where the sex comes from,
 * in order: the voice they set on their nixamp account; their OpenProfile
 * (`Voice`, then `Gender`, then `Pronouns`; see logicsrc.com/openprofile);
 * and failing both, nothing, in which case they get a voice from the whole
 * pool. Which voice within the pool is picked from their account id, so the
 * same person is always the same voice.
 *
 * Two pools. Telnyx's Kokoro voices are an open-weights model with no bill
 * beyond the call: eleven women, eight men, American English. ElevenLabs
 * reads better and bills per character; Telnyx speaks it when the account
 * holds an integration secret with the ElevenLabs key, and this file uses
 * it when that secret exists unless told to stay with Kokoro. Both pools
 * can be replaced from the environment.
 */
import { createHash } from "node:crypto";

export type VoiceKind = "female" | "male" | "";

/** Kokoro through Telnyx: American English, the women then the men. Free. */
export const KOKORO_FEMALE = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_nova", "af_jessica", "af_kore", "af_river", "af_alloy", "af_aoede"]
  .map((name) => `Telnyx.KokoroTTS.${name}`);
export const KOKORO_MALE = ["am_adam", "am_michael", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_onyx", "am_puck"]
  .map((name) => `Telnyx.KokoroTTS.${name}`);

/**
 * ElevenLabs' premade voices, as `ElevenLabs.<voice id>`, by the gender
 * ElevenLabs labels them with (read off the account on 2026-09-13). The
 * names are for whoever reads this file; Telnyx only ever sees the id.
 */
export const ELEVENLABS_FEMALE = [
  "ElevenLabs.EXAVITQu4vr4xnSDxMaL", // Sarah
  "ElevenLabs.FGY2WhTYpPnrIDTdsKH5", // Laura
  "ElevenLabs.Xb7hH8MSUJpSbSDYk0k2", // Alice
  "ElevenLabs.XrExE9yKIg1WjnnlVkGX", // Matilda
  "ElevenLabs.cgSgspJ2msm6clMCkdW9", // Jessica
  "ElevenLabs.hpp4J3VqNfWAUOO0d1Us", // Bella
  "ElevenLabs.pFZP5JQG7iQjIQuC4Bku", // Lily
];
export const ELEVENLABS_MALE = [
  "ElevenLabs.CwhRBWXzGAHq8TQ4Fs17", // Roger
  "ElevenLabs.IKne3meq5aSn9XLyUdCD", // Charlie
  "ElevenLabs.JBFqnCBsd6RMkjVDRZzb", // George
  "ElevenLabs.N2lVS1w4EtoT3dr4eOWO", // Callum
  "ElevenLabs.SOYHLrjzK2X1ezoPC6cr", // Harry
  "ElevenLabs.TX3LPaxmHKxFdv7VOQHJ", // Liam
  "ElevenLabs.bIHbv24MWmeRgasZH58o", // Will
  "ElevenLabs.cjVigY5qzO86Huf0OWal", // Eric
  "ElevenLabs.iP95p4xoKVk53GoZ742B", // Chris
  "ElevenLabs.nPczCjzI2devNBz1zQrb", // Brian
  "ElevenLabs.onwK4e9ZLuTAKqWW03F9", // Daniel
  "ElevenLabs.pNInz6obpgDQGcFmaJgB", // Adam
  "ElevenLabs.pqHfZKP75CvOlQylNhV4", // Bill
];

/** Kept for the tests and anybody who wants one voice per sex: the first of each pool. */
export const DEFAULT_VOICES: Record<Exclude<VoiceKind, "">, string> = {
  female: KOKORO_FEMALE[0] as string,
  male: KOKORO_MALE[0] as string,
};

/** The voices to choose among, and what Telnyx needs to speak them. */
export interface VoicePools {
  provider: "kokoro" | "elevenlabs" | "custom";
  female: string[];
  male: string[];
  /** Sent as `voice_settings` on an ElevenLabs voice: the integration secret holding the key. */
  settings?: { api_key_ref: string };
}

/** What a speak command is told: the voice, and the settings that voice needs, if any. */
export interface SpokenVoice {
  voice: string;
  settings?: { api_key_ref: string };
}

/** The word a person used for themselves, as a voice: female, male, or nothing to go on. */
export function voiceKindOf(value: unknown): VoiceKind {
  if (typeof value !== "string") return "";
  const word = value.trim().toLowerCase();
  if (word === "") return "";
  if (/^(f|female|woman|women|girl|she|her|she\/her|fem|feminine|lady)$/.test(word)) return "female";
  if (/^(m|male|man|men|boy|he|him|he\/him|masc|masculine|guy)$/.test(word)) return "male";
  if (/^she\b/.test(word)) return "female";
  if (/^he\b/.test(word)) return "male";
  return "";
}

export interface ProfileVoice {
  /** What the profile said outright, when it did: female, male, or a provider voice id. */
  voice: string;
  gender: string;
  pronouns: string;
}

/**
 * The parts of an OpenProfile.md that say how somebody sounds. The identity
 * block is the bullets under the first `#`; `Gender` may also sit under
 * `## Match`, where the spec put it first. Everything else is ignored.
 */
export function readProfileVoice(markdown: string): ProfileVoice {
  const found: ProfileVoice = { voice: "", gender: "", pronouns: "" };
  let section = "";
  let started = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("# ") && !started) {
      started = true;
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    const inIdentity = started && section === "";
    const inMatch = /^(match|dating|matching|partner|looking for)$/.test(section);
    if (!inIdentity && !inMatch) continue;
    const item = /^[-*]\s+(?:\*\*)?([A-Za-z ]+?)(?:\*\*)?\s*:\s*(.+)$/.exec(line);
    if (!item) continue;
    const key = (item[1] ?? "").trim().toLowerCase();
    const value = (item[2] ?? "").trim();
    if (key === "voice" && !found.voice) found.voice = value;
    if (key === "gender" && !found.gender) found.gender = value;
    if (key === "pronouns" && !found.pronouns) found.pronouns = value;
  }
  return found;
}

/** A stable pick from a list for an id: the same id, the same pick, every time. */
function pickFor(userId: string, pool: string[]): string {
  const digest = createHash("sha1").update(userId).digest();
  const index = ((digest[0] as number) << 8 | (digest[1] as number)) % pool.length;
  return pool[index] as string;
}

/** The pools as one voice per sex, for callers that still think that way. */
function firstOf(voices: Record<Exclude<VoiceKind, "">, string>): VoicePools {
  return { provider: "custom", female: [voices.female], male: [voices.male] };
}

/**
 * The voice for somebody, from what is known about them. A voice named
 * outright (`ElevenLabs.…`, `Telnyx.KokoroTTS.…`, `Polly.…`) is used as
 * written; a sex picks from that sex's pool by the account id; nothing at
 * all picks from both pools the same way, so it stays the same tomorrow.
 * Settings ride along when the voice is an ElevenLabs one and the pools
 * know the secret.
 */
export function telnyxVoiceFor(
  who: { userId: string; voice?: string; profile?: ProfileVoice | null },
  pools: VoicePools | Record<Exclude<VoiceKind, "">, string> = { provider: "kokoro", female: KOKORO_FEMALE, male: KOKORO_MALE },
): string {
  return spokenVoiceFor(who, "female" in pools && typeof pools.female === "string" ? firstOf(pools as Record<Exclude<VoiceKind, "">, string>) : (pools as VoicePools)).voice;
}

export function spokenVoiceFor(
  who: { userId: string; voice?: string; profile?: ProfileVoice | null },
  pools: VoicePools,
): SpokenVoice {
  const asked = (who.voice ?? "").trim();
  const fromProfile = who.profile?.voice.trim() ?? "";
  const named = asked.includes(".") ? asked : fromProfile.includes(".") ? fromProfile : "";
  let voice: string;
  if (named) {
    voice = named;
  } else {
    const kind = voiceKindOf(asked) || voiceKindOf(fromProfile) || voiceKindOf(who.profile?.gender) || voiceKindOf(who.profile?.pronouns);
    const pool = kind === "female" ? pools.female : kind === "male" ? pools.male : [...pools.female, ...pools.male];
    voice = pool.length > 0 ? pickFor(who.userId, pool) : DEFAULT_VOICES.female;
  }
  return voice.startsWith("ElevenLabs.") && pools.settings ? { voice, settings: pools.settings } : { voice };
}

/** The voices to use per sex, from the environment when it says so. Kept for one-voice callers. */
export function voicesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Exclude<VoiceKind, "">, string> {
  return {
    female: env["NIXAMP_VOICE_FEMALE"] || DEFAULT_VOICES.female,
    male: env["NIXAMP_VOICE_MALE"] || DEFAULT_VOICES.male,
  };
}

function listFrom(value: string | undefined): string[] {
  return (value ?? "").split(",").map((one) => one.trim()).filter(Boolean);
}

/**
 * The pools this deployment speaks with. `NIXAMP_VOICES_FEMALE` and
 * `NIXAMP_VOICES_MALE` (comma lists of Telnyx voice ids) win outright;
 * `NIXAMP_VOICE_FEMALE` / `NIXAMP_VOICE_MALE` name one voice per sex; else
 * ElevenLabs when the account holds the secret for it and `NIXAMP_TTS` is
 * not `kokoro`; else Kokoro, which is free.
 */
export function poolsFrom(env: NodeJS.ProcessEnv, elevenLabsSecret: string | null): VoicePools {
  const female = listFrom(env["NIXAMP_VOICES_FEMALE"]);
  const male = listFrom(env["NIXAMP_VOICES_MALE"]);
  const settings = elevenLabsSecret ? { api_key_ref: elevenLabsSecret } : undefined;
  if (female.length > 0 || male.length > 0) {
    return { provider: "custom", female: female.length > 0 ? female : KOKORO_FEMALE, male: male.length > 0 ? male : KOKORO_MALE, ...(settings ? { settings } : {}) };
  }
  if (env["NIXAMP_VOICE_FEMALE"] || env["NIXAMP_VOICE_MALE"]) {
    const one = voicesFromEnv(env);
    return { provider: "custom", female: [one.female], male: [one.male], ...(settings ? { settings } : {}) };
  }
  if (settings && (env["NIXAMP_TTS"] ?? "").toLowerCase() !== "kokoro") {
    return { provider: "elevenlabs", female: ELEVENLABS_FEMALE, male: ELEVENLABS_MALE, settings };
  }
  return { provider: "kokoro", female: KOKORO_FEMALE, male: KOKORO_MALE };
}

/**
 * Whether Telnyx holds an ElevenLabs key for this account: an integration
 * secret whose identifier is `elevenlabs` (or what NIXAMP_ELEVENLABS_SECRET
 * names). Asked once, at the first line, and remembered; no key means the
 * free voices, and no Railway variable has to be set for either.
 */
export class Voices {
  private secret: Promise<string | null> | null = null;

  constructor(
    private readonly options: {
      telnyxApiKey: string;
      env?: NodeJS.ProcessEnv;
      fetcher?: typeof fetch;
      telnyxApi?: string;
      onEvent?: (message: string) => void;
    },
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private async elevenLabsSecret(): Promise<string | null> {
    const wanted = (this.env["NIXAMP_ELEVENLABS_SECRET"] ?? "elevenlabs").trim();
    if (!wanted || !this.options.telnyxApiKey) return null;
    try {
      const response = await (this.options.fetcher ?? fetch)(`${this.options.telnyxApi ?? "https://api.telnyx.com/v2"}/integration_secrets?page[size]=250`, {
        headers: { authorization: `Bearer ${this.options.telnyxApiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: { identifier?: string }[] };
      const found = (body.data ?? []).some((one) => one.identifier === wanted);
      this.options.onEvent?.(found
        ? `  voices: ElevenLabs, through Telnyx secret "${wanted}"`
        : "  voices: Kokoro (no ElevenLabs secret on the Telnyx account)");
      return found ? wanted : null;
    } catch {
      return null;
    }
  }

  /** The pools, resolved once. A failed look at Telnyx is asked again next time. */
  async pools(): Promise<VoicePools> {
    this.secret ??= this.elevenLabsSecret().then((secret) => {
      if (secret === null) this.secret = null;
      return secret;
    });
    return poolsFrom(this.env, await this.secret);
  }
}

/** What a line sounds like read aloud: who said it, then what. */
export function spokenLine(handle: string, body: string): string {
  const said = body.replace(/\s+/g, " ").trim();
  return `${handle.replace(/-/g, " ")} says: ${said}`;
}

/**
 * Somebody's OpenProfile, fetched and kept an hour. A profile is read on
 * every line they say, and a line a second is the trollbox's own limit.
 */
export class Profiles {
  private readonly kept = new Map<string, { at: number; voice: ProfileVoice }>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  async voiceOf(url: string): Promise<ProfileVoice | null> {
    let where: URL;
    try {
      where = new URL(url);
      if (where.protocol !== "https:" && where.protocol !== "http:") return null;
    } catch {
      return null;
    }
    const had = this.kept.get(where.href);
    if (had && this.now() - had.at < this.ttlMs) return had.voice;
    try {
      const response = await this.fetcher(where.href, {
        headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return had?.voice ?? null;
      const text = (await response.text()).slice(0, 64 * 1024);
      const voice = readProfileVoice(text);
      this.kept.set(where.href, { at: this.now(), voice });
      if (this.kept.size > 5000) {
        for (const [key, one] of this.kept) if (this.now() - one.at > this.ttlMs) this.kept.delete(key);
      }
      return voice;
    } catch {
      return had?.voice ?? null;
    }
  }
}

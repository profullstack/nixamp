/**
 * The voice a person's words are read in, on the phone.
 *
 * A trollbox line is text; the party line is a phone call. Reading one into
 * the other needs a voice, and the voice should be theirs as far as a
 * machine can manage: a man's line in a man's voice, a woman's in a woman's,
 * anybody else's in whichever they asked for. Where that comes from, in
 * order: the voice they set on their nixamp account; their OpenProfile
 * (`Voice`, then `Gender`, then `Pronouns`; see logicsrc.com/openprofile);
 * and failing both, one picked from their id, so the same person is always
 * the same voice even when nobody was told which.
 *
 * The voices are Telnyx's Kokoro ones: an open-weights model, no bill beyond
 * the call. ElevenLabs or anything else Telnyx speaks is a configuration
 * away, per sex, because "better" and "paid" are the same word there.
 */
import { createHash } from "node:crypto";

export type VoiceKind = "female" | "male" | "";

/** Kokoro, through Telnyx: af_heart is the default woman, am_adam the default man. */
export const DEFAULT_VOICES: Record<Exclude<VoiceKind, "">, string> = {
  female: "Telnyx.KokoroTTS.af_heart",
  male: "Telnyx.KokoroTTS.am_adam",
};

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

/**
 * The Telnyx voice for somebody, from what is known about them. A voice
 * named outright (`ElevenLabs.…`, `Telnyx.KokoroTTS.…`, `Polly.…`) is used
 * as written; a sex picks the configured voice for it; nothing at all
 * picks one by the account id, so it stays the same tomorrow.
 */
export function telnyxVoiceFor(
  who: { userId: string; voice?: string; profile?: ProfileVoice | null },
  voices: Record<Exclude<VoiceKind, "">, string> = DEFAULT_VOICES,
): string {
  const asked = (who.voice ?? "").trim();
  if (asked.includes(".")) return asked;
  const fromProfile = who.profile?.voice.trim() ?? "";
  if (fromProfile.includes(".")) return fromProfile;
  const kind = voiceKindOf(asked) || voiceKindOf(fromProfile) || voiceKindOf(who.profile?.gender) || voiceKindOf(who.profile?.pronouns);
  if (kind) return voices[kind];
  const digit = createHash("sha1").update(who.userId).digest()[0] as number;
  return digit % 2 === 0 ? voices.female : voices.male;
}

/** The voices to use per sex, from the environment when it says so. */
export function voicesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Exclude<VoiceKind, "">, string> {
  return {
    female: env["NIXAMP_VOICE_FEMALE"] || DEFAULT_VOICES.female,
    male: env["NIXAMP_VOICE_MALE"] || DEFAULT_VOICES.male,
  };
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

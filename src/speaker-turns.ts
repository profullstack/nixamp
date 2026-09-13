/** Provider speaker IDs belong to a clip. Clients reconcile the overlapping
 * word timestamps before assigning a voice; these are not people's identities. */
import { reliableText, type Wav } from "./speech.ts";
import { voiceProfile, type VoiceProfile } from "./voice-profile.ts";

export interface SpeakerTurn { start: number; end: number; text: string; speaker: string; profile: VoiceProfile; words: { text: string; start: number; end: number }[]; }
export interface SpeakerTranscript { language: string; seconds: number; turns: SpeakerTurn[]; }
export interface ScribeResult {
  language_code?: string;
  words?: { text: string; start: number; end: number; type: string; speaker_id?: string | null }[];
}
const ISO: Record<string, string> = Object.fromEntries("eng:en spa:es deu:de ger:de fra:fr fre:fr por:pt ita:it nld:nl dut:nl swe:sv dan:da fin:fi rus:ru ukr:uk ces:cs cze:cs hun:hu cmn:zh zho:zh ara:ar hin:hi vie:vi ind:id jpn:ja kor:ko pol:pl tur:tr ron:ro bul:bg ell:el nor:no nob:no nno:no".split(" ").map(pair => pair.split(":")));

export function speakerTurns(body: ScribeResult, wav: Wav): SpeakerTranscript {
  const seconds = wav.samples.length / wav.rate;
  const language = ISO[body.language_code ?? ""] ?? body.language_code ?? "";
  const turns: SpeakerTurn[] = [];
  for (const word of (body.words ?? []).slice(0, 1500)) {
    if (word.type !== "word" || typeof word.text !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > seconds + 0.5) continue;
    const speaker = typeof word.speaker_id === "string" && /^[\w-]{1,80}$/.test(word.speaker_id) ? word.speaker_id : "unknown";
    const last = turns.at(-1);
    if (last && last.speaker === speaker && word.start - last.end < 0.8 && last.text.length + word.text.length < 400) {
      last.text += ` ${word.text}`; last.end = Math.max(last.end, word.end);
      last.words.push({ text: word.text, start: word.start, end: word.end });
    } else turns.push({ start: word.start, end: word.end, text: word.text, speaker, profile: "unknown", words: [{ text: word.text, start: word.start, end: word.end }] });
  }
  const pcm = Buffer.alloc(wav.samples.length * 2);
  wav.samples.forEach((sample, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2));
  for (const turn of turns) {
    turn.text = reliableText(turn.text, Math.max(1, turn.end - turn.start));
    turn.profile = voiceProfile(pcm.subarray(Math.floor(turn.start * 16000) * 2, Math.ceil(turn.end * 16000) * 2));
  }
  return { language, seconds, turns: turns.filter(turn => turn.text !== "") };
}

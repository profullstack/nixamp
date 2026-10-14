/** ElevenLabs Flash/Scribe for live captions, from @profullstack/live-translate.
 * nixamp keeps its `nxd_` grant tokens: captions.ts and older pages expect them. */
import { LiveVoice as Base } from "@profullstack/live-translate";
export { LIVE_VOICE_MODEL, LIVE_VOICE_RATE, LIVE_VOICE_LANGUAGES, type LiveVoiceChoice, type VoiceRequest } from "@profullstack/live-translate";

export class LiveVoice extends Base {
  constructor(options: ConstructorParameters<typeof Base>[0] = {}) { super({ tokenPrefix: "nxd_", ...options }); }
}

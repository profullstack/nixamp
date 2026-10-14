import tapUrl from "./audio-tap.worklet.js?url";
import { AudioCapture as Base, windowWav, type AudioWindow } from "@profullstack/live-translate/browser";
export { windowWav, type AudioWindow };

/** The package's capture with nixamp's served worklet (its CSP has no blob: workers). */
export class AudioCapture extends Base {
  constructor(take: (window: AudioWindow) => void) { super(take, { workletUrl: tapUrl, processor: "nixamp-audio-tap" }); }
}

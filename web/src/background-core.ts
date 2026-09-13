import FFT from "fft.js";

export const BACKGROUND_HOP = 512;
const SIZE = BACKGROUND_HOP * 2;
export interface FrameDenoiser { processFrame(input: Float32Array): Float32Array; destroy(): void; }

/** Complement the estimated speech spectrum, retaining the source's phase.
 * Waveform subtraction leaves intelligible speech when the model changes phase
 * or underestimates a voice. No envelope, gate or translated-speech ducking. */
class SpeechMask {
  private fft = new FFT(SIZE);
  private window = Float64Array.from({ length: SIZE }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / SIZE)));
  private source = new Float64Array(SIZE);
  private voice = new Float64Array(SIZE);
  private time = new Float64Array(SIZE);
  private spectrum = new Float64Array(SIZE * 2);
  private estimate = new Float64Array(SIZE * 2);
  private inverse = new Float64Array(SIZE * 2);
  private overlap = new Float64Array(BACKGROUND_HOP);
  reset(): void { this.source.fill(0); this.voice.fill(0); this.overlap.fill(0); }
  process(source: Float32Array, voice: Float32Array): Float32Array {
    this.source.copyWithin(0, BACKGROUND_HOP); this.source.set(source, BACKGROUND_HOP);
    this.voice.copyWithin(0, BACKGROUND_HOP); this.voice.set(voice, BACKGROUND_HOP);
    for (let i = 0; i < SIZE; i++) this.time[i] = this.source[i]! * this.window[i]!;
    this.fft.realTransform(this.spectrum, this.time);
    for (let i = 0; i < SIZE; i++) this.time[i] = this.voice[i]! * this.window[i]!;
    this.fft.realTransform(this.estimate, this.time);
    for (let bin = 0; bin <= SIZE; bin += 2) {
      const amplitude = Math.hypot(this.spectrum[bin]!, this.spectrum[bin + 1]!);
      const speech = Math.hypot(this.estimate[bin]!, this.estimate[bin + 1]!);
      const remaining = Math.max(0, 1 - 8 * speech / (amplitude + 1e-8));
      this.spectrum[bin] = this.spectrum[bin]! * remaining * remaining;
      this.spectrum[bin + 1] = this.spectrum[bin + 1]! * remaining * remaining;
    }
    this.fft.completeSpectrum(this.spectrum);
    this.fft.inverseTransform(this.inverse, this.spectrum);
    const result = new Float32Array(BACKGROUND_HOP);
    for (let i = 0; i < BACKGROUND_HOP; i++) {
      result[i] = this.overlap[i]! + this.inverse[2 * i]! * this.window[i]!;
      this.overlap[i] = this.inverse[2 * (i + BACKGROUND_HOP)]! * this.window[i + BACKGROUND_HOP]!;
    }
    return result;
  }
}

/** Downmix every audible channel before removing speech: commentary can also
 * be present in rear/side channels. FastEnhancer delays one hop; overlap-add
 * adds another, for 21 ms algorithmic latency at 48 kHz. */
export class BackgroundSeparator {
  private previous = [new Float32Array(BACKGROUND_HOP), new Float32Array(BACKGROUND_HOP)];
  private masks = [new SpeechMask(), new SpeechMask()];
  private primed = false;
  private count = 0;
  constructor(private readonly speech: FrameDenoiser[]) {}
  discontinuity(): void { this.primed = false; for (const mask of this.masks) mask.reset(); }
  process(channels: Float32Array[]): Float32Array[] {
    const count = channels.length;
    if (![1, 2, 4, 6, 8].includes(count) || channels.some(channel => channel.length !== BACKGROUND_HOP || channel.some(value => !Number.isFinite(value)))) throw new Error("Invalid background audio frame");
    if (count !== this.count) { this.discontinuity(); this.count = count; }
    if (!this.speech.length) throw new Error("Missing speech separator");
    const mixed = [new Float32Array(BACKGROUND_HOP), new Float32Array(BACKGROUND_HOP)];
    for (let i = 0; i < BACKGROUND_HOP; i++) {
      let left = channels[0]![i]!, right = (channels[1] ?? channels[0])![i]!;
      if (count === 4) { left = (left + channels[2]![i]!) * 0.5; right = (right + channels[3]![i]!) * 0.5; }
      else if (count >= 6) {
        const centre = Math.SQRT1_2 * channels[2]![i]!;
        const surround = count === 6 ? Math.SQRT1_2 : 0.5;
        left += centre + surround * (channels[4]![i]! + (count === 8 ? channels[6]![i]! : 0));
        right += centre + surround * (channels[5]![i]! + (count === 8 ? channels[7]![i]! : 0));
      }
      mixed[0]![i] = left; mixed[1]![i] = right;
    }
    const result: Float32Array[] = [new Float32Array(BACKGROUND_HOP), new Float32Array(BACKGROUND_HOP)];
    // Speech is shared across the stereo field. Estimate it once from the
    // full mix, then suppress its spectrum independently in each original
    // channel. This leaves CPU room for video decoding and avoids worker gaps.
    const mono = Float32Array.from(mixed[0]!, (left, i) => (left + mixed[1]![i]!) * 0.5);
    const estimate = this.speech[0]!.processFrame(mono);
    if (estimate.length !== BACKGROUND_HOP || estimate.some(value => !Number.isFinite(value))) throw new Error("Speech separation failed");
    for (let channel = 0; channel < Math.min(count, 2); channel++) {
      if (this.primed) result[channel] = this.masks[channel]!.process(this.previous[channel]!, estimate);
      this.previous[channel]!.set(mixed[channel]!);
    }
    if (count === 1) result[1] = result[0]!.slice();
    this.primed = true;
    return result;
  }
  destroy(): void { for (const model of this.speech) model.destroy(); }
}

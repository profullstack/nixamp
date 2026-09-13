/** FastEnhancer's output corresponds to the preceding 512-sample frame.
 * Subtract aligned speech estimates; subtracting the current frame leaks voices. */
export const BACKGROUND_HOP = 512;
export interface FrameDenoiser { processFrame(input: Float32Array): Float32Array; destroy(): void; }
export class BackgroundSeparator {
  private previous: Float32Array[] = [];
  private primed = false;
  constructor(private readonly speech: FrameDenoiser[]) {}
  /** A skipped input window is a cut, not audio to replay after a worker stall. */
  discontinuity(): void { this.primed = false; }
  process(channels: Float32Array[]): Float32Array[] {
    const count = channels.length;
    if (![1, 2, 4, 6, 8].includes(count) || channels.some(channel => channel.length !== BACKGROUND_HOP || channel.some(value => !Number.isFinite(value)))) throw new Error("Invalid background audio frame");
    if (this.previous.length !== count) {
      this.previous = channels.map(() => new Float32Array(BACKGROUND_HOP));
      this.primed = false;
    }
    // Foreground dialogue lives in the front L/R and (for surround) centre.
    // Keep surround ambience from the recording, outside the speech model.
    const foreground = count >= 6 ? 3 : Math.min(2, count);
    if (this.speech.length < foreground) throw new Error("Missing speech separator");
    const clean = channels.slice(0, foreground).map((channel, index) => {
      const estimate = this.speech[index]!.processFrame(channel);
      if (estimate.length !== BACKGROUND_HOP || estimate.some(value => !Number.isFinite(value))) throw new Error("Speech separation failed");
      return estimate;
    });
    const result = [new Float32Array(BACKGROUND_HOP), new Float32Array(BACKGROUND_HOP)];
    if (this.primed) for (let i = 0; i < BACKGROUND_HOP; i++) {
      let left = this.previous[0]![i]! - clean[0]![i]!;
      let right = count === 1 ? left : this.previous[1]![i]! - clean[1]![i]!;
      if (count === 4) {
        left = 0.5 * (left + this.previous[2]![i]!);
        right = 0.5 * (right + this.previous[3]![i]!);
      } else if (count >= 6) {
        const centre = Math.SQRT1_2 * (this.previous[2]![i]! - clean[2]![i]!);
        const surround = count === 6 ? Math.SQRT1_2 : 0.5;
        left += centre + surround * (this.previous[4]![i]! + (count === 8 ? this.previous[6]![i]! : 0));
        right += centre + surround * (this.previous[5]![i]! + (count === 8 ? this.previous[7]![i]! : 0));
        // LFE is omitted, as in the browser's normal stereo speaker downmix.
      }
      result[0]![i] = Math.max(-1, Math.min(1, left));
      result[1]![i] = Math.max(-1, Math.min(1, right));
    }
    channels.forEach((channel, index) => this.previous[index]!.set(channel));
    this.primed = true;
    return result;
  }
  destroy(): void { for (const model of this.speech) model.destroy(); }
}

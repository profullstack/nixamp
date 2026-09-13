/** FastEnhancer's output corresponds to the preceding 512-sample frame.
 * Subtract aligned speech estimates; subtracting the current frame leaks voices. */
export const BACKGROUND_HOP = 512;
export interface FrameDenoiser { processFrame(input: Float32Array): Float32Array; destroy(): void; }
export class BackgroundSeparator {
  private previous = [new Float32Array(BACKGROUND_HOP), new Float32Array(BACKGROUND_HOP)];
  private primed = false;
  constructor(private readonly speech: [FrameDenoiser, FrameDenoiser]) {}
  process(channels: Float32Array[]): Float32Array[] {
    if (channels.length !== 2 || channels.some(channel => channel.length !== BACKGROUND_HOP || channel.some(value => !Number.isFinite(value)))) throw new Error("Invalid background audio frame");
    const result = channels.map((channel, index) => {
      const clean = this.speech[index]!.processFrame(channel);
      if (clean.length !== BACKGROUND_HOP || clean.some(value => !Number.isFinite(value))) throw new Error("Speech separation failed");
      const background = new Float32Array(BACKGROUND_HOP);
      if (this.primed) for (let i = 0; i < BACKGROUND_HOP; i++) background[i] = Math.max(-1, Math.min(1, this.previous[index]![i]! - clean[i]!));
      this.previous[index]!.set(channel);
      return background;
    });
    this.primed = true;
    return result;
  }
  destroy(): void { for (const model of this.speech) model.destroy(); }
}

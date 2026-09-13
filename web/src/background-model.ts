import { loadModel } from "fastenhancer-web";
import { BackgroundSeparator, BACKGROUND_HOP, type FrameDenoiser } from "./background-core.ts";

/** One stronger speech model for the whole mix; the output remains stereo. */
export async function createBackgroundSeparator(): Promise<BackgroundSeparator> {
  const speech: FrameDenoiser[] = [];
  try {
    const model = await loadModel("base");
    if (model.sampleRate !== 48000 || model.hopSize !== BACKGROUND_HOP) throw new Error("Unsupported separation format");
    const denoiser = await model.createDenoiser();
    denoiser.agcEnabled = denoiser.hpfEnabled = false;
    speech.push(denoiser);
    return new BackgroundSeparator(speech);
  } catch (error) { for (const denoiser of speech) denoiser.destroy(); throw error; }
}

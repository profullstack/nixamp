import { clearCachedModel, loadModel } from "fastenhancer-web";
import { BackgroundSeparator, BACKGROUND_HOP, type FrameDenoiser } from "./background-core.ts";

/** Local models for front L/R and centre dialogue; surround sound stays raw. */
export async function createBackgroundSeparator(): Promise<BackgroundSeparator> {
  const speech: FrameDenoiser[] = [];
  try {
    const model = await loadModel("tiny");
    if (model.sampleRate !== 48000 || model.hopSize !== BACKGROUND_HOP) throw new Error("Unsupported separation format");
    // The bundled WASM engine cannot allocate three channel states in one
    // instance. Give the centre its own instance, using the same local weights.
    clearCachedModel("tiny");
    const centreModel = await loadModel("tiny");
    for (const channelModel of [model, model, centreModel]) {
      const denoiser = await channelModel.createDenoiser();
      denoiser.agcEnabled = denoiser.hpfEnabled = false;
      speech.push(denoiser);
    }
    return new BackgroundSeparator(speech);
  } catch (error) { for (const denoiser of speech) denoiser.destroy(); throw error; }
}

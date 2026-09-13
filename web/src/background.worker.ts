import { loadModel } from "fastenhancer-web";
import { BackgroundSeparator, BACKGROUND_HOP } from "./background-core.ts";

/** Model inference stays off the page and audio-rendering threads. */
self.onmessage = async (event: MessageEvent<{ port: MessagePort }>) => {
  const port = event.data.port;
  try {
    const model = await loadModel("tiny");
    if (model.sampleRate !== 48000 || model.hopSize !== BACKGROUND_HOP) throw new Error("Unsupported separation format");
    const left = await model.createDenoiser(), right = await model.createDenoiser();
    left.agcEnabled = right.agcEnabled = false;
    left.hpfEnabled = right.hpfEnabled = false;
    const separator = new BackgroundSeparator([left, right]);
    let next = 0, failed = false;
    port.onmessage = (message: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      if (failed) return;
      try {
        if (message.data.id !== next++) throw new Error("Background audio fell behind");
        const channels = separator.process(message.data.channels);
        port.postMessage({ channels }, channels.map(channel => channel.buffer as ArrayBuffer));
      } catch {
        failed = true; separator.destroy();
        self.postMessage({ error: true });
      }
    };
    port.start();
    self.postMessage({ ready: true });
  } catch { self.postMessage({ error: true }); }
};

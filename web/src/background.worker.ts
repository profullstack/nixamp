import { createBackgroundSeparator } from "./background-model.ts";

/** Model inference stays off the page and audio-rendering threads. */
self.onmessage = async (event: MessageEvent<{ port: MessagePort }>) => {
  const port = event.data.port;
  try {
    const separator = await createBackgroundSeparator();
    let previous = -1, failed = false;
    port.onmessage = (message: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      if (failed) return;
      try {
        const id = message.data.id;
        if (!Number.isSafeInteger(id) || id <= previous) throw new Error("Invalid background audio order");
        if (id !== previous + 1) separator.discontinuity();
        const channels = separator.process(message.data.channels);
        // Model alignment plus overlap-add delays output by two input hops.
        port.postMessage({ id: id - 2, channels }, channels.map(channel => channel.buffer as ArrayBuffer));
        previous = id;
      } catch {
        failed = true; separator.destroy();
        self.postMessage({ error: true });
      }
    };
    port.start();
    self.postMessage({ ready: true });
  } catch (error) { self.postMessage({ error: true, reason: error instanceof Error ? error.message : "Background model unavailable" }); }
};

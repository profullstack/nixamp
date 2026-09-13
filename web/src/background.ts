/** Local speech removal for background sound while translated voices play.
 * Failure silences this branch; original commentary is never used as fallback. */
export class BackgroundAudio {
  private generation = 0;
  private worker: Worker | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private input: AudioNode | null = null;
  private pendingPort: MessagePort | null = null;
  private cancelStart: (() => void) | null = null;
  private on = false;
  private level = 1;
  private static loaded = new WeakMap<AudioContext, Promise<void>>();
  constructor(private readonly failed: () => void) {}

  async start(context: AudioContext, input: AudioNode): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    try {
      if (context.sampleRate !== 48000) throw new Error("Unsupported background sample rate");
      let module = BackgroundAudio.loaded.get(context);
      if (!module) {
        module = context.audioWorklet.addModule(new URL("./background.worklet.js", import.meta.url));
        BackgroundAudio.loaded.set(context, module);
        void module.catch(() => BackgroundAudio.loaded.delete(context));
      }
      await module;
      if (generation !== this.generation) return false;
      const worker = new Worker(new URL("./background.worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      const connection = new MessageChannel();
      this.pendingPort = connection.port1;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); this.cancelStart = null;
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Background model did not load")), 8000);
        this.cancelStart = () => finish(new Error("Background loading cancelled"));
        worker.onerror = () => finish(new Error("Background worker failed"));
        worker.onmessage = event => finish(event.data.ready ? undefined : new Error("Background model unavailable"));
        worker.postMessage({ port: connection.port2 }, [connection.port2]);
      });
      if (generation !== this.generation) return false;
      const fail = (): void => { if (generation === this.generation) { this.stop(); this.failed(); } };
      worker.onerror = fail; worker.onmessage = event => { if (event.data.error) fail(); };
      // Keep the source layout until dialogue is separated. Mixing a surround
      // file into stereo first would mix its ambience into the speech estimate.
      const node = new AudioWorkletNode(context, "nixamp-background", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 8, channelCountMode: "clamped-max", channelInterpretation: "speakers",
      });
      this.node = node;
      node.onprocessorerror = fail;
      node.port.onmessage = event => { if (event.data.error) fail(); };
      node.port.postMessage({ port: connection.port1 }, [connection.port1]);
      this.pendingPort = null;
      const gain = context.createGain(); this.gain = gain; gain.gain.value = this.on ? this.level : 0;
      this.input = input; node.connect(gain); gain.connect(context.destination); input.connect(node);
      return true;
    } catch { if (generation === this.generation) { this.stop(); this.failed(); } }
    return false;
  }
  active(on: boolean): void { this.on = on; if (this.gain) this.gain.gain.value = on ? this.level : 0; }
  setLevel(level: number): void {
    if (!Number.isFinite(level)) return;
    this.level = Math.max(0, Math.min(2, level));
    if (this.gain) this.gain.gain.value = this.on ? this.level : 0;
  }
  stop(): void {
    this.generation++; this.on = false;
    this.cancelStart?.(); this.cancelStart = null;
    this.pendingPort?.close(); this.pendingPort = null;
    if (this.node) {
      this.node.port.postMessage({ stop: true });
      try { this.input?.disconnect(this.node); } catch { /* source already detached */ }
      this.node.disconnect(); this.node.port.close();
    }
    this.gain?.disconnect(); this.worker?.terminate();
    this.worker = null; this.node = null; this.gain = null; this.input = null;
  }
}

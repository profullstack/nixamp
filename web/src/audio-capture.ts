import tapUrl from "./audio-tap.worklet.js?url";
import { encodeWav } from "./dictate.ts";

export interface AudioWindow { samples: Float32Array; at: number; until: number; freshAt: number; }
const loaded = new WeakMap<AudioContext, Promise<void>>();

/** A bounded rolling window: 5 new seconds, up to 10 seconds of speaker
 * context. Original-only transcription sends just the new 5 seconds. */
export class AudioCapture {
  private tap: AudioWorkletNode | null = null;
  private generation = 0;
  constructor(private readonly take: (window: AudioWindow) => void) {}

  async start(context: AudioContext, source: AudioNode): Promise<void> {
    this.stop();
    const generation = this.generation;
    if (!context.audioWorklet) throw new Error("Live translation needs a browser with AudioWorklet support on HTTPS.");
    if (!loaded.has(context)) loaded.set(context, context.audioWorklet.addModule(tapUrl).catch(error => { loaded.delete(context); throw error; }));
    await loaded.get(context);
    if (generation !== this.generation) return;
    const tap = new AudioWorkletNode(context, "nixamp-audio-tap");
    this.tap = tap;
    const mute = context.createGain(); mute.gain.value = 0;
    source.connect(tap); tap.connect(mute); mute.connect(context.destination);
    let pending = new Float32Array(context.sampleRate * 5);
    let used = 0, previous = new Float32Array(0), until = Date.now();
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (generation !== this.generation) return;
      let offset = 0;
      const block = event.data;
      while (offset < block.length) {
        const count = Math.min(pending.length - used, block.length - offset);
        pending.set(block.subarray(offset, offset + count), used); used += count; offset += count;
        if (used !== pending.length) continue;
        const fresh = new Float32Array(80_000);
        const ratio = context.sampleRate / 16000;
        // Average each destination interval, reducing aliasing when downsampling.
        for (let i = 0; i < fresh.length; i++) {
          const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
          let sum = 0; for (let j = start; j < end; j++) sum += pending[j] ?? 0;
          fresh[i] = sum / (end - start);
        }
        until += 5000;
        // A suspended tab/context must not produce old wall-clock timestamps.
        if (Math.abs(Date.now() - until) > 1500) { until = Date.now(); previous = new Float32Array(0); }
        const samples = new Float32Array(previous.length + fresh.length);
        samples.set(previous); samples.set(fresh, previous.length);
        this.take({ samples, at: until - samples.length / 16, until, freshAt: until - 5000 });
        previous = samples.slice(-160_000); used = 0;
      }
    };
    this.disconnect = () => { tap.port.onmessage = null; tap.port.close(); source.disconnect(tap); tap.disconnect(); mute.disconnect(); };
    await context.resume();
  }

  private disconnect: (() => void) | null = null;
  stop(): void { this.generation++; this.disconnect?.(); this.disconnect = null; this.tap = null; }
}

export function windowWav(window: AudioWindow, speakers: boolean): Uint8Array {
  return encodeWav(speakers ? window.samples : window.samples.slice(-80_000));
}

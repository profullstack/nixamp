import type { Caption } from "./captions.ts";

export interface VoiceChoice { id: string; name: string; gender: string; language: string; }
export interface VoiceOptions { voices: VoiceChoice[]; languages: string[]; model: string; }
export const MAX_VOICE_DELAY_MS = 12_000;

/** A streaming PCM player beside the unchanged video. Bounded speech queued
 * ahead of playback, with a generation guard for language/channel/voice changes.
 */
export class LiveVoicePlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private enabled = false;
  private generation = 0;
  private running: number | null = null;
  private controller: AbortController | null = null;
  private next: { line: Caption; url: string; lag: number; init?: RequestInit }[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private scheduledUntil = 0;
  private seen = new Set<string>();

  constructor(private readonly options: {
    active: (on: boolean) => void;
    status: (text: string) => void;
    playing: () => boolean;
    volume: () => number;
    failed: () => void;
    fetcher?: typeof fetch;
    audioContext?: () => AudioContext;
    now?: () => number;
    authorization?: (signal: AbortSignal, line: Caption) => Promise<HeadersInit>;
  }) {}

  async enable(): Promise<void> {
    this.enabled = true;
    // Own the output for the whole translation session, including the wait
    // for the first line, gaps, speaker changes and capture restarts.
    this.options.active(true);
    try {
      this.context ??= this.options.audioContext?.() ?? new AudioContext();
      if (!this.gain) {
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
      }
      await this.context.resume();
      if (this.enabled) this.options.status("Waiting for the next translated line…");
    } catch {
      this.fail("Audio could not start. Enable translated audio again to retry.");
    }
  }

  disable(): void { this.enabled = false; this.reset(); }

  reset(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.next = [];
    this.running = null;
    this.seen.clear();
    for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } }
    this.sources.clear();
    this.scheduledUntil = 0;
    this.options.active(this.enabled);
  }

  setVolume(): void { if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, this.options.volume())); }

  /** Only new SSE lines are offered here; replayed transcript history is never spoken. */
  push(line: Caption, url: string, lag: number): void {
    this.pushBatch([{ line, url, lag }]);
  }

  /** Preserve unplayed turns when a newer window arrives. Stale speech and
   * a hard queue bound prevent an unlimited dubbing backlog. */
  pushBatch(items: { line: Caption; url: string; lag: number; init?: RequestInit }[]): void {
    if (!this.enabled || !this.options.playing()) return;
    const batch = items.slice(0, 12).filter(({ line, lag }) => {
      const id = `${line.channel}|${line.at}|${line.language}|${line.speaker ?? ""}`;
      if (this.seen.has(id) || this.stale(line, lag)) return false;
      this.seen.add(id);
      if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value as string);
      return true;
    });
    if (!batch.length) return;
    this.next = [...this.next.filter(item => !this.stale(item.line, item.lag)), ...batch].slice(-24);
    if (this.running === null) void this.run(this.generation);
  }

  private stale(line: Caption, lag: number): boolean {
    return (this.options.now?.() ?? Date.now()) - lag - line.until > MAX_VOICE_DELAY_MS;
  }

  private fail(message: string): void {
    this.disable();
    this.options.status(`${message} Original audio restored.`);
    this.options.failed();
  }

  private async run(generation: number): Promise<void> {
    this.running = generation;
    try {
      while (this.next.length && this.enabled && generation === this.generation) {
        // Fetch while the preceding phrase is still playing. Waiting until
        // it ends inserts the full network/provider latency at every turn.
        await this.waitForRoom(generation, 3);
        if (generation !== this.generation) return;
        const item = this.next.shift()!;
        if (this.stale(item.line, item.lag) || !this.options.playing()) continue;
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const headers = new Headers(item.init?.headers);
          new Headers(await this.options.authorization?.(controller.signal, item.line)).forEach((value, key) => headers.set(key, value));
          if (generation !== this.generation) return;
          const response = await (this.options.fetcher ?? fetch)(item.url, { ...item.init, signal: controller.signal, headers });
          if (generation !== this.generation) { await response.body?.cancel(); return; }
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error || "Translated audio is unavailable.");
          }
          if (!response.body || !response.headers.get("content-type")?.startsWith("audio/pcm")) throw new Error("The server returned no voice audio.");
          const reader = response.body.getReader();
          let remainder = new Uint8Array(0);
          let received = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (generation !== this.generation) { await reader.cancel(); return; }
              if (done) break;
              const bytes = new Uint8Array(remainder.length + value.length);
              bytes.set(remainder); bytes.set(value, remainder.length);
              const length = bytes.length - bytes.length % 2;
              remainder = bytes.slice(length);
              // Bound decoded audio even when the network delivers a whole
              // long response at once. Backpressure must not restore native
              // audio or discard the remaining words.
              for (let offset = 0; offset < length; offset += 6400) {
                await this.waitForRoom(generation, 8);
                if (generation !== this.generation) { await reader.cancel(); return; }
                const chunk = bytes.subarray(offset, Math.min(length, offset + 6400));
                this.schedule(chunk); received += chunk.length;
              }
            }
          } finally { reader.releaseLock(); }
          if (!received || remainder.length) throw new Error("The voice audio was interrupted.");
        } finally { clearTimeout(timeout); }
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : "Translated audio stopped.");
    } finally {
      if (this.running === generation) this.running = null;
    }
  }

  private async waitForRoom(generation: number, seconds: number): Promise<void> {
    while (generation === this.generation && this.context && this.scheduledUntil - this.context.currentTime > seconds) {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (!this.options.playing()) { this.reset(); return; }
    }
  }

  private schedule(bytes: Uint8Array): void {
    const context = this.context;
    if (!context || !this.gain || !this.enabled) return;
    if (context.state !== "running") throw new Error("Audio playback was suspended.");
    const samples = bytes.length / 2;
    const start = Math.max(context.currentTime + 0.03, this.scheduledUntil);
    if (start - context.currentTime + samples / 16000 > 10) throw new Error("Translated audio fell too far behind.");
    const buffer = context.createBuffer(1, samples, 16000);
    const floats = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let i = 0; i < samples; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.setVolume();
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(start);
    this.scheduledUntil = start + buffer.duration;
    this.options.status("Playing translated audio · a few seconds behind the video");
  }
}

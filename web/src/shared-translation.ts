import type { Caption } from "./captions.ts";
import type { SharedEvent } from "../../src/shared-translation.ts";

/** One authenticated event stream carries captions and shared PCM. */
export class SharedAudio {
  private controller: AbortController | null = null;
  private clips = new Map<string, { stream: ReadableStream<Uint8Array>; controller: ReadableStreamDefaultController<Uint8Array>; bytes: number; ended: boolean; taken: boolean }>();
  constructor(private readonly options: { line: (line: Caption, url: string) => void; status: (text: string) => void; failed: (error: string) => void }) {}
  async start(source: string, language: string): Promise<void> {
    this.stop();
    const controller = new AbortController(); this.controller = controller;
    const response = await fetch("/api/v1/speech/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, language }), signal: controller.signal });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})); throw new Error(body.error || "Live translation is unavailable.");
    }
    void this.read(response.body, controller);
  }
  stop(): void {
    this.controller?.abort(); this.controller = null;
    for (const clip of this.clips.values()) if (!clip.ended) { try { clip.controller.error(new DOMException("Playback stopped", "AbortError")); } catch { /* already closed */ } }
    this.clips.clear();
  }
  audio(url: string): Response {
    const clip = this.clips.get(url);
    if (!clip || clip.taken) throw new Error("The live audio segment expired.");
    clip.taken = true;
    return new Response(clip.stream, { headers: { "content-type": "audio/pcm" } });
  }
  private async read(body: ReadableStream<Uint8Array>, active: AbortController): Promise<void> {
    const reader = body.getReader(), decoder = new TextDecoder(); let pending = "";
    try {
      while (!active.signal.aborted) {
        const { done, value } = await reader.read(); if (done) throw new Error("Live translation disconnected. Enable it again to reconnect.");
        pending += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          this.event(JSON.parse(frame.slice(6)) as SharedEvent);
        }
        if (pending.length > 128_000) throw new Error("Invalid live audio response.");
      }
    } catch (error) {
      if (!active.signal.aborted && this.controller === active) { this.stop(); this.options.failed(error instanceof Error ? error.message : "Live audio was interrupted."); }
    } finally { reader.releaseLock(); }
  }
  private event(event: SharedEvent): void {
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "status") { this.options.status(`Live translated audio · ${event.listeners} ${event.listeners === 1 ? "listener" : "listeners"}`); return; }
    const key = `nixamp-shared:${event.id}`;
    if (event.type === "line") {
      // Finished segments need only survive the player's short lookahead.
      for (const [id, clip] of this.clips) if (clip.ended && clip.taken) this.clips.delete(id);
      if (this.clips.size >= 24) throw new Error("Live translated audio fell behind.");
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: sink => { controller = sink; } });
      this.clips.set(key, { stream, controller, bytes: 0, ended: false, taken: false });
      this.options.line(event.line, key); return;
    }
    const clip = this.clips.get(key); if (!clip || clip.ended) return;
    if (event.type === "end") { clip.ended = true; clip.controller.close(); return; }
    const bytes = Uint8Array.from(atob(event.data), char => char.charCodeAt(0));
    clip.bytes += bytes.length;
    if (clip.bytes > 2 * 1024 * 1024) throw new Error("The live audio segment was too large.");
    clip.controller.enqueue(bytes);
  }
}

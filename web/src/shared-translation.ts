import type { Caption } from "./captions.ts";
import type { SharedEvent } from "../../src/shared-translation.ts";
import { audioError, transientAudioError } from "../../src/live-recovery.ts";

type Clip = { stream: ReadableStream<Uint8Array>; controller: ReadableStreamDefaultController<Uint8Array>; bytes: number; ended: boolean; taken: boolean; until: number };
/** One authenticated event stream carries captions and shared PCM. Reconnection
 * reuses the server's active session; access and rate failures never retry. */
export class SharedAudio {
  private controller: AbortController | null = null;
  private clips = new Map<string, Clip>();
  constructor(private readonly options: {
    line: (line: Caption, url: string) => void; status: (text: string) => void;
    failed: (error: string) => void; reconnecting?: () => void;
    fetcher?: typeof fetch;
  }) {}
  async start(source: string, language: string): Promise<void> {
    this.stop();
    const active = new AbortController(); this.controller = active;
    const connect = async (): Promise<ReadableStream<Uint8Array>> => {
      const connection = new AbortController();
      const timeout = setTimeout(() => connection.abort(), 12_000);
      const response = await (this.options.fetcher ?? fetch)("/api/v1/speech/shared", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, language }), signal: AbortSignal.any([active.signal, connection.signal]) }).finally(() => clearTimeout(timeout));
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})); throw audioError(body.error || "Live translation is unavailable.", response.status);
      }
      return response.body;
    };
    const body = await connect();
    if (this.controller !== active) { await body.cancel(); return; }
    void this.consume(body, active, connect);
  }
  private clearClips(): void {
    for (const clip of this.clips.values()) if (!clip.ended) { try { clip.controller.error(new DOMException("Playback stopped", "AbortError")); } catch { /* already closed */ } }
    this.clips.clear();
  }
  stop(): void { this.controller?.abort(); this.controller = null; this.clearClips(); }
  audio(url: string): Response {
    const clip = this.clips.get(url);
    if (!clip || clip.taken) throw audioError("The live audio segment expired. Catching up…", 503);
    clip.taken = true;
    return new Response(clip.stream, { headers: { "content-type": "audio/pcm" } });
  }
  private async consume(body: ReadableStream<Uint8Array>, active: AbortController, connect: () => Promise<ReadableStream<Uint8Array>>): Promise<void> {
    let failures = 0;
    while (!active.signal.aborted) {
      const started = Date.now();
      try { await this.read(body, active); return; }
      catch (error) {
        if (active.signal.aborted || this.controller !== active) return;
        if (Date.now() - started > 60_000) failures = 0;
        this.options.reconnecting?.(); this.clearClips();
        let problem = error;
        while (!active.signal.aborted) {
          if (!transientAudioError(problem) || failures >= 5) {
            this.stop(); this.options.failed(problem instanceof Error ? problem.message : "Live audio was interrupted."); return;
          }
          this.options.status("Live audio disconnected · reconnecting…");
          await new Promise<void>(resolve => {
            const done = (): void => { clearTimeout(timer); active.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 500 * 2 ** failures++);
            active.signal.addEventListener("abort", done, { once: true });
          });
          if (active.signal.aborted) return;
          try { body = await connect(); break; } catch (error) { problem = error; }
        }
      }
    }
  }
  private async read(body: ReadableStream<Uint8Array>, active: AbortController): Promise<void> {
    const reader = body.getReader(), decoder = new TextDecoder(); let pending = "";
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    active.signal.addEventListener("abort", cancel, { once: true });
    try {
      while (!active.signal.aborted) {
        let timer!: ReturnType<typeof setTimeout>;
        const { done, value } = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(audioError("Live audio connection timed out.", 503)); cancel(); }, 25_000);
        })]).finally(() => clearTimeout(timer));
        if (active.signal.aborted) return;
        if (done) throw audioError("Live translation disconnected.", 503);
        pending += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          this.event(JSON.parse(frame.slice(6)) as SharedEvent);
        }
        if (pending.length > 128_000) throw new Error("Invalid live audio response.");
      }
    } finally { active.signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private event(event: SharedEvent): void {
    if (event.type === "error") throw audioError(event.error, event.retryable ? 503 : 400);
    if (event.type === "status") { this.options.status(`Live translated audio · ${event.listeners} ${event.listeners === 1 ? "listener" : "listeners"}`); return; }
    const key = `nixamp-shared:${event.id}`;
    if (event.type === "line") {
      // Untaken segments include captions dropped by the bounded live player.
      // They must expire too, otherwise 24 skipped phrases end the whole stream.
      for (const [id, clip] of this.clips) if (clip.ended && (clip.taken || Date.now() - clip.until > 12_000)) this.clips.delete(id);
      while (this.clips.size >= 24) {
        const oldest = this.clips.entries().next().value!;
        if (!oldest[1].ended) oldest[1].controller.error(audioError("Catching up with live audio…", 503));
        this.clips.delete(oldest[0]);
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: sink => { controller = sink; },
        cancel: () => { const clip = this.clips.get(key); if (clip) clip.ended = true; this.clips.delete(key); },
      });
      this.clips.set(key, { stream, controller, bytes: 0, ended: false, taken: false, until: event.line.until });
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

/**
 * RTMP publishers, several at once.
 *
 * ffmpeg's RTMP listener serves one connection and exits, so N simultaneous
 * publishers means N listeners on N ports. That is the honest cost of using
 * ffmpeg as the RTMP server rather than implementing the protocol, and it buys
 * a broadcaster that every phone and desktop app already speaks.
 *
 * Each listener decodes to MP3 itself, so its channel fans those bytes out
 * without decoding them a second time.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Channels } from "./channels.ts";

export interface RtmpSlot {
  port: number;
  /** The channel a publisher on this port lands on. */
  id: string;
}

/**
 * Arm a listener per slot, and arm it again after each publisher leaves --
 * otherwise a broadcaster who reconnects finds nothing listening.
 */
export class RtmpListeners {
  private readonly running = new Map<number, ChildProcess>();
  private stopped = false;

  constructor(
    private readonly channels: Channels,
    private readonly ffmpeg: string[],
    private readonly key: string,
  ) {}

  listen(slots: RtmpSlot[]): void {
    for (const slot of slots) this.arm(slot);
  }

  private arm(slot: RtmpSlot): void {
    if (this.stopped || this.running.has(slot.port)) return;

    const [command, ...prefix] = this.ffmpeg as [string, ...string[]];
    const child = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel", "error",
        "-rtmp_listen", "1",
        // Wait indefinitely: a stream that starts tomorrow is still the stream.
        "-timeout", "-1",
        "-f", "flv",
        "-i", `rtmp://0.0.0.0:${slot.port}/live/${this.key}`,
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-y",
        "-f", "mp3",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.running.set(slot.port, child);

    // The first bytes are the only honest signal that a publisher turned up:
    // ffmpeg does not announce a connect, and a healthy stream says nothing at
    // -loglevel error.
    let channel: ReturnType<Channels["attach"]> = null;
    child.stdout?.on("data", (chunk: Buffer) => {
      channel ??= this.channels.attach(slot.id, "an RTMP publisher", "flv", "rtmp");
      channel?.feed(chunk);
    });
    child.stdout?.on("error", () => child.kill("SIGKILL"));
    // Read and dropped. A pipe nobody reads fills at 64 KiB, and ffmpeg then
    // blocks on its next complaint and stops producing anything -- a
    // publisher whose stream hiccups enough would take the slot down with it.
    child.stderr?.resume();
    child.on("error", () => this.done(slot, child, channel));
    child.on("close", () => this.done(slot, child, channel));
  }

  private done(slot: RtmpSlot, child: ChildProcess, channel: { close(): void } | null): void {
    if (this.running.get(slot.port) !== child) return;
    this.running.delete(slot.port);
    channel?.close();
    if (!this.stopped) this.arm(slot);
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.running.values()) child.kill("SIGKILL");
    this.running.clear();
  }
}

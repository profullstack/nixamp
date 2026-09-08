/**
 * Several streams at once.
 *
 * A channel is one live source and everybody listening to it. Two or three
 * devices can publish at the same time -- a phone, a desktop, a second window
 * -- and each has its own audience, so a listener picks which one to hear.
 *
 * The fan-out is the point. One ffmpeg decodes a publisher's bytes once, and
 * the MP3 it produces is written to every listener attached to that channel.
 * A decode per listener would cost a CPU core each and, for a live stream,
 * would not even agree with itself about what "now" is.
 *
 * A listener joining halfway through gets the stream from that moment, which is
 * what live means. MP3 frames are self-describing, so a player finds the next
 * frame boundary and carries on; there is nothing to catch up on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

/** Somewhere for a channel's audio to go. A response, in practice. */
export interface Listener {
  write(chunk: Buffer): boolean;
  end(): void;
}

export interface ChannelInfo {
  id: string;
  /** What the publisher called itself. */
  name: string;
  /** The container it is sending, e.g. webm from a browser, flv over RTMP. */
  format: string;
  /** How it arrived. */
  via: "http" | "rtmp";
  startedAt: number;
  bytes: number;
  listeners: number;
}

/** A name that can sit in a URL and be read back in a list. */
export function cleanId(value: unknown, fallback = "main"): string {
  if (typeof value !== "string") return fallback;
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return id.slice(0, 40) || fallback;
}

export interface ChannelOptions {
  ffmpeg: string[];
  onStart?: (info: ChannelInfo) => void;
  onEnd?: (info: ChannelInfo) => void;
}

/**
 * One live source, and its audience.
 *
 * Everything a listener is sent has been through ffmpeg, so a publisher cannot
 * decide what bytes reach a browser by choosing what to send.
 */
export class Channel {
  readonly listeners = new Set<Listener>();
  private child: ChildProcess | null = null;
  private closing = false;

  constructor(
    readonly info: ChannelInfo,
    private readonly options: ChannelOptions,
    private readonly onGone: (id: string) => void,
  ) {}

  start(format: string): void {
    const [command, ...prefix] = this.options.ffmpeg as [string, ...string[]];
    const child = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel", "error",
        // Stated, because ffmpeg mis-probes a live unseekable pipe: it reads a
        // few kilobytes, guesses, and guesses wrong.
        "-f", format,
        "-i", "pipe:0",
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-f", "mp3",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      this.info.bytes += chunk.byteLength;
      this.send(chunk);
    });
    // A publisher that hangs up mid-write breaks the pipe, and an unhandled
    // EPIPE takes the whole server with it.
    child.stdin?.on("error", () => this.close());
    child.stdout?.on("error", () => this.close());
    child.on("error", () => this.close());
    child.on("close", () => this.close());

    this.child = child;
    this.options.onStart?.(this.info);
  }

  /** Feed the source. */
  write(chunk: Buffer): boolean {
    return this.child?.stdin?.write(chunk) ?? false;
  }

  async pump(body: Readable): Promise<void> {
    for await (const chunk of body) {
      if (this.closing) return;
      if (!this.write(chunk as Buffer)) {
        await new Promise((done) => this.child?.stdin?.once("drain", done) ?? done(null));
      }
    }
  }

  /**
   * Audio that is already in its final form, from a source we did not spawn.
   * The bytes still only reach a listener after something decoded them; it was
   * simply a different process that did it.
   */
  feed(chunk: Buffer): void {
    this.info.bytes += chunk.byteLength;
    this.send(chunk);
  }

  /** Write to everyone, and drop anybody whose socket has gone. */
  private send(chunk: Buffer): void {
    for (const listener of this.listeners) {
      try {
        listener.write(chunk);
      } catch {
        // One listener's broken socket is not the channel's problem.
        this.listeners.delete(listener);
      }
    }
    this.info.listeners = this.listeners.size;
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    this.info.listeners = this.listeners.size;
    return () => {
      this.listeners.delete(listener);
      this.info.listeners = this.listeners.size;
    };
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    this.child = null;
    try {
      child?.stdin?.end();
    } catch {
      // Already broken, which is usually why we are here.
    }
    child?.kill("SIGKILL");
    // Listeners are ended rather than left hanging on a stream that stopped.
    for (const listener of this.listeners) {
      try {
        listener.end();
      } catch {
        // Gone already.
      }
    }
    this.listeners.clear();
    this.info.listeners = 0;
    this.options.onEnd?.(this.info);
    this.onGone(this.info.id);
  }
}

/**
 * Every channel currently live.
 *
 * A channel exists while somebody is publishing to it and disappears when they
 * stop, so the list is what is actually on rather than what was once
 * configured.
 */
export class Channels {
  private readonly open = new Map<string, Channel>();

  constructor(private readonly options: ChannelOptions) {}

  list(): ChannelInfo[] {
    return [...this.open.values()]
      .map((channel) => channel.info)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get count(): number {
    return this.open.size;
  }

  /** Total listeners across every channel. */
  get listeners(): number {
    let total = 0;
    for (const channel of this.open.values()) total += channel.listeners.size;
    return total;
  }

  has(id: string): boolean {
    return this.open.has(id);
  }

  /**
   * Claim a channel and start decoding into it. Null when that channel is
   * already being published to: two publishers on one channel would be two
   * songs at once, which is never what anybody meant. Publishing to a
   * *different* channel is exactly what this class exists for.
   */
  publish(id: string, name: string, format: string, via: ChannelInfo["via"]): Channel | null {
    if (this.open.has(id)) return null;
    const channel = new Channel(
      {
        id,
        name: name || "a device",
        format,
        via,
        startedAt: Date.now(),
        bytes: 0,
        listeners: 0,
      },
      this.options,
      (gone) => this.open.delete(gone),
    );
    this.open.set(id, channel);
    channel.start(format);
    return channel;
  }

  /** Attach a listener, or null when nothing is playing on that channel. */
  listen(id: string, listener: Listener): (() => void) | null {
    const channel = this.open.get(id);
    return channel ? channel.listen(listener) : null;
  }

  /** Feed a channel that already exists, for a publisher sending chunks. */
  writeTo(id: string, chunk: Buffer): boolean {
    return this.open.get(id)?.write(chunk) ?? false;
  }

  /**
   * A channel fed by audio somebody else is already decoding.
   *
   * An RTMP listener is an ffmpeg with a publisher on one end, and it produces
   * MP3 on its own. Spawning a second ffmpeg to decode what the first one just
   * decoded would double the work to arrive at the same bytes.
   */
  attach(id: string, name: string, format: string, via: ChannelInfo["via"]): Channel | null {
    if (this.open.has(id)) return null;
    const channel = new Channel(
      { id, name: name || "a device", format, via, startedAt: Date.now(), bytes: 0, listeners: 0 },
      this.options,
      (gone) => this.open.delete(gone),
    );
    this.open.set(id, channel);
    return channel;
  }

  stop(id: string): boolean {
    const channel = this.open.get(id);
    if (!channel) return false;
    channel.close();
    return true;
  }

  stopAll(): void {
    for (const channel of [...this.open.values()]) channel.close();
  }
}

/** A channel id nobody chose, for a publisher that did not name one. */
export function generatedId(): string {
  return `s${randomBytes(3).toString("hex")}`;
}

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
import { Fragments } from "./fragments.ts";

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
  via: "http" | "rtmp" | "pull";
  startedAt: number;
  bytes: number;
  listeners: number;
  /**
   * Whether there is a picture, which decides what a listener is sent and
   * what the response calls it. A channel that says audio/mpeg while sending
   * MP4 plays as nothing at all.
   */
  kind?: "audio" | "video";
  /** For a channel we pull ourselves: where from. Never shown to a listener. */
  source?: string;
}

/** How long to wait before dialling a dropped source again. */
export const REDIAL = 2000;
/** How many times in a row a source may fail without ever sending anything. */
export const GIVE_UP = 5;

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
  /** Set for a channel that carries pictures, which cannot be joined blind. */
  private fragments: Fragments | null = null;
  /** For a pulled channel: what to run, and how many times it has failed. */
  private redial: (() => void) | null = null;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Fetch a source ourselves, rather than waiting to be sent one.
   *
   * This is what makes a re-stream a channel instead of a track. A track is
   * played by the one player a server has, so a second one is a second thing
   * that server cannot do at the same time; a channel is its own process with
   * its own audience, and a server can carry as many as it can decode. Two
   * channels means two tabs, or two panels of a multiview.
   *
   * It keeps running with nobody listening. Live television does not pause
   * because you looked away, and a room where the picture depends on who is
   * in it is not a room anybody can be invited to.
   */
  pull(source: string, encode: string[], paced = true): void {
    if (this.info.kind === "video") this.fragments = new Fragments();
    const [command, ...prefix] = this.options.ffmpeg as [string, ...string[]];
    const remote = /^https?:\/\//i.test(source);

    const dial = (): void => {
      if (this.closing) return;
      const child = spawn(
        command,
        [
          ...prefix,
          "-hide_banner",
          "-loglevel", "error",
          // A dropped source is normal over hours, and a channel that dies
          // the first time a CDN hiccups is not a channel anybody can rely
          // on. ffmpeg redials on its own before we have to.
          ...(remote ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []),
          // Real time, always. A file read as fast as the disk allows is an
          // hour of film in ninety seconds and a room that cannot be in it
          // together; a live source is already paced and loses nothing.
          ...(paced ? ["-re"] : []),
          "-i", source,
          ...encode,
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let sent = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        sent = true;
        this.info.bytes += chunk.byteLength;
        this.emit(chunk);
      });
      child.stdout?.on("error", () => undefined);
      child.on("error", () => this.dropped(sent));
      child.on("close", () => this.dropped(sent));
      this.child = child;
    };

    this.redial = dial;
    dial();
    this.options.onStart?.(this.info);
  }

  /**
   * A source that stopped. Try it again, unless it never worked at all.
   *
   * The difference matters: a channel that ran for six hours and dropped is
   * worth dialling again, and a URL that has never once produced a byte is a
   * mistake somebody made, and retrying it for ever helps nobody.
   */
  private dropped(sent: boolean): void {
    if (this.closing || !this.redial) return;
    this.child = null;
    this.failures = sent ? 0 : this.failures + 1;
    if (this.failures >= GIVE_UP) {
      this.close();
      return;
    }
    const dial = this.redial;
    this.timer = setTimeout(() => {
      this.timer = null;
      dial();
    }, REDIAL);
    // A redial is not a reason to keep the process alive at exit.
    this.timer.unref?.();
  }

  /**
   * Out to the audience, whole boxes at a time when there are boxes.
   *
   * Video listeners are only ever sent complete boxes, so that a new one can
   * be given the opening boxes and then join at the next fragment and have it
   * make sense.
   */
  private emit(chunk: Buffer): void {
    if (!this.fragments) {
      this.send(chunk);
      return;
    }
    for (const box of this.fragments.push(chunk)) this.send(box);
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
    // What the stream is, before any of what it is currently saying. Without
    // this a listener who arrives after the first second gets fragments that
    // reference tracks they were never told about: a blank panel, no error.
    if (this.fragments?.ready) {
      try {
        listener.write(this.fragments.header);
      } catch {
        // Gone before it began; the detach below still tidies up.
      }
    }
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
    this.redial = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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

  /**
   * Carry a source of our own: a re-stream, or a film on this disk shown live.
   *
   * Null when that channel is taken, the same as publishing. Everything else
   * about it is the same too, which is the point -- a re-stream stops being a
   * special case and becomes one more thing that is on.
   */
  pull(
    id: string,
    name: string,
    source: string,
    encode: string[],
    kind: "audio" | "video",
    paced = true,
  ): Channel | null {
    if (this.open.has(id)) return null;
    const channel = new Channel(
      {
        id,
        name: name || source,
        format: kind === "video" ? "mp4" : "mp3",
        via: "pull",
        startedAt: Date.now(),
        bytes: 0,
        listeners: 0,
        kind,
        source,
      },
      this.options,
      (gone) => this.open.delete(gone),
    );
    this.open.set(id, channel);
    channel.pull(source, encode, paced);
    return channel;
  }

  /** What a listener should be told this channel is. */
  contentType(id: string): string {
    return this.open.get(id)?.info.kind === "video" ? "video/mp4" : "audio/mpeg";
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

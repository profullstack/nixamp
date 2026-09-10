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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Fragments, isOpening } from "./fragments.ts";

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
  /** The last thing ffmpeg complained about, for whoever administers this. */
  error?: string;
  /** How many times the source has been dialled again since it started. */
  redials?: number;
}

/** How long to wait before dialling a dropped source again. */
export const REDIAL = 2000;
/** How many times in a row a source may fail without ever sending anything. */
export const GIVE_UP = 5;
/**
 * How long a pulled source may say nothing before it is treated as gone.
 *
 * ffmpeg's own reconnect covers a connection that errors. It does not cover
 * one that simply stops sending, and neither does anything else: a television
 * channel that is quiet for half a minute is not being quiet, it is dead.
 */
export const STALL = 30_000;
/** How long an on-demand channel stays up with nobody watching. */
export const IDLE = 60_000;
/** How much of what ffmpeg said to keep, for the last line when it dies. */
const TAIL = 2000;
/**
 * How much of the recent stream a newcomer is handed. About six seconds of
 * 720p television, and a couple of seconds of 192k MP3: enough to play
 * through a hiccup, not enough to put a viewer noticeably behind the room.
 */
export const BACKLOG_VIDEO = 4 * 1024 * 1024;
export const BACKLOG_AUDIO = 64 * 1024;

/** The four-letter name in a box header, or "" for something too short. */
function boxType(box: Buffer): string {
  return box.length >= 8 ? box.toString("latin1", 4, 8) : "";
}

/**
 * Read everything a child says on stderr, keeping only the end of it.
 *
 * This is not optional. A pipe nobody reads fills, at 64 KiB on Linux, and
 * the child then blocks on its next write to it -- every thread it has waits
 * on the one that is stuck, and it produces nothing more, for ever, without
 * exiting. A channel carrying an IPTV transport stream logs a line for every
 * corrupt packet, and over twelve hours that is more than 64 KiB. Measured on
 * the real server: CNN "on the air" with a full stderr socket, its decoder
 * thread asleep in the kernel on that write, its byte count frozen, and a
 * listener handed the opening boxes and then nothing at all.
 */
function drain(stream: Readable | null | undefined, keep: (tail: string) => void): void {
  let tail = "";
  stream?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-TAIL);
    keep(tail);
  });
  stream?.on("error", () => undefined);
}

/** The last thing ffmpeg said, which is where it says what went wrong. */
function lastLine(tail: string): string {
  return tail.trim().split("\n").pop() ?? "";
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
  /** How long an on-demand channel outlives its last viewer. Tests shorten it. */
  idleMs?: number;
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
  /** Fires when a pulled source has said nothing for STALL. */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stall = STALL;
  private stderr = "";
  /**
   * The last few seconds, for whoever joins next.
   *
   * A listener handed only what comes after they arrive starts exactly on the
   * live edge, with nothing buffered ahead: every hiccup in the source or the
   * network is a stall, and CNN in a browser was play, wait, play, wait, for
   * ever. A few seconds of recent fragments, written before the live bytes,
   * is the cushion every other live player has. For a picture the backlog
   * starts at a fragment boundary, because a fragment is the unit a decoder
   * can begin at; for MP3 any point will do, a frame announces itself.
   */
  private recent: Buffer[] = [];
  private recentBytes = 0;
  /**
   * Started for whoever asked and stopped when nobody is left. A catalog
   * channel is one of thousands; keeping every one that was ever clicked
   * running would be a decoder per click, for ever.
   */
  ephemeral = false;
  private idle: ReturnType<typeof setTimeout> | null = null;

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
    drain(child.stderr, (tail) => { this.stderr = tail; });
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
  pull(source: string, encode: string[], paced = true, stall = STALL): void {
    this.stall = stall;
    if (this.info.kind === "video") this.fragments = new Fragments();
    const [command, ...prefix] = this.options.ffmpeg as [string, ...string[]];
    const remote = /^https?:\/\//i.test(source);

    const dial = (): void => {
      if (this.closing) return;
      this.stderr = "";
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
          // A connection that stops answering is an error after this long,
          // and an error is a thing the reconnect above knows what to do
          // with. Without it a silent socket is waited on for ever. In
          // microseconds, as ffmpeg wants it.
          ...(remote ? ["-rw_timeout", String(stall * 1000)] : []),
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
      this.child = child;
      this.rearm(child);
      child.stdout?.on("data", (chunk: Buffer) => {
        // An ffmpeg that was replaced can still have a chunk in the pipe.
        if (this.child !== child) return;
        sent = true;
        this.info.bytes += chunk.byteLength;
        this.rearm(child);
        this.emit(chunk);
      });
      child.stdout?.on("error", () => undefined);
      drain(child.stderr, (tail) => { this.stderr = tail; });
      // Only the ffmpeg we are currently running gets to say the source
      // dropped. One that was killed to make way for a restart is not news.
      child.on("error", () => { if (this.child === child) this.dropped(sent); });
      child.on("close", () => { if (this.child === child) this.dropped(sent); });
    };

    this.redial = dial;
    dial();
    this.options.onStart?.(this.info);
  }

  /**
   * Start the source over, now.
   *
   * For a pulled channel only: a publisher's stream cannot be dialled again
   * from this end. The current ffmpeg is killed and a new one started at
   * once, with the count of failures cleared -- somebody asking for this has
   * decided the thing is worth another go, and should not inherit the four
   * strikes a dead CDN ran up an hour ago.
   */
  restart(): boolean {
    const dial = this.redial;
    if (!dial || this.closing) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.failures = 0;
    this.info.redials = (this.info.redials ?? 0) + 1;
    this.info.error = undefined;
    const old = this.child;
    this.child = null;
    old?.kill("SIGKILL");
    this.startOver();
    dial();
    return true;
  }

  /**
   * The stream that was is over; the next ffmpeg is a new one.
   *
   * New opening boxes, timestamps from zero again. Whoever was listening
   * cannot follow that mid-picture, and a newcomer must not be handed the old
   * opening boxes in front of the new fragments -- so the header is dropped
   * and the audience is ended, to come back to the stream as it now is. The
   * player rejoins on its own. Done the moment the source is known to be
   * gone, not when the redial happens: somebody joining in between gets the
   * new beginning as it is written, rather than a stale one first.
   */
  private startOver(): void {
    if (this.info.kind === "video") this.fragments = new Fragments();
    this.recent = [];
    this.recentBytes = 0;
    this.hangUp();
  }

  /** Expect output within STALL, or treat the source as gone and dial again. */
  private rearm(child: ChildProcess): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.child !== child || this.closing) return;
      this.info.error = `no data from the source for ${Math.round(this.stall / 1000)}s`;
      // Its close handler is what dials again.
      child.kill("SIGKILL");
    }, this.stall);
    this.watchdog.unref?.();
  }

  /** End everybody listening; the stream they were on is over. */
  private hangUp(): void {
    for (const listener of this.listeners) {
      try {
        listener.end();
      } catch {
        // Gone already.
      }
    }
    this.listeners.clear();
    this.info.listeners = 0;
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
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const said = lastLine(this.stderr);
    if (said) this.info.error = said;
    this.failures = sent ? 0 : this.failures + 1;
    if (this.failures >= GIVE_UP) {
      this.close();
      return;
    }
    this.info.redials = (this.info.redials ?? 0) + 1;
    this.startOver();
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
      this.remember(chunk, BACKLOG_AUDIO, false);
      this.send(chunk);
      return;
    }
    for (const box of this.fragments.push(chunk)) {
      if (!isOpening(boxType(box))) this.remember(box, BACKLOG_VIDEO, true);
      this.send(box);
    }
  }

  /** Keep this for the next arrival, and let the oldest go once it is too much. */
  private remember(piece: Buffer, cap: number, aligned: boolean): void {
    this.recent.push(piece);
    this.recentBytes += piece.byteLength;
    while (this.recent.length > 0 && this.recentBytes > cap) {
      const gone = this.recent.shift() as Buffer;
      this.recentBytes -= gone.byteLength;
    }
    // A picture's backlog must begin at a `moof`: an `mdat` on its own is
    // samples nobody has been told the layout of.
    if (aligned) {
      while (this.recent.length > 0 && boxType(this.recent[0] as Buffer) !== "moof") {
        const gone = this.recent.shift() as Buffer;
        this.recentBytes -= gone.byteLength;
      }
    }
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
    // Then the last few seconds, so there is something to play while the
    // live bytes catch up, rather than a picture that stalls on every hiccup.
    if (!this.fragments || this.fragments.ready) {
      for (const piece of this.recent) {
        try {
          listener.write(piece);
        } catch {
          break;
        }
      }
    }
    this.listeners.add(listener);
    this.info.listeners = this.listeners.size;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return () => {
      this.listeners.delete(listener);
      this.info.listeners = this.listeners.size;
      if (this.ephemeral && this.listeners.size === 0) this.idleOut();
    };
  }

  /** Stay up with nobody watching: no longer on demand. */
  keep(): void {
    this.ephemeral = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Nobody is watching an on-demand channel: give it a minute, then stop. */
  private idleOut(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.ephemeral && this.listeners.size === 0) this.close();
    }, this.options.idleMs ?? IDLE);
    this.idle.unref?.();
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.redial = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const said = lastLine(this.stderr);
    if (said && !this.info.error) this.info.error = said;
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
    stall = STALL,
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
    channel.pull(source, encode, paced, stall);
    return channel;
  }

  /**
   * Dial a pulled channel's source again, now. False for a channel that is
   * not there or is not ours to dial: a publisher's stream restarts at the
   * publisher's end.
   */
  restart(id: string): boolean {
    return this.open.get(id)?.restart() ?? false;
  }

  /** Whether a channel is one we fetch ourselves, and so can start over. */
  pulled(id: string): boolean {
    return this.open.get(id)?.info.via === "pull";
  }

  /** Mark a channel as on demand: it stops itself a minute after its last viewer leaves. */
  ephemeral(id: string): void {
    const channel = this.open.get(id);
    if (!channel) return;
    channel.ephemeral = true;
    if (channel.listeners.size === 0) channel.listen({ write: () => true, end: () => undefined })();
  }

  /**
   * The opposite: a channel that stays up with nobody watching.
   *
   * Going live with something from a catalog turns the on-demand channel it
   * was being watched on into a broadcast -- listed, shareable, and still
   * there when the person who started it closes their tab.
   */
  keep(id: string): boolean {
    const channel = this.open.get(id);
    if (!channel) return false;
    channel.keep();
    return true;
  }

  /** Whether a channel stops itself when its last viewer leaves. */
  isEphemeral(id: string): boolean {
    return this.open.get(id)?.ephemeral === true;
  }

  /** How many on-demand channels are up, for a ceiling on decoders. */
  get ephemeralCount(): number {
    let total = 0;
    for (const channel of this.open.values()) if (channel.ephemeral) total += 1;
    return total;
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

/**
 * The channels a server pulls itself, remembered across a restart.
 *
 * A server is restarted to pick up a new version, which is to say often, and
 * every restart used to take CNN off the air until somebody noticed and put
 * it back by hand. A publisher's stream cannot be remembered -- it restarts at
 * the publisher's end -- but a pulled one is a name and a URL, and a name and
 * a URL can be written down.
 *
 * Keyed by port, like the keys, because two servers on one machine are two
 * different line-ups.
 */
export interface RememberedChannel {
  id: string;
  name: string;
  source: string;
}

const REMEMBERED = "channels.json";

export function rememberedChannels(dir: string, port: number): RememberedChannel[] {
  try {
    const all = JSON.parse(readFileSync(join(dir, REMEMBERED), "utf8")) as Record<string, unknown>;
    const list = all[String(port)];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (one): one is RememberedChannel =>
        typeof one === "object" && one !== null &&
        typeof (one as RememberedChannel).id === "string" &&
        typeof (one as RememberedChannel).name === "string" &&
        typeof (one as RememberedChannel).source === "string",
    );
  } catch {
    return [];
  }
}

export function rememberChannels(dir: string, port: number, list: RememberedChannel[]): void {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(join(dir, REMEMBERED), "utf8")) as Record<string, unknown>;
  } catch {
    // First time, or unreadable: start again rather than refuse to remember.
  }
  all[String(port)] = list;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, REMEMBERED), JSON.stringify(all, null, 2));
  } catch {
    // A state directory that cannot be written costs a memory, not a stream.
  }
}

/** A channel id nobody chose, for a publisher that did not name one. */
export function generatedId(): string {
  return `s${randomBytes(3).toString("hex")}`;
}

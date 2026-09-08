/**
 * Streaming into a nixamp, rather than out of one.
 *
 * A phone or a laptop sends live audio to the server, and the server plays it,
 * serves it to listeners, and broadcasts it onward. Two ways in, because one is
 * not enough:
 *
 * - A single long POST whose body is the stream. ffmpeg, OBS, curl and the
 *   desktop app can all do this, and it is the efficient one.
 * - A sequence of small POSTs, for browsers. Chrome only allows a streaming
 *   request body over HTTP/2, and a nixamp on your own network is plain
 *   HTTP/1.1, so a phone that wants to broadcast has to send chunks.
 *
 * Both end up writing into the same ffmpeg stdin, which is what makes the two
 * paths interchangeable to everything downstream.
 *
 * And a third, which is the one anything native should use: RTMP. Point OBS,
 * Larix or another ffmpeg at rtmp://this-machine/live/<key> and it publishes,
 * with no nixamp-shaped client in the middle. ffmpeg listens for it (-rtmp_listen),
 * so this costs no dependency and no protocol implementation. The HTTP paths
 * above are not a workaround for that: they are what a *browser* has, since a
 * web page cannot speak RTMP at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

/** A live source is one session at a time: two would be two songs at once. */
export interface IngestSession {
  id: string;
  /** What the sender called itself. */
  name: string;
  /** The container the sender is producing, e.g. webm from MediaRecorder. */
  format: string;
  startedAt: number;
  bytes: number;
}

export interface IngestStatus {
  live: boolean;
  session: IngestSession | null;
  /** Where a native broadcaster should publish, when one is being listened for. */
  rtmp: { port: number; path: string } | null;
}

/** Containers a browser or a desktop encoder actually produces. */
const FORMATS = new Set(["webm", "ogg", "mp4", "matroska", "mp3", "wav", "flv"]);

/**
 * ffmpeg's `-f` is a demuxer name, and passing an unknown one is how a stream
 * dies four seconds in with a message nobody sees. An unrecognised container is
 * refused up front instead.
 */
export function normaliseFormat(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const format = value.trim().toLowerCase();
  if (format === "") return null;
  // A MediaRecorder mime type: audio/webm;codecs=opus.
  // The subtype may carry a hyphen: audio/x-matroska is what some browsers
  // hand out, and stopping at the hyphen turned it into "x".
  const fromMime = /^(?:audio|video)\/([a-z0-9-]+)/.exec(format)?.[1];
  const candidate = fromMime ?? format;
  const mapped = candidate === "x-matroska" ? "matroska" : candidate;
  return FORMATS.has(mapped) ? mapped : null;
}

export interface IngestOptions {
  ffmpeg: string[];
  /** Where the decoded audio should go: a file ffmpeg writes, or a pipe. */
  sink: string;
  /** Called when a session starts, so the player can switch to it. */
  onStart: (session: IngestSession) => void;
  /** Called when it ends, cleanly or otherwise. */
  onEnd: (session: IngestSession, error: string) => void;
  /** Encoded audio, as it arrives from a live publisher. */
  onAudio?: (chunk: Buffer) => void;
}

/**
 * The live input.
 *
 * One session at a time: a second sender is refused rather than mixed, because
 * mixing two uninvited streams is never what anybody meant.
 */
export class Ingest {
  private child: ChildProcess | null = null;
  private session: IngestSession | null = null;
  private closing = false;
  /** The RTMP listener, which outlives any one publisher. */
  private rtmpChild: ChildProcess | null = null;
  private rtmpPort: number | null = null;
  private rtmpKey = "";

  constructor(private readonly options: IngestOptions) {}

  status(): IngestStatus {
    return {
      live: this.session !== null,
      session: this.session,
      rtmp: this.rtmpPort === null ? null : { port: this.rtmpPort, path: `/live/${this.rtmpKey}` },
    };
  }

  get live(): boolean {
    return this.session !== null;
  }

  /**
   * Open a session. Returns the session, or null when one is already running:
   * the caller answers 409, because "somebody else is already broadcasting" is
   * a different problem from "your request was wrong".
   */
  open(name: string, format: string): IngestSession | null {
    if (this.session !== null) return null;

    const session: IngestSession = {
      id: randomBytes(8).toString("hex"),
      name: name || "a device",
      format,
      startedAt: Date.now(),
      bytes: 0,
    };

    const [command, ...prefix] = this.options.ffmpeg as [string, ...string[]];
    const child = spawn(
      command,
      [
        ...prefix,
        "-hide_banner",
        "-loglevel", "error",
        // The demuxer is stated because ffmpeg mis-probes a live, unseekable
        // pipe: it reads a few kilobytes, guesses, and guesses wrong.
        "-f", format,
        "-i", "pipe:0",
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-y",
        "-f", "mp3",
        this.options.sink,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });
    // A sender that hangs up mid-write breaks the pipe, and an unhandled EPIPE
    // takes the whole server down with it.
    child.stdin?.on("error", () => this.close(""));
    child.on("error", (error) => this.close(error.message));
    child.on("close", (code) => this.close(code === 0 ? "" : tail.trim().split("\n").pop() ?? ""));

    this.child = child;
    this.session = session;
    this.closing = false;
    this.options.onStart(session);
    return session;
  }

  /** Feed it. Returns false once the session is over. */
  write(chunk: Buffer): boolean {
    const child = this.child;
    const session = this.session;
    if (child === null || session === null || child.stdin === null) return false;
    session.bytes += chunk.byteLength;
    return child.stdin.write(chunk);
  }

  /** Pipe a whole request body in, for a sender that can stream one. */
  async pump(body: Readable): Promise<void> {
    for await (const chunk of body) {
      if (!this.write(chunk as Buffer)) {
        // Backpressure: wait for the drain rather than growing a buffer that
        // is really the network's problem.
        await new Promise((done) => this.child?.stdin?.once("drain", done) ?? done(null));
      }
      if (this.session === null) return;
    }
  }

  /**
   * Wait for an RTMP publisher, and keep waiting after each one leaves.
   *
   * ffmpeg is the RTMP server here: `-rtmp_listen 1` binds the port and blocks
   * until somebody publishes. It serves one publisher and exits, so the
   * listener is started again afterwards -- otherwise a broadcaster who
   * reconnects finds nothing listening.
   */
  listenRtmp(port: number, key: string): void {
    this.rtmpPort = port;
    this.rtmpKey = key;
    this.armRtmp();
  }

  /** Stop waiting for publishers. */
  stopRtmp(): void {
    this.rtmpPort = null;
    const listener = this.rtmpChild;
    this.rtmpChild = null;
    listener?.kill("SIGKILL");
  }

  private armRtmp(): void {
    const port = this.rtmpPort;
    if (port === null || this.rtmpChild !== null) return;

    const [command, ...prefix] = this.options.ffmpeg as [string, ...string[]];
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
        "-i", `rtmp://0.0.0.0:${port}/live/${this.rtmpKey}`,
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-y",
        "-f", "mp3",
        this.options.sink,
      ],
      // stdout is watched rather than ignored: the encoded bytes are the only
      // honest signal that a publisher turned up. ffmpeg does not announce a
      // connect, a healthy stream says nothing at -loglevel error, and
      // -progress only reports at the end in this build. Audio existing means
      // audio arrived.
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const session: IngestSession = {
      id: randomBytes(8).toString("hex"),
      name: "an RTMP publisher",
      format: "flv",
      startedAt: Date.now(),
      bytes: 0,
    };

    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.rtmpChild !== child) return;
      if (this.session === null) {
        this.session = session;
        this.options.onStart(session);
      }
      if (this.session === session) session.bytes += chunk.byteLength;
      // Consumed and dropped for now. The pipe has to be read either way --
      // an unread one fills and stalls the encoder -- and handing these bytes
      // to the listeners is the next piece of work, not a missing one here.
      this.options.onAudio?.(chunk);
    });

    child.on("error", () => {
      if (this.rtmpChild === child) this.rtmpChild = null;
    });

    child.on("close", () => {
      if (this.rtmpChild !== child) return;
      this.rtmpChild = null;
      if (this.session === session) {
        this.session = null;
        // A publisher disconnecting is how a broadcast ends, not an error.
        this.options.onEnd(session, "");
      }
      // Listen again for the next one.
      if (this.rtmpPort !== null) this.armRtmp();
    });

    this.rtmpChild = child;
  }

  /** End the session, whoever ended it. */
  close(error = ""): void {
    if (this.closing) return;
    this.closing = true;
    const session = this.session;
    const child = this.child;
    this.session = null;
    this.child = null;
    try {
      child?.stdin?.end();
    } catch {
      // Already broken, which is usually why we are here.
    }
    child?.kill("SIGKILL");
    if (session) this.options.onEnd(session, error);
  }
}

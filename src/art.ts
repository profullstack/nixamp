/**
 * A picture of a channel, for the places a picture goes: the card a link
 * unfurls into on a chat or a timeline, the lock screen while it plays,
 * the row in the directory.
 *
 * Three places one can come from, tried in this order by whoever asks.
 * The site's own, when a pasted link resolved to a thumbnail -- that is a
 * URL and costs nothing. The sleeve in the file, when a podcast's MP3
 * carries its cover as an attached picture; ffmpeg reads that one frame
 * out of the head of the file. And for anything with a picture, a frame
 * of the picture itself: the channel keeps the last few seconds of what
 * it is sending, and one frame of that is a screenshot of what is on --
 * taken from our own output, never by opening the source a second time,
 * because a panel that allows one connection per film counts that one
 * against the channel and drops it.
 *
 * Every picture comes back as a JPEG no wider than a card wants.
 */
import { spawn } from "node:child_process";

/** As wide as a preview card is drawn; anything bigger is bytes for nothing. */
export const ART_WIDTH = 960;
/** A picture bigger than this is not a thumbnail. */
export const ART_MAX_BYTES = 2 * 1024 * 1024;
/** How long ffmpeg gets to produce one frame before it is not going to. */
export const ART_TIMEOUT_MS = 20_000;
/** How long a frame of a live picture stays the frame: it changes, but not that fast. */
export const STILL_TTL_MS = 60_000;

/** The ffmpeg arguments that turn whatever is on `-i` into one JPEG on stdout. */
function oneFrame(input: string[], scale = true): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...input,
    "-map", "0:v:0",
    "-frames:v", "1",
    // No wider than the card, never upscaled, and an even height so the
    // encoder does not refuse an odd one.
    ...(scale ? ["-vf", `scale='min(${ART_WIDTH},iw)':-2`] : []),
    "-c:v", "mjpeg", "-q:v", "4",
    "-f", "image2", "pipe:1",
  ];
}

/**
 * Run ffmpeg for one picture: feed it `stdin` when there is something to
 * feed, read stdout until it ends, and answer the JPEG or null. Never
 * throws: a source with no picture, a decoder that cannot start, a frame
 * that takes too long, all answer null and the caller shows nothing.
 */
function picture(ffmpeg: string[], args: string[], stdin: Buffer[] | null): Promise<Buffer | null> {
  const [command, ...prefix] = ffmpeg;
  if (!command) return Promise.resolve(null);
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (answer: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(answer);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...prefix, ...args], { stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, ART_TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= ART_MAX_BYTES) chunks.push(chunk);
    });
    child.on("close", () => {
      const bytes = Buffer.concat(chunks);
      // A JPEG starts FF D8; anything else is ffmpeg having written nothing.
      finish(size > 0 && size <= ART_MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : null);
    });
    if (stdin && child.stdin) {
      const input = child.stdin;
      input.on("error", () => { /* ffmpeg stopped reading once it had its frame */ });
      for (const piece of stdin) input.write(piece);
      input.end();
    }
  });
}

/**
 * The sleeve in a file: the attached picture at the head of a podcast's
 * MP3 or M4A, read with the same input arguments the channel dials with
 * (a site's headers, say). ffmpeg stops after the one frame, so a file of
 * an hour costs the head of it. Null when there is none.
 */
export function coverArtOf(ffmpeg: string[], source: string, input: string[] = []): Promise<Buffer | null> {
  return picture(ffmpeg, oneFrame([...input, "-i", source]), null);
}

/**
 * One frame of what a channel is sending now, decoded from the opening
 * boxes and the recent backlog it hands every new listener. The bytes are
 * a fragmented MP4 that ffmpeg reads from a pipe as it would from a file.
 * Null while the channel has no backlog yet, or for a channel of sound.
 */
export function stillFrom(ffmpeg: string[], opening: Buffer[]): Promise<Buffer | null> {
  if (opening.length === 0 || opening.every((piece) => piece.byteLength === 0)) return Promise.resolve(null);
  return picture(ffmpeg, oneFrame(["-f", "mp4", "-i", "pipe:0"]), opening);
}

/**
 * The pictures already taken, so a card that is unfurled by five crawlers
 * at once costs one ffmpeg, and a sleeve is read from the file once. A
 * still of a live picture is kept for a minute and taken again; a sleeve
 * is kept for as long as the channel is on.
 */
export class ArtCache {
  private readonly kept = new Map<string, { at: number; forever: boolean; bytes: Buffer | null; pending?: Promise<Buffer | null> }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * The picture for a key, taking it with `take` when there is none fresh
   * enough. A picture that came back null is remembered as null for the
   * same while, so a channel with no picture is not asked every second.
   */
  async get(key: string, forever: boolean, take: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const have = this.kept.get(key);
    if (have) {
      if (have.pending) return have.pending;
      if (have.forever || this.now() - have.at < STILL_TTL_MS) return have.bytes;
    }
    const pending = take().then((bytes) => {
      this.kept.set(key, { at: this.now(), forever: forever && bytes !== null, bytes });
      return bytes;
    });
    this.kept.set(key, { at: this.now(), forever: false, bytes: null, pending });
    return pending;
  }

  /** A channel went off: its pictures with it. */
  forget(prefix: string): void {
    for (const key of this.kept.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) this.kept.delete(key);
    }
  }
}

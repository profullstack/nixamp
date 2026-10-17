import { spawn } from "node:child_process";
import { protocolArgs } from "./decoder-policy.ts";
import type { Readable } from "node:stream";
import { codecsOf } from "./audio.ts";

export interface PlaylistInput {
  ffmpeg: string[];
  ffprobe: string[];
  files: string[];
  at: number;
  position: number;
  video: boolean;
  width?: number;
  height?: number;
  /**
   * Back to the top when the end is reached, instead of finishing: a
   * station, which plays until somebody stops it.
   */
  repeat?: boolean;
  /**
   * The order to play a list of this length in, asked at the top of every
   * pass: a station-wide shuffle is one order for everybody listening, drawn
   * again each time round. Unset is the list's own order.
   */
  order?: (length: number) => number[];
  /** Read at every entry boundary, so an edit to the list lands on the next track. */
  current?: () => string[];
  /** Entries already known not to play, passed over without being tried. */
  excluded?: (file: string) => boolean;
  /**
   * Pass over an entry that will not play, instead of failing the stream.
   * For a station, where the next track is what a listener should hear. A
   * folder live leaves it unset: there a missing entry is usually a file
   * still arriving, and the channel redials and waits for it.
   */
  passOver?: boolean;
  /** Told when an entry is passed over because it would not play. */
  onFailure?: (event: { at: number; file: string; reason: string }) => void;
}

/**
 * How many entries in a row may fail before the list is given up on. A
 * corrupt file is skipped; a list where nothing plays is an error, said once,
 * not a loop.
 */
export const MAX_FAILURES_IN_A_ROW = 5;

/** Decode each file independently; feed one persistent muxer a fixed stream
 * profile and continuous timestamps. A concat demuxer cannot decode a list
 * whose input codecs differ. Only one entry is encoded at a time, with pipe
 * backpressure bounding read-ahead independently of the directory's size. */
export class PlaylistInputStream {
  private entries: { at: number; start: number; position: number }[] = [];
  error: Error | null = null;
  complete = false;
  constructor(private readonly options: PlaylistInput) {}

  /** Every entry that has started, in the order it started, with where it sits in the stream. */
  get history(): ReadonlyArray<{ at: number; start: number; position: number }> {
    return this.entries;
  }

  place(seconds: number): { at: number; position: number } {
    const entry = this.entries.findLast(one => seconds >= one.start) ?? this.entries[0];
    return entry ? { at: entry.at, position: Math.max(0, seconds - entry.start + entry.position) }
      : { at: this.options.at, position: this.options.position };
  }

  /** The decoder for the entry that is on, so skip() can end it early. */
  private stopCurrent: (() => void) | null = null;
  private skipping = false;

  /** End the entry that is on and go to the next. False when nothing is on. */
  skip(): boolean {
    if (!this.stopCurrent) return false;
    this.skipping = true;
    this.stopCurrent();
    return true;
  }

  async *open(signal: AbortSignal): AsyncGenerator<Buffer> {
    const o = this.options;
    const [command, ...prefix] = o.ffmpeg as [string, ...string[]];
    const ratio = Math.min(1, 1280 / (o.width || 1280), 720 / (o.height || 720));
    const width = Math.max(2, Math.floor((o.width || 1280) * ratio / 2) * 2);
    const height = Math.max(2, Math.floor((o.height || 720) * ratio / 2) * 2);
    let offset = 0;
    let failuresInARow = 0;
    let first = true;
    try {
      for (;;) {
        const files = o.current?.() ?? o.files;
        if (files.length === 0) throw new Error("The playlist is empty");
        const order = o.order ? o.order(files.length).filter((one) => one >= 0 && one < files.length) : files.map((_, index) => index);
        let played = 0;
        for (let step = first ? Math.min(o.at, order.length) : 0; step < order.length && !signal.aborted; step++) {
          const at = order[step]!;
          const file = files[at]!;
          if (o.excluded?.(file)) continue;
          const position = first && step === o.at ? o.position : 0;
          first = false;
          let reached = 0;
          try {
            const codecs = await codecsOf({ ffmpeg: o.ffmpeg, ffprobe: o.ffprobe, play: null }, file, [], AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
            if (signal.aborted) return;
            if (!codecs.audio && !codecs.video) throw new Error(`Cannot decode playlist entry ${at + 1}`);
            const duration = (codecs.duration ?? 0) - position;
            if (duration <= 0) throw new Error(`No playable duration for playlist entry ${at + 1}`);
            this.entries.push({ at, start: offset, position });
            const hasVideo = Boolean(codecs.video);
            const extra = o.video && !hasVideo
              ? ["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=30`]
              : o.video && !codecs.audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : [];
            const args = [
              ...prefix, "-hide_banner", "-loglevel", "error", "-nostdin", "-filter_threads", "2",
              // How far this entry got, so an entry cut short -- skipped, or
              // broken halfway -- moves the clock by what was played and the
              // next one starts where this one stopped, not after a gap.
              "-progress", "pipe:3", "-stats_period", "0.5",
              "-threads", "2", ...(position > 0 ? ["-ss", String(position)] : []), ...protocolArgs(file), "-i", file,
              ...extra, "-t", String(duration),
              ...(o.video ? [
                "-map", hasVideo ? "0:v:0" : "1:v:0", "-map", codecs.audio ? "0:a:0" : "1:a:0",
                "-vf", `fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS`,
                "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency",
                "-crf", "23", "-pix_fmt", "yuv420p", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
              ] : ["-map", "0:a:0", "-vn"]),
              "-af", "aresample=48000,asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
              "-mpegts_flags", "+initial_discontinuity", "-output_ts_offset", String(offset), "-mpegts_copyts", "1", "-muxdelay", "0", "-muxpreload", "0",
              "-f", "mpegts", "pipe:1",
            ];
            const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
            let tail = "";
            child.stderr!.on("data", chunk => { tail = (tail + chunk.toString()).slice(-1500); });
            (child.stdio[3] as Readable | null)?.on("data", (chunk: Buffer) => {
              const found = /out_time_us=(\d+)/g;
              let match: RegExpExecArray | null;
              while ((match = found.exec(chunk.toString())) !== null) reached = Math.max(reached, Number(match[1]) / 1e6);
            });
            const closed = new Promise<number | null>((resolve) => {
              child.once("error", error => { tail = error.message; resolve(-1); });
              child.once("close", code => resolve(code));
            });
            const abort = (): void => { child.kill("SIGKILL"); };
            signal.addEventListener("abort", abort, { once: true });
            this.stopCurrent = abort;
            let skipped = false;
            try {
              for await (const chunk of child.stdout as Readable) {
                if (signal.aborted) return;
                yield chunk as Buffer;
              }
              const code = await closed;
              if (signal.aborted) return;
              skipped = this.skipping;
              if (code !== 0 && !skipped) throw new Error(`Playlist entry ${at + 1} failed: ${tail.trim()}`);
            } finally {
              this.stopCurrent = null;
              this.skipping = false;
              signal.removeEventListener("abort", abort);
              abort();
              await closed;
            }
            failuresInARow = 0;
            played += 1;
            // Match the frame grid used above so rounding cannot accumulate a
            // backwards timestamp over hundreds of short files.
            const length = skipped ? Math.min(duration, reached) : duration;
            offset += o.video ? Math.ceil(length * 30) / 30 : length;
          } catch (error) {
            if (signal.aborted || !o.passOver) throw error;
            // Passed over, not dialled again: the next entry is what a
            // listener should hear, and a file that will not decode now will
            // not decode in two seconds either.
            const reason = error instanceof Error ? error.message : String(error);
            o.onFailure?.({ at, file, reason });
            if (reached > 0) offset += o.video ? Math.ceil(reached * 30) / 30 : reached;
            failuresInARow += 1;
            if (failuresInARow >= Math.min(MAX_FAILURES_IN_A_ROW, Math.max(1, files.length))) {
              throw new Error(`Nothing in this playlist would play: ${reason}`);
            }
          }
        }
        if (signal.aborted || !o.repeat) break;
        // A pass where everything was passed over is a list with nothing to
        // play, and repeating it would be the loop this exists to avoid.
        if (played === 0) throw new Error("Nothing in this playlist would play");
      }
      this.complete = !signal.aborted;
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      throw this.error;
    }
  }
}

import { spawn } from "node:child_process";
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
}

/** Decode each file independently; feed one persistent muxer a fixed stream
 * profile and continuous timestamps. A concat demuxer cannot decode a list
 * whose input codecs differ. Only one entry is encoded at a time, with pipe
 * backpressure bounding read-ahead independently of the directory's size. */
export class PlaylistInputStream {
  private entries: { at: number; start: number; position: number }[] = [];
  error: Error | null = null;
  complete = false;
  constructor(private readonly options: PlaylistInput) {}

  place(seconds: number): { at: number; position: number } {
    const entry = this.entries.findLast(one => seconds >= one.start) ?? this.entries[0];
    return entry ? { at: entry.at, position: Math.max(0, seconds - entry.start + entry.position) }
      : { at: this.options.at, position: this.options.position };
  }

  async *open(signal: AbortSignal): AsyncGenerator<Buffer> {
    const o = this.options;
    const [command, ...prefix] = o.ffmpeg as [string, ...string[]];
    const ratio = Math.min(1, 1280 / (o.width || 1280), 720 / (o.height || 720));
    const width = Math.max(2, Math.floor((o.width || 1280) * ratio / 2) * 2);
    const height = Math.max(2, Math.floor((o.height || 720) * ratio / 2) * 2);
    let offset = 0;
    try {
      for (let at = o.at; at < o.files.length && !signal.aborted; at++) {
        const file = o.files[at]!;
        const codecs = await codecsOf({ ffmpeg: o.ffmpeg, ffprobe: o.ffprobe, play: null }, file, [], AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        if (signal.aborted) return;
        if (!codecs.audio && !codecs.video) throw new Error(`Cannot decode playlist entry ${at + 1}`);
        const position = at === o.at ? o.position : 0;
        const duration = (codecs.duration ?? 0) - position;
        if (duration <= 0) throw new Error(`No playable duration for playlist entry ${at + 1}`);
        this.entries.push({ at, start: offset, position });
        const hasVideo = Boolean(codecs.video);
        const extra = o.video && !hasVideo
          ? ["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=30`]
          : o.video && !codecs.audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : [];
        const args = [
          ...prefix, "-hide_banner", "-loglevel", "error", "-nostdin", "-filter_threads", "2",
          "-threads", "2", ...(position > 0 ? ["-ss", String(position)] : []), "-i", file,
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
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let tail = "";
        child.stderr.on("data", chunk => { tail = (tail + chunk.toString()).slice(-1500); });
        const closed = new Promise<number | null>((resolve) => {
          child.once("error", error => { tail = error.message; resolve(-1); });
          child.once("close", code => resolve(code));
        });
        const abort = (): void => { child.kill("SIGKILL"); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          for await (const chunk of child.stdout as Readable) {
            if (signal.aborted) return;
            yield chunk as Buffer;
          }
          const code = await closed;
          if (signal.aborted) return;
          if (code !== 0) throw new Error(`Playlist entry ${at + 1} failed: ${tail.trim()}`);
        } finally {
          signal.removeEventListener("abort", abort);
          abort();
          await closed;
        }
        // Match the frame grid used above so rounding cannot accumulate a
        // backwards timestamp over hundreds of short files.
        offset += o.video ? Math.ceil(duration * 30) / 30 : duration;
      }
      this.complete = !signal.aborted;
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      throw this.error;
    }
  }
}

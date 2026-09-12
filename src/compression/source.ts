/**
 * Reading a source ourselves, so its bytes exist here to be relayed.
 *
 * ffmpeg normally dials a channel's source and the original bytes never
 * pass through this process. For a source-boundary relay they have to.
 * This is the narrow set of sources that can be read here and piped to
 * ffmpeg without changing how they play: a transport stream from a plain
 * http(s) URL or a file, from its beginning, with no special request
 * headers and no separate sound file. Anything else is left to ffmpeg,
 * and a relay that asks for its source boundary is told why not.
 *
 * The second half is the receiving end of a source-boundary relay: the
 * decoded original bytes, made into a source ffmpeg can be handed the
 * same way, so a relayed transport stream plays here exactly as the
 * original would have, and can be relayed on again.
 */
import { createReadStream, statSync } from "node:fs";
import type { ChannelInfo, PullThrough } from "../channels.ts";
import { receiveRelay } from "./receiver.ts";

/**
 * ffmpeg input flags that carry per-request authentication a plain fetch
 * would not send: a user agent, a referer, cookies, arbitrary headers. A
 * source that needs any of these is ffmpeg's to dial. Transport demux
 * tuning (`-probesize`, `-analyzeduration`, `-fflags`) is not on this list:
 * it applies to a piped read too and is no reason to refuse the tee.
 */
const HEADER_FLAGS = new Set(["-headers", "-user_agent", "-user-agent", "-referer", "-cookies", "-icy", "-http_proxy", "-http_persistent"]);

/** The reason a source cannot be read here, or null when it can. */
export function unreadable(info: ChannelInfo, from: number, input: string[], audio: string): string | null {
  const source = info.source ?? "";
  if (info.via !== "pull" || source === "") return "only a source this server pulls can be read here";
  const container = info.codecs?.container ?? "";
  if (!container.split(",").includes("mpegts")) return `the source is ${container || "of unknown container"}, not a transport stream`;
  if (input.some((arg) => HEADER_FLAGS.has(arg))) return "the source needs request headers ffmpeg sends and nixamp does not";
  if (audio !== "") return "the source keeps its sound in a second file";
  if (from > 0) return "a film picked up mid-way cannot be read from its start";
  if (/^https?:\/\//i.test(source)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return "only http(s) URLs and files can be read here";
  try {
    if (!statSync(source).isFile()) return "the source is not a file";
  } catch {
    return "the source file cannot be read";
  }
  return null;
}

/** Open a plain URL or a file as a stream of bytes, pulled shut by the signal. */
export async function openSource(source: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal, redirect: "follow", headers: { "user-agent": "nixamp" } });
    if (!response.ok || !response.body) throw new Error(`the source answered ${response.status}`);
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }
  const stream = createReadStream(source, { highWaterMark: 256 * 1024 });
  signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return stream;
}

/** A transport-stream source read by us, for `Channels.setThrough`. */
export function sourceThrough(source: string): PullThrough {
  return { format: "mpegts", open: (signal) => openSource(source, signal) };
}

/** How many decoded bytes may wait for ffmpeg before the relay is asked to pause. */
const RELAY_QUEUE = 8 * 1024 * 1024;

/**
 * A relay's decoded bytes as an async iterable, at the pace ffmpeg takes
 * them. The decoder is asked to wait when too much is queued, which holds
 * the socket read, which is backpressure all the way to the sender's
 * per-listener queue. A clean end ends the iterable; a broken stream
 * throws, and the channel's own redial dials again.
 */
export async function* relayBytes(url: string, key: string | null, signal: AbortSignal): AsyncGenerator<Buffer> {
  const queue: Buffer[] = [];
  let queued = 0;
  let wake: (() => void) | null = null;
  let room: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  void receiveRelay({
    url,
    key,
    signal,
    onBytes: async (bytes) => {
      queue.push(bytes);
      queued += bytes.length;
      wake?.();
      wake = null;
      if (queued > RELAY_QUEUE) await new Promise<void>((resume) => { room = resume; });
    },
  }).then(
    () => {
      done = true;
      wake?.();
    },
    (error: Error) => {
      failure = error;
      done = true;
      wake?.();
    },
  );
  for (;;) {
    const next = queue.shift();
    if (next) {
      queued -= next.length;
      // Captured into a local: `room` is only ever assigned inside a callback,
      // which the compiler cannot see, so it would narrow the field to null.
      const resume = room as (() => void) | null;
      if (resume && queued <= RELAY_QUEUE / 2) {
        resume();
        room = null;
      }
      yield next;
      continue;
    }
    if (done) {
      if (failure) throw failure;
      return;
    }
    await new Promise<void>((resume) => { wake = resume; });
  }
}

/** A source-boundary relay from another nixamp, as a source ffmpeg reads through us. */
export function relayThrough(url: string, key: string | null): PullThrough {
  return { format: "mpegts", open: async (signal) => relayBytes(url, key, signal) };
}

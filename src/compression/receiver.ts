/**
 * The receiving end of a relay, as a client: ask another nixamp for a
 * channel in the envelope, decode it, hand the original bytes on.
 *
 * The negotiation is two headers. `Accept` names the envelope's media type,
 * which is how the server knows this is a receiver and not a browser that
 * followed a link; `X-Nixamp-Stream-Codecs` lists what this decoder can
 * undo, and the server compresses with nothing outside that list. A server
 * that will not or cannot relay answers with JSON and an ordinary status,
 * which is surfaced as an error naming the reason, never as a stream of
 * something else.
 */
import { MEDIA_TYPE, type Mode, RelayError, type StreamHeader } from "./envelope.ts";
import { RelayDecoder } from "./relay.ts";

export const CODECS_HEADER = "x-nixamp-stream-codecs";
export const KIND_HEADER = "x-nixamp-kind";
export const KEY_HEADER = "x-nixamp-key";

export interface ReceiveOptions {
  url: string;
  key: string | null;
  /** What this receiver can decode. Stored is always implied. */
  modes?: Mode[];
  maxFrameBytes?: number;
  /** The server said yes: what it will compress with, and what the channel carries. Before any byte. */
  onStart?: (accepted: { codecs: string; kind: "audio" | "video" | "" }) => void;
  /** The stream header arrived: the generation this is. */
  onHeader?: (header: StreamHeader) => void;
  onBytes: (bytes: Buffer) => void | Promise<void>;
  signal?: AbortSignal;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}

export interface ReceiveResult {
  generation: number;
  frames: number;
  bytes: number;
}

/** The server said no. `status` is what it said it with. */
export class RelayRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RelayRefused";
  }
}

/**
 * Pull one generation of a relay to its clean end. Resolves when the end
 * frame arrives; rejects with a RelayError for a stream that broke a rule
 * or stopped short, and with RelayRefused for a server that would not
 * start one.
 */
export async function receiveRelay(options: ReceiveOptions): Promise<ReceiveResult> {
  const modes = new Set<Mode>(["stored", ...(options.modes ?? ["zstd", "ts-zstd"])]);
  const headers: Record<string, string> = {
    accept: MEDIA_TYPE,
    [CODECS_HEADER]: [...modes].join(","),
  };
  if (options.key) headers[KEY_HEADER] = options.key;
  const send = options.fetchImpl ?? fetch;
  const response = await send(options.url, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  const type = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !type.startsWith(MEDIA_TYPE)) {
    let reason = `${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") reason = body.error;
    } catch {
      // Not JSON; the status is the message.
    }
    throw new RelayRefused(response.status, reason);
  }
  if (!response.body) throw new RelayRefused(response.status, "no body");
  const kindSaid = response.headers.get(KIND_HEADER);
  options.onStart?.({
    codecs: response.headers.get(CODECS_HEADER) ?? "",
    kind: kindSaid === "audio" || kindSaid === "video" ? kindSaid : "",
  });
  const decoder = new RelayDecoder({
    modes,
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    onBytes: options.onBytes,
  });
  let told = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await decoder.feed(Buffer.from(value));
      if (!told && decoder.header) {
        told = true;
        options.onHeader?.(decoder.header);
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new RelayError("TRUNCATED", "cancelled");
    throw error;
  } finally {
    reader.releaseLock();
  }
  await decoder.end();
  return { generation: decoder.header?.generation ?? 0, frames: decoder.frames, bytes: decoder.bytes };
}

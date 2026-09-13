/**
 * `nixamp transcribe` -- a recording in, the words out, and into a room.
 *
 * The ear is nixamp.com's (see speech.ts): this machine sends a WAV and
 * gets text back, signed in as whoever it is signed in as. Anything that
 * is not already a WAV goes through the ffmpeg nixamp plays with, to 16 kHz
 * mono, which is what the ear listens at and the smallest thing to send.
 *
 * With `--say SERVER`, the words are posted to that server's trollbox as
 * this account, by the same rules as typing them: one line a second, and
 * signed with the public handle. The MCP tool of the same name is this
 * function with a different front.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectTools, type Tools } from "./audio.ts";
import { readSession, type Session } from "./session.ts";
import { RATE, isWav } from "./speech.ts";

const HELP = `nixamp transcribe — say it, and have it written down.

  nixamp transcribe FILE                  the words in a recording
  nixamp transcribe FILE --say SERVER     and post them to that server's trollbox
  nixamp transcribe FILE --say SERVER --channel ID   to one channel's room (default: live)
  nixamp transcribe FILE --language de    when Whisper should not guess
  nixamp transcribe FILE --json           the answer as JSON

FILE is any recording ffmpeg can read; a WAV needs no ffmpeg at all. The
hearing is done by nixamp.com with an open-source model on its own CPU, so
this needs a sign-in (\`nixamp login\`) and nothing else. Up to a minute at
a time.

SERVER is the address of the nixamp whose room it is, as in its share link:
https://server1.chovy.nixamp.com:4321. The room is that server's own stream
unless --channel names one of its channels.
`;

/** Where the sound may be sent, as a request. */
export interface Ask {
  wav: Uint8Array;
  language?: string;
  /** A room to post the words to: the server's address, and its channel. */
  server?: string;
  channel?: string;
}

export interface Heard {
  text: string;
  seconds: number;
  model?: string;
  /** The trollbox line, when a room was named. */
  message?: { id: string; handle: string; body: string; createdAt: string };
}

export type Answer = { ok: true; heard: Heard } | { ok: false; status: number; error: string };

/**
 * The file as a WAV: as it is when it already is one, through ffmpeg to
 * 16 kHz mono otherwise. Throws a sentence when neither is possible.
 */
export function wavOf(path: string, tools: () => Pick<Tools, "ffmpeg" | "carries"> = detectTools): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  if (isWav(bytes)) return bytes;
  const found = tools();
  if (found.carries === false) throw new Error(`${path} is not a WAV, and there is no ffmpeg here to convert it. Install ffmpeg, or record a WAV.`);
  const [command, ...prefix] = found.ffmpeg;
  const run = spawnSync(command as string, [...prefix, "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "wav", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0 || !run.stdout || run.stdout.length < 44) {
    const why = run.stderr ? run.stderr.toString("utf8").trim().split("\n").pop() : run.error?.message;
    throw new Error(`ffmpeg could not read ${path}${why ? `: ${why}` : ""}`);
  }
  return new Uint8Array(run.stdout);
}

/** The ask, made: one POST to the site the session belongs to. */
export async function askToHear(session: Pick<Session, "site" | "token">, ask: Ask, fetcher: typeof fetch = fetch, site = session.site): Promise<Answer> {
  const url = new URL(`${site.replace(/\/+$/, "")}/api/v1/speech/transcribe`);
  if (ask.language) url.searchParams.set("language", ask.language);
  if (ask.server) {
    url.searchParams.set("server", ask.server);
    url.searchParams.set("channel", ask.channel || "live");
  }
  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "audio/wav" },
      body: new Blob([ask.wav.buffer.slice(ask.wav.byteOffset, ask.wav.byteOffset + ask.wav.byteLength) as ArrayBuffer]),
    });
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach ${url.origin}: ${(error as Error).message}` };
  }
  const body = (await response.json().catch(() => ({}))) as Partial<Heard> & { error?: string };
  if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `nixamp answered ${response.status}` };
  return {
    ok: true,
    heard: {
      text: body.text ?? "",
      seconds: body.seconds ?? 0,
      ...(body.model ? { model: body.model } : {}),
      ...(body.message ? { message: body.message } : {}),
    },
  };
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export interface TranscribeDeps {
  fetcher?: typeof fetch;
  wavOf?: typeof wavOf;
  session?: Pick<Session, "site" | "token"> | null;
}

export async function transcribe(argv: string[], deps: TranscribeDeps = {}): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(HELP);
    return argv.length === 0 ? 64 : 0;
  }
  const session = deps.session === undefined ? readSession() : deps.session;
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const withValue = new Set(["--say", "--channel", "--language", "--site"]);
  const file = argv.find((one, at) => !one.startsWith("-") && !(at > 0 && withValue.has(argv[at - 1] as string)));
  if (!file) {
    console.error("nixamp: which recording? `nixamp transcribe clip.m4a`.");
    return 64;
  }
  const server = flag(argv, "--say");
  if (argv.includes("--say") && !server) {
    console.error("nixamp: --say needs the server's address, as in its share link.");
    return 64;
  }
  let wav: Uint8Array;
  try {
    wav = (deps.wavOf ?? wavOf)(file);
  } catch (error) {
    console.error(`nixamp: ${(error as Error).message}`);
    return 1;
  }
  const ask: Ask = {
    wav,
    ...(flag(argv, "--language") ? { language: flag(argv, "--language") } : {}),
    ...(server ? { server, channel: flag(argv, "--channel") ?? "live" } : {}),
  };
  const answer = await askToHear(session, ask, deps.fetcher ?? fetch, flag(argv, "--site") ?? session.site);
  if (!answer.ok) {
    console.error(`nixamp: ${answer.error}`);
    return 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(answer.heard, null, 2));
    return 0;
  }
  if (answer.heard.text === "") {
    console.error("nixamp: heard nothing in that.");
    return 1;
  }
  console.log(answer.heard.text);
  if (answer.heard.message) {
    console.error(`  Said in the room for ${ask.channel} at ${server} as ${answer.heard.message.handle}.`);
  } else if (server) {
    console.error("  Nothing was posted: there were no words to post.");
  }
  return 0;
}

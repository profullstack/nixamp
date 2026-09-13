/**
 * `nixamp transcribe` -- a recording in, the words out, kept, and into a room.
 *
 * The ear is nixamp.com's (see speech.ts): this machine sends WAVs and gets
 * text back, signed in as whoever it is signed in as. Anything that is not
 * already a WAV goes through the ffmpeg nixamp plays with, to 16 kHz mono,
 * which is what the ear listens at and the smallest thing to send.
 *
 * A short clip is one ask. A whole film is the same ask a hundred times, a
 * minute of sound each, with the pieces' timing asked for, and what comes
 * back is kept on nixamp.com under the file's fingerprint (see
 * transcripts.ts): the next `nixamp transcribe` of the same file, on any
 * machine, and the next server to put it on the air, read the lines
 * instead of hearing them. Ask for another language and nixamp.com
 * translates the kept lines once, and keeps that too.
 *
 * With `--say SERVER`, the words are posted to that server's trollbox as
 * this account, by the same rules as typing them: one line a second, and
 * signed with the public handle. The MCP tool of the same name is this
 * function with a different front.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { detectTools, type Tools } from "./audio.ts";
import { isQuiet } from "./captions.ts";
import { Enricher } from "./enrich.ts";
import { describeFile, keepFile } from "./media-local.ts";
import { readSession, type Session } from "./session.ts";
import { MAX_SECONDS, RATE, isWav, type Segment } from "./speech.ts";
import { fetchTranscript, keepLines, type Got, type StoredTranscript } from "./transcript-client.ts";
import { fileFingerprint, languageCode, mediaOfUrl, stamp, toSrt, toText, toVtt, transcriptIdOf, type TranscriptLine } from "./transcripts.ts";

const HELP = `nixamp transcribe — say it, and have it written down.

  nixamp transcribe FILE                  the words in a recording, or a whole film, kept on nixamp.com
  nixamp transcribe URL                   the same for a link ffmpeg can read
  nixamp transcribe FILE --language sv    when Whisper should not guess
  nixamp transcribe FILE --translate de   and in German too (de,sv for both)
  nixamp transcribe FILE --srt | --vtt    as subtitles, on stdout
  nixamp transcribe FILE --out DIR        subtitle files in DIR, one per language
  nixamp transcribe FILE --fresh          hear it again even though it is kept
  nixamp transcribe FILE --json           the answer as JSON
  nixamp transcribe CLIP --say SERVER     a short clip, posted to that server's trollbox
  nixamp transcribe CLIP --say SERVER --channel ID   to one channel's room (default: live)

FILE is any recording ffmpeg can read; a WAV under a minute needs no ffmpeg
at all. The hearing is done by nixamp.com with an open-source model on its
own CPU, so this needs a sign-in (\`nixamp login\`) and nothing else. A film
is heard a minute at a time and kept as it goes; the next ask for the same
file, from anywhere, reads what was kept.

SERVER is the address of the nixamp whose room it is, as in its share link:
https://server1.chovy.nixamp.com:4321. The room is that server's own stream
unless --channel names one of its channels.
`;

/** Where the sound may be sent, as a request. */
export interface Ask {
  wav: Uint8Array;
  language?: string;
  /** The pieces with their timing too. */
  timestamps?: boolean;
  /** A room to post the words to: the server's address, and its channel. */
  server?: string;
  channel?: string;
}

export interface Heard {
  text: string;
  seconds: number;
  model?: string;
  language?: string;
  segments?: Segment[];
  /** The trollbox line, when a room was named. */
  message?: { id: string; handle: string; body: string; createdAt: string };
}

export type Answer = { ok: true; heard: Heard } | { ok: false; status: number; error: string };

/** A minute of sound at a time: the most the ear takes in one ask. */
export const WINDOW_SECONDS = MAX_SECONDS;
/** Heard lines go to the store this often, so a run that dies keeps most of what it heard. */
export const KEEP_EVERY = 20;

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

/** A window of sound: where it begins in the media, and 16-bit mono PCM at RATE. */
export interface Window {
  offset: number;
  pcm: Buffer;
}

/**
 * The whole of a file or a link as windows of PCM, through ffmpeg, as it
 * decodes: a film is hours of sound and is never held at once.
 */
export async function* windowsOf(
  source: string,
  tools: () => Pick<Tools, "ffmpeg" | "carries"> = detectTools,
  seconds = WINDOW_SECONDS,
): AsyncGenerator<Window> {
  const found = tools();
  if (found.carries === false) throw new Error(`there is no ffmpeg here to read ${source}. Install ffmpeg.`);
  const [command, ...prefix] = found.ffmpeg;
  const child = spawn(command as string, [...prefix, "-v", "error", "-nostats", "-i", source, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "pipe:1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let complaint = "";
  child.stderr.on("data", (chunk: Buffer) => {
    complaint = `${complaint}${chunk.toString("utf8")}`.slice(-2000);
  });
  const size = seconds * RATE * 2;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let offset = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes >= size) {
      const all = Buffer.concat(pending);
      yield { offset, pcm: Buffer.from(all.subarray(0, size)) };
      offset += seconds;
      const rest = all.subarray(size);
      pending = rest.length > 0 ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  }
  // The tail: anything longer than half a second is worth hearing.
  if (pendingBytes >= RATE) yield { offset, pcm: Buffer.concat(pending) };
  const status = await new Promise<number | null>((done) => {
    if (child.exitCode !== null) done(child.exitCode);
    else child.on("close", (code) => done(code));
  });
  if (status !== 0 && offset === 0 && pendingBytes < RATE) {
    throw new Error(`ffmpeg could not read ${source}${complaint ? `: ${complaint.trim().split("\n").pop()}` : ""}`);
  }
}

/** The ask, made: one POST to the site the session belongs to. */
export async function askToHear(session: Pick<Session, "site" | "token">, ask: Ask, fetcher: typeof fetch = fetch, site = session.site): Promise<Answer> {
  const url = new URL(`${site.replace(/\/+$/, "")}/api/v1/speech/transcribe`);
  if (ask.language) url.searchParams.set("language", ask.language);
  if (ask.timestamps) url.searchParams.set("timestamps", "1");
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
      ...(body.language ? { language: body.language } : {}),
      ...(body.segments ? { segments: body.segments } : {}),
      ...(body.message ? { message: body.message } : {}),
    },
  };
}

/** A WAV around 16-bit mono PCM at RATE, for one window. */
function wavOfPcm(pcm: Buffer): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

export interface WholeHeard {
  lines: TranscriptLine[];
  language: string;
  model: string;
  /** How far the sound went, seconds. */
  seconds: number;
}

export interface WholeDeps {
  fetcher?: typeof fetch;
  windows?: (source: string) => AsyncIterable<Window>;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (line: string) => void;
}

/** m:ss, or h:mm:ss, for a progress line. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The whole of some media, heard a window at a time and kept as it goes.
 * The ear's throttle is so many seconds of sound a minute; a 429 is a
 * wait, not a failure. Quiet windows are skipped without an ask.
 */
export async function hearWhole(
  session: Pick<Session, "site" | "token">,
  source: string,
  media: string,
  options: { language?: string; title?: string } = {},
  deps: WholeDeps = {},
): Promise<{ ok: true; heard: WholeHeard } | { ok: false; error: string }> {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const windows = deps.windows ?? ((path: string) => windowsOf(path));
  const id = transcriptIdOf(media);
  const lines: TranscriptLine[] = [];
  let unsaved: TranscriptLine[] = [];
  let language = options.language ?? "";
  let model = "";
  let seconds = 0;
  let sinceKept = 0;
  const keep = async (complete: boolean): Promise<string | null> => {
    const batch = complete ? lines : unsaved;
    if (batch.length === 0 && !complete) return null;
    const got = await keepLines(session, id, {
      media, language, ...(model ? { model } : {}), ...(options.title ? { title: options.title } : {}), lines: batch, ...(complete ? { complete: true } : {}),
    }, fetcher);
    unsaved = [];
    sinceKept = 0;
    return got.ok ? null : got.error;
  };
  try {
    for await (const window of windows(source)) {
      seconds = window.offset + window.pcm.length / (RATE * 2);
      if (isQuiet(window.pcm)) continue;
      const wav = wavOfPcm(window.pcm);
      let answer: Answer = { ok: false, status: 0, error: "not asked" };
      for (let attempt = 0; attempt < 40; attempt++) {
        answer = await askToHear(session, { wav, timestamps: true, ...(language ? { language } : {}) }, fetcher);
        if (answer.ok || answer.status !== 429) break;
        deps.onProgress?.(`  ${clock(window.offset)}: the ear is busy; waiting`);
        await sleep(10_000);
      }
      if (!answer.ok) return { ok: false, error: `at ${clock(window.offset)}: ${answer.error}` };
      if (answer.heard.language && language === "") language = answer.heard.language;
      if (answer.heard.model) model = answer.heard.model;
      const pieces = answer.heard.segments && answer.heard.segments.length > 0
        ? answer.heard.segments
        : answer.heard.text ? [{ start: 0, end: window.pcm.length / (RATE * 2), text: answer.heard.text }] : [];
      for (const piece of pieces) {
        const line = { start: round(window.offset + piece.start), end: round(window.offset + piece.end), text: piece.text };
        lines.push(line);
        unsaved.push(line);
      }
      deps.onProgress?.(`  ${clock(seconds)} heard${language ? ` (${language})` : ""}: ${lines.length} lines`);
      sinceKept += 1;
      if (sinceKept >= KEEP_EVERY) {
        const failed = await keep(false);
        if (failed) deps.onProgress?.(`  the store did not keep the lines so far: ${failed}`);
      }
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const failed = await keep(true);
  if (failed) return { ok: false, error: `heard it all, but nixamp.com would not keep it: ${failed}` };
  return { ok: true, heard: { lines, language, model, seconds } };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** A kept transcript in a language, waiting while nixamp.com translates it. */
export async function awaitTranscript(
  session: Pick<Session, "site" | "token">,
  id: string,
  language: string,
  deps: { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; onProgress?: (line: string) => void; polls?: number } = {},
): Promise<Got<StoredTranscript>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = -1;
  for (let poll = 0; ; poll++) {
    const got = await fetchTranscript(session, id, language, deps.fetcher ?? fetch);
    if (!got.ok || !got.body.translating) return got;
    const { done, total } = got.body.translating;
    if (done !== last) deps.onProgress?.(`  translating to ${language}: ${done} of ${total} lines`);
    last = done;
    if (deps.polls !== undefined && poll + 1 >= deps.polls) return got;
    await sleep(3000);
  }
}

/** A line as the terminal prints it: seconds into the media, then the words. */
export function printedLine(line: TranscriptLine): string {
  return `${clock(line.start).padStart(7)}  ${line.text}`;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export interface TranscribeDeps {
  fetcher?: typeof fetch;
  wavOf?: typeof wavOf;
  session?: Pick<Session, "site" | "token"> | null;
  /** The whole of a file as windows; the tests hand in a fake. */
  windows?: (source: string) => AsyncIterable<Window>;
  /** A file's identity; the tests hand in a fake. */
  fingerprint?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  /** How many times a translation is asked about before giving up; forever, except in the tests. */
  polls?: number;
}

/** A transcript's lines as one of the formats, for stdout or a file. */
export function rendered(lines: TranscriptLine[], format: "srt" | "vtt" | "txt" | "lines"): string {
  if (format === "srt") return toSrt(lines);
  if (format === "vtt") return toVtt(lines);
  if (format === "txt") return toText(lines);
  return lines.map(printedLine).join("\n");
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
  const withValue = new Set(["--say", "--channel", "--language", "--site", "--translate", "--out"]);
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
  const language = languageCode(flag(argv, "--language")) || undefined;
  if (argv.includes("--language") && !language) {
    console.error("nixamp: --language is a two-letter code, such as sv.");
    return 64;
  }
  const site = flag(argv, "--site") ?? session.site;
  const signed = { site, token: session.token };
  const fetcher = deps.fetcher ?? fetch;
  const asJson = argv.includes("--json");
  const format: "srt" | "vtt" | "txt" | "lines" = argv.includes("--srt") ? "srt" : argv.includes("--vtt") ? "vtt" : argv.includes("--txt") ? "txt" : "lines";

  // A clip for a room: one ask, the words into the trollbox, as before.
  if (server) {
    let wav: Uint8Array;
    try {
      wav = (deps.wavOf ?? wavOf)(file);
    } catch (error) {
      console.error(`nixamp: ${(error as Error).message}`);
      return 1;
    }
    const answer = await askToHear(signed, { wav, ...(language ? { language } : {}), server, channel: flag(argv, "--channel") ?? "live" }, fetcher);
    if (!answer.ok) {
      console.error(`nixamp: ${answer.error}`);
      return 1;
    }
    if (asJson) {
      console.log(JSON.stringify(answer.heard, null, 2));
      return 0;
    }
    if (answer.heard.text === "") {
      console.error("nixamp: heard nothing in that.");
      return 1;
    }
    console.log(answer.heard.text);
    if (answer.heard.message) console.error(`  Said in the room for ${flag(argv, "--channel") ?? "live"} at ${server} as ${answer.heard.message.handle}.`);
    else console.error("  Nothing was posted: there were no words to post.");
    return 0;
  }

  // The whole thing, kept under what it is.
  let media: string;
  try {
    media = /^https?:\/\//.test(file) ? mediaOfUrl(file) : (deps.fingerprint ?? fileFingerprint)(file);
  } catch {
    console.error(`nixamp: cannot read ${file}`);
    return 1;
  }
  const id = transcriptIdOf(media);
  const title = /^https?:\/\//.test(file) ? file : basename(file, extname(file));
  // A file gets its address at nixamp.com/hash/<sha256> too, with what this
  // machine knows about it, so the transcript has somewhere to hang.
  if (!/^https?:\/\//.test(file) && !deps.fingerprint) {
    void (async () => {
      try {
        const tools = detectTools();
        const described = await describeFile(file, { tools, enricher: new Enricher() });
        const refused = await keepFile(signed, file, described, { fetcher });
        if (refused) console.error(`  The file's record was not kept: ${refused}`);
        else console.error(`  ${site}/hash/${described.id}`);
      } catch {
        // The transcript is the point; the record is a bonus.
      }
    })();
  }
  const wanted = (flag(argv, "--translate") ?? "").split(",").map((one) => languageCode(one)).filter((one): one is string => typeof one === "string" && one !== "");
  if (argv.includes("--translate") && wanted.length === 0) {
    console.error("nixamp: --translate is one or more two-letter codes, such as de,sv.");
    return 64;
  }
  const progress = (line: string): void => console.error(line);

  let original: StoredTranscript | null = null;
  if (!argv.includes("--fresh")) {
    const kept = await fetchTranscript(signed, id, "", fetcher);
    if (kept.ok && kept.body.complete) {
      original = kept.body;
      progress(`  Already written down (${original.lines.length} lines${original.language ? `, ${original.language}` : ""}); --fresh hears it again.`);
    } else if (!kept.ok && kept.status !== 404) {
      console.error(`nixamp: ${kept.error}`);
      return 1;
    }
  }
  if (!original) {
    progress(`  Hearing ${title}, a minute at a time...`);
    const heard = await hearWhole(signed, file, media, { ...(language ? { language } : {}), title }, {
      fetcher, onProgress: progress, ...(deps.windows ? { windows: deps.windows } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    if (!heard.ok) {
      console.error(`nixamp: ${heard.error}`);
      return 1;
    }
    if (heard.heard.lines.length === 0) {
      console.error("nixamp: heard nothing in that.");
      return 1;
    }
    const kept = await fetchTranscript(signed, id, "", fetcher);
    original = kept.ok ? kept.body : {
      id, media, kind: "file", language: heard.heard.language, translatedFrom: null, model: heard.heard.model, complete: true, title,
      seconds: heard.heard.seconds, updatedAt: "", lines: heard.heard.lines, languages: [],
    };
    progress(`  Kept on nixamp.com as ${id.slice(0, 12)}: ${original.lines.length} lines${original.language ? ` of ${original.language}` : ""}.`);
  }

  const versions: StoredTranscript[] = [original];
  for (const to of wanted) {
    if (to === original.language) continue;
    const got = await awaitTranscript(signed, id, to, { fetcher, onProgress: progress, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.polls !== undefined ? { polls: deps.polls } : {}) });
    if (!got.ok) {
      console.error(`nixamp: could not get it in ${to}: ${got.error}`);
      return 1;
    }
    if (got.body.translating) {
      console.error(`nixamp: ${to} is still being translated (${got.body.translating.done} of ${got.body.translating.total}); ask again in a moment.`);
      return 1;
    }
    versions.push(got.body);
  }

  const out = flag(argv, "--out");
  if (out) {
    mkdirSync(out, { recursive: true });
    const stem = title.replace(/[^\w.-]+/g, "_").slice(0, 80) || "transcript";
    const extension = format === "lines" ? "txt" : format;
    for (const version of versions) {
      const path = join(out, `${stem}${version.language ? `.${version.language}` : ""}.${asJson ? "json" : extension}`);
      writeFileSync(path, asJson ? JSON.stringify(version, null, 2) : rendered(version.lines, format === "lines" ? "txt" : format));
      console.log(path);
    }
    return 0;
  }
  if (asJson) {
    console.log(JSON.stringify(versions.length === 1 ? versions[0] : versions, null, 2));
    return 0;
  }
  versions.forEach((version, i) => {
    if (versions.length > 1) console.error(i === 0 ? `-- ${version.language || "original"} --` : `\n-- ${version.language} --`);
    console.log(rendered(version.lines, format));
  });
  return 0;
}

export { stamp };

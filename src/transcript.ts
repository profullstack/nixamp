/**
 * `nixamp transcript` -- what a channel is saying, in the terminal.
 *
 * The server carrying the channel captions it (see captions.ts) and keeps
 * the recent lines; this asks for them, and with --follow keeps asking, a
 * poll every few seconds with the last line's time so nothing is printed
 * twice. A poll rather than the SSE the page uses because each ask also
 * keeps the captioner alive, which is what a terminal that is still
 * reading wants, and there is nothing to parse.
 *
 * Pointed at a server the way `nixamp admin` is: --url and --key from its
 * share link, or the daemon on this machine when neither is given.
 */
import { resolveTarget } from "./admin.ts";
import { readSession, type Session } from "./session.ts";
import { KEY_HEADER } from "./share.ts";
import { awaitTranscript, rendered } from "./transcribe.ts";
import { listTranscripts } from "./transcript-client.ts";
import { idFrom, languageCode } from "./transcripts.ts";

const HELP = `nixamp transcript — what a channel is saying, written down.

  nixamp transcript --channel ID                 the recent lines from this machine's daemon
  nixamp transcript --url URL --key K --channel ID   from another server, with its share link
  nixamp transcript ... --follow                 and keep printing as it speaks
  nixamp transcript ... --language sv            the lines in Swedish, translated as they are said
  nixamp transcript ... --json                   the lines as JSON
  nixamp transcript --kept MEDIA_OR_ID [--language de] [--srt|--vtt|--txt]
                                                 a transcript nixamp.com keeps: a file's, a link's, a past live's
  nixamp transcript --list                       what this account has had written down

ID is the channel's id as the server names it (the address bar says it when
you are watching one). The server captions a channel while somebody is asking
for the transcript, with nixamp.com's ear; it needs an ffmpeg and a sign-in
(\`nixamp login\`) on that server. What it hears is kept on nixamp.com under
what the channel is playing, and read back from there the next time.
`;

export interface TranscriptLine {
  channel: string;
  at: number;
  until: number;
  text: string;
  language?: string;
  original?: string;
}

export interface TranscriptAnswer {
  channel: string;
  backlog: number;
  now: number;
  on: boolean;
  lines: number;
  error: string;
  /** The recent lines, oldest first. Named `lines` on the wire; renamed here so the count above keeps its name. */
  recent: TranscriptLine[];
}

export type Fetched = { ok: true; answer: TranscriptAnswer } | { ok: false; status: number; error: string };

/** One ask for a channel's recent lines, after a moment when given. */
export async function readTranscript(
  target: { url: string; key: string | null },
  channel: string,
  after = 0,
  fetcher: typeof fetch = fetch,
  language = "",
): Promise<Fetched> {
  const url = new URL(`${target.url.replace(/\/+$/, "")}/api/channels/${encodeURIComponent(channel)}/transcript`);
  if (after > 0) url.searchParams.set("after", String(after));
  if (language) url.searchParams.set("language", language);
  let response: Response;
  try {
    response = await fetcher(url.toString(), { headers: target.key ? { [KEY_HEADER]: target.key } : {} });
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach ${url.origin}: ${(error as Error).message}` };
  }
  const body = (await response.json().catch(() => ({}))) as {
    channel?: string; backlog?: number; now?: number; on?: boolean; lines?: TranscriptLine[] | number; error?: string;
  };
  if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `the server answered ${response.status}` };
  const recent = Array.isArray(body.lines) ? body.lines : [];
  return {
    ok: true,
    answer: {
      channel: body.channel ?? channel,
      backlog: body.backlog ?? 0,
      now: body.now ?? Date.now(),
      on: body.on ?? false,
      lines: recent.length,
      error: body.error ?? "",
      recent,
    },
  };
}

/** A line as the terminal prints it: the time its sound was heard, then the words; a translation says its language. */
export function printed(line: TranscriptLine): string {
  const at = new Date(line.at);
  const clock = Number.isNaN(at.getTime()) ? "--:--:--" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${clock}  ${line.original !== undefined && line.language ? `[${line.language}] ` : ""}${line.text}`;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export interface TranscriptDeps {
  fetcher?: typeof fetch;
  /** How long --follow waits between asks. Short in the tests. */
  everyMs?: number;
  /** How many asks --follow makes before it stops. Forever, except in the tests. */
  polls?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The sign-in, for what nixamp.com keeps; the tests hand one in. */
  session?: Pick<Session, "site" | "token"> | null;
}

/** `--kept` and `--list`: what nixamp.com keeps, rather than what a server is saying now. */
async function kept(argv: string[], deps: TranscriptDeps, language: string): Promise<number> {
  const session = deps.session === undefined ? readSession() : deps.session;
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const fetcher = deps.fetcher ?? fetch;
  if (argv.includes("--list")) {
    const got = await listTranscripts(session, fetcher);
    if (!got.ok) {
      console.error(`nixamp: ${got.error}`);
      return 1;
    }
    if (argv.includes("--json")) {
      console.log(JSON.stringify(got.body.transcripts, null, 2));
      return 0;
    }
    if (got.body.transcripts.length === 0) {
      console.log("Nothing written down yet. `nixamp transcribe FILE` keeps a file; a captioned channel keeps itself.");
      return 0;
    }
    for (const one of got.body.transcripts) {
      console.log(`${one.id}  ${(one.language || "?").padEnd(2)}${one.translatedFrom ? `<${one.translatedFrom}` : "   "}  ${String(one.lines).padStart(5)} lines${one.complete ? " " : "+"}  ${one.title || one.media}`);
    }
    return 0;
  }
  const named = flag(argv, "--kept") ?? "";
  if (!named) {
    console.error("nixamp: --kept needs the transcript's id, or the media identity.");
    return 64;
  }
  const got = await awaitTranscript(session, idFrom(named), language, {
    fetcher, onProgress: (line) => console.error(line), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.polls !== undefined ? { polls: deps.polls } : {}),
  });
  if (!got.ok) {
    console.error(`nixamp: ${got.error}`);
    return 1;
  }
  if (got.body.translating) {
    console.error(`nixamp: still being translated (${got.body.translating.done} of ${got.body.translating.total}); ask again in a moment.`);
    return 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(got.body, null, 2));
    return 0;
  }
  console.log(rendered(got.body.lines, argv.includes("--srt") ? "srt" : argv.includes("--vtt") ? "vtt" : argv.includes("--txt") ? "txt" : "lines"));
  return 0;
}

export async function transcript(argv: string[], deps: TranscriptDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(HELP);
    return 0;
  }
  const language = languageCode(flag(argv, "--language"));
  if (language === null) {
    console.error("nixamp: --language is a two-letter code, such as sv.");
    return 64;
  }
  if (argv.includes("--kept") || argv.includes("--list")) return kept(argv, deps, language);
  let target: { url: string; key: string | null };
  try {
    target = resolveTarget(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  const channel = flag(argv, "--channel") ?? "main";
  const follow = argv.includes("--follow") || argv.includes("-f");
  const asJson = argv.includes("--json");
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let after = 0;
  let polls = 0;
  for (;;) {
    const got = await readTranscript(target, channel, after, fetcher, language);
    if (!got.ok) {
      console.error(`nixamp: ${got.error}`);
      return 1;
    }
    if (asJson) {
      console.log(JSON.stringify(got.answer.recent, null, 2));
      if (!follow) return 0;
    } else {
      if (after === 0 && got.answer.recent.length === 0 && !follow) {
        console.log(got.answer.error
          ? `Nothing yet: ${got.answer.error}`
          : "Nothing said yet. The server has just started listening; ask again in a few seconds, or --follow.");
        return 0;
      }
      for (const line of got.answer.recent) console.log(printed(line));
      if (!follow) return 0;
      if (after === 0 && got.answer.error) console.error(`nixamp: ${got.answer.error}`);
    }
    const last = got.answer.recent[got.answer.recent.length - 1];
    if (last) after = last.at;
    polls += 1;
    if (deps.polls !== undefined && polls >= deps.polls) return 0;
    await sleep(deps.everyMs ?? 5000);
  }
}

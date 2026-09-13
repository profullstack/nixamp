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
import { KEY_HEADER } from "./share.ts";

const HELP = `nixamp transcript — what a channel is saying, written down.

  nixamp transcript --channel ID                 the recent lines from this machine's daemon
  nixamp transcript --url URL --key K --channel ID   from another server, with its share link
  nixamp transcript ... --follow                 and keep printing as it speaks
  nixamp transcript ... --json                   the lines as JSON

ID is the channel's id as the server names it (the address bar says it when
you are watching one). The server captions a channel while somebody is asking
for the transcript, with nixamp.com's ear; it needs an ffmpeg and a sign-in
(\`nixamp login\`) on that server.
`;

export interface TranscriptLine {
  channel: string;
  at: number;
  until: number;
  text: string;
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
): Promise<Fetched> {
  const url = new URL(`${target.url.replace(/\/+$/, "")}/api/channels/${encodeURIComponent(channel)}/transcript`);
  if (after > 0) url.searchParams.set("after", String(after));
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

/** A line as the terminal prints it: the time its sound was heard, then the words. */
export function printed(line: TranscriptLine): string {
  const at = new Date(line.at);
  const clock = Number.isNaN(at.getTime()) ? "--:--:--" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${clock}  ${line.text}`;
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
}

export async function transcript(argv: string[], deps: TranscriptDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(HELP);
    return 0;
  }
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
    const got = await readTranscript(target, channel, after, fetcher);
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

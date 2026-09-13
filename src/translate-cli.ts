/**
 * `nixamp translate` -- a line in another language, from the terminal.
 *
 * The models are nixamp.com's (see translate.ts); this sends the text and
 * prints what comes back, signed in as whoever this machine is signed in
 * as. Text on the command line, or on stdin when there is none there, one
 * line at a time so a file of lines comes back as a file of lines.
 */
import { readSession, type Session } from "./session.ts";
import { translateTexts, type Signed } from "./transcript-client.ts";
import { languageCode } from "./transcripts.ts";

const HELP = `nixamp translate — say it in another language.

  nixamp translate --to sv "Hello there"      Swedish, from English
  nixamp translate --from de --to en "Guten Tag"
  cat lines.txt | nixamp translate --to de    each line, in order
  nixamp translate --languages                what nixamp.com can translate between

The models are open-source (OPUS-MT) and run on nixamp.com's own CPU; a pair
with no model of its own goes through English. Needs a sign-in
(\`nixamp login\`).
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export interface TranslateDeps {
  fetcher?: typeof fetch;
  session?: Pick<Session, "site" | "token"> | null;
  /** What stdin says, when no text is on the command line; the tests hand it in. */
  stdin?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface LanguageRow {
  code: string;
  name: string;
  native: string;
  targets: string[];
}

export async function translate(argv: string[], deps: TranslateDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(HELP);
    return 0;
  }
  const session = deps.session === undefined ? readSession() : deps.session;
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const fetcher = deps.fetcher ?? fetch;
  const signed: Signed = { site: session.site, token: session.token };
  if (argv.includes("--languages")) {
    let response: Response;
    try {
      response = await fetcher(`${signed.site.replace(/\/+$/, "")}/api/v1/translate`);
    } catch (error) {
      console.error(`nixamp: could not reach ${signed.site}: ${(error as Error).message}`);
      return 1;
    }
    const body = (await response.json().catch(() => ({}))) as { available?: boolean; languages?: LanguageRow[]; error?: string };
    if (!response.ok) {
      console.error(`nixamp: ${body.error ?? `nixamp.com answered ${response.status}`}`);
      return 1;
    }
    if (argv.includes("--json")) {
      console.log(JSON.stringify(body, null, 2));
      return 0;
    }
    if (body.available === false) console.error("nixamp: that nixamp has no translation models; nixamp.com does.");
    for (const language of body.languages ?? []) {
      console.log(`${language.code}  ${language.name.padEnd(11)} ${language.native.padEnd(17)} -> ${language.targets.join(" ")}`);
    }
    return 0;
  }
  const to = languageCode(flag(argv, "--to"));
  const from = languageCode(flag(argv, "--from") ?? "en");
  if (!to || from === null || from === "") {
    console.error("nixamp: --to (and --from, English by default) are two-letter language codes, such as sv.");
    return 64;
  }
  const withValue = new Set(["--to", "--from"]);
  const given = argv.filter((one, at) => !one.startsWith("-") && !(at > 0 && withValue.has(argv[at - 1] as string)));
  const text = given.length > 0 ? given.join(" ") : await (deps.stdin ?? readStdin)();
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    console.error("nixamp: translate what? Pass the text, or pipe it in.");
    return 64;
  }
  const got = await translateTexts(signed, lines, from, to, fetcher);
  if (!got.ok) {
    console.error(`nixamp: ${got.error}`);
    return 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(got.body, null, 2));
    return 0;
  }
  console.log(got.body.texts.join("\n"));
  return 0;
}

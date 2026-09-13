/**
 * `nixamp profile` and `nixamp voices` -- who the rooms know you as, from
 * the terminal, and the voices a line can be read in.
 *
 * The same route the Account panel uses (`/api/v1/me/handle`), signed in
 * as this machine is. The MCP tools of the same names are these functions
 * with a different front.
 */
import { readSession, type Session } from "./session.ts";

const HELP = `nixamp profile — who the rooms know you as.

  nixamp profile                       your handle, voice and OpenProfile
  nixamp profile --handle chovy        the name on every line you say
  nixamp profile --voice female        the voice your lines are read in on the phone:
                                       female, male, any, or a voice id (see \`nixamp voices\`)
  nixamp profile --profile URL         your OpenProfile.md; its Voice, Gender or Pronouns
                                       decide the voice when you set none here
  nixamp profile --json                as JSON
  nixamp voices                        the voices this nixamp.com reads lines in

When somebody is on the phone in a live room, every trollbox line is read
to them in the author's voice: the one set here, else the OpenProfile's,
else one picked for the account and kept. Two people in a room are two
different voices.
`;

export interface Persona {
  handle: string;
  voice: string;
  profile: string;
  chosen: boolean;
  /** The voice a line of theirs would be read in right now. */
  spoken?: string;
}

export interface Pools {
  provider: string;
  female: string[];
  male: string[];
}

export type Answer<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

function headers(session: Pick<Session, "token">): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
}

export async function readPersona(session: Pick<Session, "site" | "token">, fetcher: typeof fetch = fetch): Promise<Answer<Persona>> {
  try {
    const response = await fetcher(`${session.site.replace(/\/+$/, "")}/api/v1/me/handle`, { headers: headers(session) });
    const body = (await response.json().catch(() => ({}))) as Persona & { error?: string };
    if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `nixamp answered ${response.status}` };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach ${session.site}: ${(error as Error).message}` };
  }
}

export async function writePersona(
  session: Pick<Session, "site" | "token">,
  wanted: { handle?: string; voice?: string; profile?: string },
  fetcher: typeof fetch = fetch,
): Promise<Answer<Persona>> {
  try {
    const response = await fetcher(`${session.site.replace(/\/+$/, "")}/api/v1/me/handle`, {
      method: "PUT",
      headers: headers(session),
      body: JSON.stringify(wanted),
    });
    const body = (await response.json().catch(() => ({}))) as Persona & { error?: string };
    if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `nixamp answered ${response.status}` };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach ${session.site}: ${(error as Error).message}` };
  }
}

export async function readVoices(session: Pick<Session, "site" | "token">, fetcher: typeof fetch = fetch): Promise<Answer<Pools>> {
  try {
    const response = await fetcher(`${session.site.replace(/\/+$/, "")}/api/v1/voices`, { headers: headers(session) });
    const body = (await response.json().catch(() => ({}))) as Pools & { error?: string };
    if (!response.ok) return { ok: false, status: response.status, error: body.error ?? `nixamp answered ${response.status}` };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, status: 0, error: `could not reach ${session.site}: ${(error as Error).message}` };
  }
}

/** A persona, as the terminal says it. */
export function personaLines(persona: Persona): string[] {
  const voice = persona.voice === "female" ? "a woman's voice"
    : persona.voice === "male" ? "a man's voice"
      : persona.voice ? `the voice ${persona.voice}`
        : persona.profile ? "whatever your OpenProfile says, else one picked for you"
          : "one picked for you";
  return [
    persona.chosen ? `You are ${persona.handle} in every room.` : `Rooms call you ${persona.handle} until you pick a handle (--handle).`,
    `On the phone your lines are read in ${voice}${persona.spoken ? ` (${persona.spoken})` : ""}.`,
    persona.profile ? `OpenProfile: ${persona.profile}` : "No OpenProfile set (--profile URL).",
  ];
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export interface ProfileDeps {
  fetcher?: typeof fetch;
  session?: Pick<Session, "site" | "token"> | null;
}

export async function profile(argv: string[], deps: ProfileDeps = {}): Promise<number> {
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
  const wanted: { handle?: string; voice?: string; profile?: string } = {};
  for (const [name, key] of [["--handle", "handle"], ["--voice", "voice"], ["--profile", "profile"]] as const) {
    if (argv.includes(name)) {
      const value = flag(argv, name);
      if (value === undefined || value.startsWith("--")) {
        console.error(`nixamp: ${name} needs a value.`);
        return 64;
      }
      wanted[key] = value;
    }
  }
  const answer = Object.keys(wanted).length > 0 ? await writePersona(session, wanted, fetcher) : await readPersona(session, fetcher);
  if (!answer.ok) {
    console.error(`nixamp: ${answer.error}`);
    return 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  for (const line of personaLines(answer.body)) console.log(line);
  return 0;
}

export async function voices(argv: string[], deps: ProfileDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const session = deps.session === undefined ? readSession() : deps.session;
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const answer = await readVoices(session, deps.fetcher ?? fetch);
  if (!answer.ok) {
    console.error(`nixamp: ${answer.error}`);
    return 1;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify(answer.body, null, 2));
    return 0;
  }
  console.log(`Voices: ${answer.body.provider}. Set one with \`nixamp profile --voice <id>\`, or --voice female/male to be given one of these and keep it.`);
  console.log("  Women:");
  for (const one of answer.body.female) console.log(`    ${one}`);
  console.log("  Men:");
  for (const one of answer.body.male) console.log(`    ${one}`);
  return 0;
}

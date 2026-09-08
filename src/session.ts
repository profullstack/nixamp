/**
 * Being signed in, from a terminal.
 *
 * `nixamp login` asks for an address and a password, and keeps the token it
 * gets back beside the daemon's state. The desktop app bundles this same CLI,
 * so signing in there and signing in here are the same thing on disk.
 *
 * The password is read with the echo turned off and is never written down: the
 * token is what is kept, and it can be revoked without changing anything the
 * person has to remember.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { stateDir } from "./daemon.ts";
import { DEFAULT_DIRECTORY } from "./directory.ts";

export interface Session {
  site: string;
  email: string;
  token: string;
  signedInAt: number;
}

export function sessionPath(): string {
  return join(stateDir(), "session.json");
}

export function readSession(): Session | null {
  try {
    return JSON.parse(readFileSync(sessionPath(), "utf8")) as Session;
  } catch {
    return null;
  }
}

export function writeSession(session: Session): void {
  const path = sessionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
  // A bearer token is as good as the password for as long as it lives, so it
  // is not left readable by everyone with an account on the machine.
  chmodSync(path, 0o600);
}

export function clearSession(): void {
  rmSync(sessionPath(), { force: true });
}

/**
 * Ask without echoing. Node has no "read a password" call, so the terminal is
 * put in raw mode and the keystrokes are collected by hand.
 */
export async function askSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    // A pipe has no echo to turn off, and reading a line is what a script
    // wants anyway.
    const rl = createInterface({ input, output: process.stdout });
    try {
      return await rl.question("");
    } finally {
      rl.close();
    }
  }

  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise<string>((done) => {
    let typed = "";
    const onData = (key: string): void => {
      switch (key) {
        case "\u0003": // ctrl-c
          input.setRawMode(false);
          input.pause();
          process.stdout.write("\n");
          process.exit(130);
          return;
        case "\r":
        case "\n":
        case "\u0004": // ctrl-d
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          done(typed);
          return;
        case "\u007f": // backspace
        case "\b":
          typed = typed.slice(0, -1);
          return;
        default:
          // One printable character. An arrow key arrives as a whole escape
          // sequence, which would otherwise be appended as several characters
          // of password nobody typed.
          if (key.length === 1 && key >= " " && key !== "\u007f") typed += key;
      }
    };
    input.on("data", onData);
  });
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export interface LoginOptions {
  site: string;
  email: string;
  /** Create the account rather than signing in to one. */
  signUp: boolean;
  fetcher?: typeof fetch;
}

/** Read the flags `nixamp login` accepts. */
export function parseLoginArgs(argv: string[]): LoginOptions {
  const at = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    site: (at("--site") ?? DEFAULT_DIRECTORY).replace(/\/+$/, ""),
    email: at("--email") ?? argv.find((a) => !a.startsWith("-") && a.includes("@")) ?? "",
    signUp: argv.includes("--signup") || argv.includes("--sign-up"),
  };
}

/** `nixamp login` / `nixamp signup`. */
export async function login(argv: string[]): Promise<number> {
  const options = parseLoginArgs(argv);
  const send = options.fetcher ?? fetch;

  const email = options.email || (await ask("Email: "));
  if (!email) {
    console.error("nixamp: no email given");
    return 64;
  }
  const password = await askSecret("Password: ");
  if (!password) {
    console.error("nixamp: no password given");
    return 64;
  }

  const where = `${options.site}/api/v1/auth/${options.signUp ? "signup" : "login"}`;
  let answer: Response;
  try {
    answer = await send(where, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    console.error(`nixamp: could not reach ${options.site}: ${(error as Error).message}`);
    return 69;
  }

  const body = (await answer.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!answer.ok || !body.token) {
    console.error(`nixamp: ${body.error ?? `signing in failed (${answer.status})`}`);
    return 1;
  }

  writeSession({ site: options.site, email, token: body.token, signedInAt: Date.now() });
  console.log(`Signed in to ${options.site} as ${email}.`);
  return 0;
}

export function logout(): number {
  const session = readSession();
  clearSession();
  console.log(session ? `Signed out of ${session.site}.` : "nixamp: you were not signed in.");
  return 0;
}

/** `nixamp whoami`, which asks the server rather than trusting the file. */
export async function whoami(fetcher: typeof fetch = fetch): Promise<number> {
  const session = readSession();
  if (session === null) {
    console.log("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  try {
    const answer = await fetcher(`${session.site}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!answer.ok) {
      // The token outlived its welcome, which is worth saying plainly rather
      // than leaving a stale file to confuse the next command.
      console.log(`nixamp: signed in as ${session.email}, but ${session.site} no longer accepts it.`);
      console.log("  Run `nixamp login` again.");
      return 1;
    }
    const body = (await answer.json()) as { account?: { email?: string } };
    console.log(`${body.account?.email ?? session.email} at ${session.site}`);
    return 0;
  } catch {
    // Offline is not signed out: the token is still good, we just cannot ask.
    console.log(`${session.email} at ${session.site} (could not reach it to check)`);
    return 0;
  }
}

/**
 * Being signed in, from a terminal.
 *
 * There are three ways in, and they exist because a terminal is a bad place to
 * be asked for a password and a worse place to click a link:
 *
 * - **A provider**, through the device grant. The terminal shows a short code,
 *   you approve it in a browser on whatever device has a keyboard, and the
 *   terminal ends up holding a session it can use. It never sees the password
 *   or the provider's token. This is what `nixamp login` offers first.
 * - **An address and a password**, as before, for anyone who has one.
 * - **A token**, made once with `nixamp token create` and pasted into a build
 *   server. `NIXAMP_TOKEN` in the environment is a signed-in nixamp with no
 *   login at all, which is the only thing that works in CI.
 *
 * Whichever way in, what is kept on disk is a token beside the daemon's state.
 * The desktop app bundles this same CLI, so signing in there and signing in
 * here are the same thing on disk.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

/**
 * The session on disk, or the one in the environment.
 *
 * `NIXAMP_TOKEN` wins, and is the whole answer for a build server: there is no
 * `nixamp login` to run in a container, and a token pasted into a secret store
 * is the thing a build server can actually hold. It is deliberately not
 * written to disk -- the environment is where it came from and where it ends.
 */
export function readSession(env: NodeJS.ProcessEnv = process.env): Session | null {
  const fromEnv = env["NIXAMP_TOKEN"];
  if (fromEnv) {
    return {
      site: (env["NIXAMP_SITE"] ?? DEFAULT_DIRECTORY).replace(/\/+$/, ""),
      email: "",
      token: fromEnv,
      signedInAt: 0,
    };
  }
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
  /** A provider id to sign in with, `""` for none named. */
  with: string;
  /** Approve in a browser without naming a provider, whoever it is signed in as. */
  device: boolean;
  /** Skip the menu and ask for a password, however the site is configured. */
  password: boolean;
  /** A token made with `nixamp token create`, to keep rather than earn. */
  token: string;
  /** Do not try to open a browser. */
  noBrowser: boolean;
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
    // --with github, or the bare --github that people type anyway.
    with:
      at("--with") ??
      at("--provider") ??
      argv.find((a) => a === "--github" || a === "--google")?.slice(2) ??
      "",
    device: argv.includes("--device"),
    password: argv.includes("--password"),
    token: at("--token") ?? "",
    noBrowser: argv.includes("--no-browser"),
  };
}

export interface SiteWays {
  password: boolean;
  device: boolean;
  providers: { id: string; name: string }[];
}

/**
 * What this site will accept. An older nixamp has no such endpoint, and the
 * answer for one is the way in it has always had.
 */
export async function askWays(site: string, send: typeof fetch): Promise<SiteWays> {
  const fallback: SiteWays = { password: true, device: false, providers: [] };
  try {
    const answer = await send(`${site}/api/v1/auth/providers`);
    if (!answer.ok) return fallback;
    const body = (await answer.json()) as Partial<SiteWays>;
    return {
      password: body.password !== false,
      device: body.device === true,
      providers: Array.isArray(body.providers) ? body.providers : [],
    };
  } catch {
    return fallback;
  }
}

/**
 * Show a URL in a browser if there is one to show it in.
 *
 * Best effort by design: over ssh there is no browser and nothing should
 * pretend otherwise, which is why the code and the URL are always printed
 * whether this works or not.
 */
export function openInBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(opener, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser here. The printed URL is the fallback, and it is enough.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export interface DeviceIo {
  say: (line: string) => void;
  wait: (ms: number) => Promise<void>;
  open: (url: string) => void;
}

/**
 * The device grant, from this side.
 *
 * Ask for a code, show it, then poll until somebody approves it in a browser.
 * `slow_down` is obeyed rather than ignored: a server that says to back off is
 * the only warning before it stops answering at all.
 */
export async function deviceLogin(
  site: string,
  provider: string,
  send: typeof fetch,
  io: DeviceIo,
): Promise<{ token: string; email: string } | string> {
  let answer: Response;
  try {
    answer = await send(`${site}/api/v1/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    return `could not reach ${site}: ${(error as Error).message}`;
  }
  if (!answer.ok) return "this nixamp cannot sign a terminal in";
  const grant = (await answer.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!grant.device_code || !grant.user_code) return "this nixamp cannot sign a terminal in";

  // Straight to the provider when one was named, so the only thing to do in
  // the browser is approve. Otherwise the page asks which.
  const where =
    provider && grant.user_code
      ? `${site}/api/v1/${provider}/oauth/start?device=${encodeURIComponent(grant.user_code)}`
      : (grant.verification_uri_complete ?? grant.verification_uri ?? `${site}/api/v1/auth/device`);

  io.say("");
  io.say(`  Open  ${where}`);
  io.say(`  Code  ${grant.user_code}`);
  io.say("");
  io.say("Waiting for you to approve it...");
  io.open(where);

  let interval = Math.max(1, grant.interval ?? 5) * 1000;
  const until = Date.now() + Math.max(60, grant.expires_in ?? 600) * 1000;
  while (Date.now() < until) {
    await io.wait(interval);
    let poll: Response;
    try {
      poll = await send(`${site}/api/v1/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: grant.device_code }),
      });
    } catch {
      // A dropped network mid-wait is not a failed sign-in; keep asking.
      continue;
    }
    const body = (await poll.json().catch(() => ({}))) as { token?: string; email?: string; error?: string };
    if (poll.ok && body.token) return { token: body.token, email: body.email ?? "" };
    if (body.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "access_denied") return "that sign-in was refused";
    if (body.error === "expired_token") break;
  }
  return "the code expired before it was approved";
}

/** `nixamp login` / `nixamp signup`. */
export async function login(argv: string[], fetcher: typeof fetch = fetch): Promise<number> {
  const options = parseLoginArgs(argv);
  const send = options.fetcher ?? fetcher;

  // A token is not a sign-in, it is a token somebody already made. It is
  // checked before it is kept, so a typo fails here rather than at the next
  // command with a message about something else.
  if (options.token) {
    const account = await accountFor(options.site, options.token, send);
    if (account === null) {
      console.error(`nixamp: ${options.site} does not accept that token`);
      return 1;
    }
    writeSession({ site: options.site, email: account, token: options.token, signedInAt: Date.now() });
    console.log(`Signed in to ${options.site} as ${account}.`);
    return 0;
  }

  // Signing up is still an address and a password: a provider account that has
  // never been here signs up by signing in, which is the point of it.
  const ways = options.password || options.signUp ? null : await askWays(options.site, send);
  const chosen = ways ? await chooseWay(ways, options) : "password";
  if (chosen === null) {
    const offered = (ways?.providers ?? []).map((provider) => provider.id).join(", ");
    console.error(
      offered
        ? `nixamp: ${options.site} cannot sign you in with ${options.with}. It offers: ${offered}.`
        : `nixamp: ${options.site} offers no providers to sign in with.`,
    );
    return 64;
  }
  if (chosen !== "password") {
    const got = await deviceLogin(options.site, chosen === "device" ? "" : chosen, send, {
      say: (line) => console.log(line),
      wait: sleep,
      open: options.noBrowser ? () => {} : openInBrowser,
    });
    if (typeof got === "string") {
      console.error(`nixamp: ${got}`);
      return 1;
    }
    writeSession({ site: options.site, email: got.email, token: got.token, signedInAt: Date.now() });
    console.log(`Signed in to ${options.site} as ${got.email || "your account"}.`);
    return 0;
  }

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

/** The address a token belongs to, or null if the site will not have it. */
export async function accountFor(site: string, token: string, send: typeof fetch): Promise<string | null> {
  try {
    const answer = await send(`${site}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { account?: { email?: string } };
    return body.account?.email ?? "";
  } catch {
    return null;
  }
}

/**
 * Which way in to use.
 *
 * The menu only appears where it can be answered: a pipe gets the flow it has
 * always had, so a script that feeds an address and a password still works.
 * Null means what was asked for is not on offer here.
 */
export async function chooseWay(ways: SiteWays, options: LoginOptions): Promise<string | null> {
  if (options.with) {
    return ways.providers.some((provider) => provider.id === options.with) ? options.with : null;
  }
  // Asking for the browser without naming a provider: the page will offer
  // them, and a browser that is already signed in can approve on the spot.
  if (options.device) return ways.device ? "device" : null;
  // Naming an address is asking for the password flow by implication.
  if (!ways.device || options.email || !process.stdin.isTTY) return "password";
  if (ways.providers.length === 0) return "password";

  console.log("How would you like to sign in?");
  ways.providers.forEach((provider, index) => console.log(`  ${index + 1}) ${provider.name}`));
  console.log(`  ${ways.providers.length + 1}) Email and password`);
  const typed = await ask(`Choose [1]: `);
  const picked = typed === "" ? 1 : Number(typed);
  if (!Number.isInteger(picked) || picked < 1 || picked > ways.providers.length + 1) {
    console.log("Not one of those, so: email and password.");
    return "password";
  }
  return picked === ways.providers.length + 1 ? "password" : (ways.providers[picked - 1]?.id ?? "password");
}

const day = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 10) : "never");

/**
 * `nixamp token create|list|revoke`, which is how a machine that cannot sign
 * in gets to be signed in. The token is shown once, at creation, because the
 * server keeps only its hash and has nothing to show a second time.
 */
export async function tokens(argv: string[], fetcher: typeof fetch = fetch): Promise<number> {
  const session = readSession();
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const [command = "list", ...rest] = argv;
  const where = `${session.site}/api/v1/auth/tokens`;
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };

  try {
    if (command === "create" || command === "new" || command === "add") {
      const nameAt = rest.indexOf("--name");
      const name = (nameAt === -1 ? rest.find((a) => !a.startsWith("-")) : rest[nameAt + 1]) ?? "";
      const answer = await fetcher(where, { method: "POST", headers, body: JSON.stringify({ name }) });
      const body = (await answer.json().catch(() => ({}))) as { token?: string; id?: string; error?: string };
      if (!answer.ok || !body.token) {
        console.error(`nixamp: ${body.error ?? `could not make a token (${answer.status})`}`);
        return 1;
      }
      console.log(body.token);
      console.error("");
      console.error("Keep it somewhere safe: this is the only time it is shown.");
      console.error("Use it with NIXAMP_TOKEN=... or `nixamp login --token ...`.");
      return 0;
    }

    if (command === "revoke" || command === "rm" || command === "delete") {
      const id = rest.find((a) => !a.startsWith("-")) ?? "";
      if (!id) {
        console.error("nixamp: which token? `nixamp token list` shows their ids.");
        return 64;
      }
      const answer = await fetcher(`${where}/${encodeURIComponent(id)}`, { method: "DELETE", headers });
      if (!answer.ok) {
        console.error(`nixamp: ${answer.status === 404 ? "no token with that id" : "could not revoke it"}`);
        return 1;
      }
      console.log(`Revoked ${id}.`);
      return 0;
    }

    if (command === "list" || command === "ls") {
      const answer = await fetcher(where, { headers });
      const body = (await answer.json().catch(() => ({}))) as {
        tokens?: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
        error?: string;
      };
      if (!answer.ok) {
        console.error(`nixamp: ${body.error ?? `could not list them (${answer.status})`}`);
        return 1;
      }
      const list = body.tokens ?? [];
      if (list.length === 0) {
        console.log("No tokens. `nixamp token create --name ci` makes one.");
        return 0;
      }
      for (const token of list) {
        console.log(`${token.id}  ${day(token.createdAt)}  last used ${day(token.lastUsedAt)}  ${token.name}`);
      }
      return 0;
    }

    console.error(`nixamp: no such token command: ${command}`);
    return 64;
  } catch (error) {
    console.error(`nixamp: could not reach ${session.site}: ${(error as Error).message}`);
    return 69;
  }
}

export function logout(): number {
  const session = readSession();
  clearSession();
  if (process.env["NIXAMP_TOKEN"]) {
    // Deleting the file would not change anything while this is set, and
    // saying nothing would leave somebody wondering why they are still in.
    console.log("nixamp: NIXAMP_TOKEN is set in the environment, so you are still signed in with it.");
    return 0;
  }
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

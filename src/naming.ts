/**
 * A name and a certificate for this machine, from nixamp.com.
 *
 * The DNS keys never leave nixamp.com: a server signed in to an account asks
 * for `<label>.<handle>.nixamp.com` and the site makes the record for the
 * address the request came from, A and AAAA both. The certificate is one
 * wildcard per handle, issued and renewed by the site, handed to the account's
 * own servers over the authenticated API and kept on disk here so a restart
 * serves https at once rather than after a round trip.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Named {
  host: string;
  a: string;
  aaaa: string;
}

export interface CertFiles {
  cert: string;
  key: string;
  expiresAt: number;
  /** The name on the certificate, e.g. `*.chovy.nixamp.com`. */
  host: string;
}

/** A certificate this close to expiry is not worth serving: fetch a fresh one. */
const TOO_CLOSE_MS = 24 * 60 * 60 * 1000;

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/**
 * Claim, or refresh, this machine's name.
 *
 * "auto" for both families: the site records whichever addresses this request
 * arrived from, which is the only honest answer to "what is my public
 * address" from behind a router. Null when refused or unreachable, and the
 * reason is said rather than thrown: a server without a name still serves.
 */
export async function claimName(
  site: string,
  token: string,
  label: string,
  say: (line: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<Named | null> {
  try {
    const answer = await fetcher(`${site}/api/v1/dns/${encodeURIComponent(label)}`, {
      method: "PUT",
      headers: bearer(token),
      body: JSON.stringify({ a: "auto", aaaa: "auto" }),
    });
    const body = (await answer.json().catch(() => ({}))) as {
      name?: { host?: string; a?: string | null; aaaa?: string | null };
      error?: string;
    };
    if (!answer.ok || !body.name?.host) {
      say(`nixamp: ${site} would not name this machine: ${body.error ?? `answered ${answer.status}`}`);
      return null;
    }
    return { host: body.name.host, a: body.name.a ?? "", aaaa: body.name.aaaa ?? "" };
  } catch (error) {
    say(`nixamp: could not reach ${site} to claim a name: ${(error as Error).message}`);
    return null;
  }
}

/**
 * The handle's certificate.
 *
 * The first one is issued while we wait: a wildcard by DNS challenge takes a
 * couple of minutes, which is said once so the pause reads as work rather
 * than a hang. After that it is a cached answer on the site's side.
 */
export async function fetchCert(
  site: string,
  token: string,
  opts: {
    waitMs?: number;
    everyMs?: number;
    sleep?: (ms: number) => Promise<void>;
    fetcher?: typeof fetch;
  },
  say: (line: string) => void,
): Promise<CertFiles | null> {
  const waitMs = opts.waitMs ?? 240_000;
  const everyMs = opts.everyMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetcher = opts.fetcher ?? fetch;
  let waited = 0;
  let announced = false;

  for (;;) {
    let answer: Response;
    try {
      answer = await fetcher(`${site}/api/v1/certs`, { headers: bearer(token) });
    } catch (error) {
      say(`nixamp: could not reach ${site} for a certificate: ${(error as Error).message}`);
      return null;
    }
    const body = (await answer.json().catch(() => ({}))) as {
      status?: string;
      cert?: string;
      key?: string;
      expiresAt?: number;
      host?: string;
      error?: string;
    };

    if (answer.ok && body.status === "ready" && body.cert && body.key && body.host) {
      return { cert: body.cert, key: body.key, expiresAt: body.expiresAt ?? 0, host: body.host };
    }
    if (answer.status === 202 || body.status === "issuing") {
      if (!announced) {
        announced = true;
        const host = body.host ?? "your handle";
        say(`Getting a certificate for ${host}… the first one takes a couple of minutes.`);
      }
      if (waited >= waitMs) {
        say(`nixamp: ${site} is still issuing the certificate; serving http until it is ready.`);
        return null;
      }
      await sleep(everyMs);
      waited += everyMs;
      continue;
    }
    say(`nixamp: ${site} could not issue a certificate: ${body.error ?? `answered ${answer.status}`}`);
    return null;
  }
}

/** `*.chovy.nixamp.com` becomes `chovy.nixamp.com`, which is a filename. */
function fileStem(host: string): string {
  return host.replace(/^\*\./, "").replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * Keep a certificate beside the keys. Private, because the key is what lets
 * anybody be this server.
 */
export function writeCertFiles(stateDir: string, files: CertFiles): { cert: string; key: string } {
  const dir = join(stateDir, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stem = join(dir, fileStem(files.host));
  const cert = `${stem}.cert.pem`;
  const key = `${stem}.key.pem`;
  writeFileSync(cert, files.cert, { mode: 0o600 });
  writeFileSync(key, files.key, { mode: 0o600 });
  chmodSync(cert, 0o600);
  chmodSync(key, 0o600);
  writeFileSync(`${stem}.json`, JSON.stringify({ host: files.host, expiresAt: files.expiresAt }), { mode: 0o600 });
  return { cert, key };
}

/**
 * The certificate from last time, if it is still good for more than a day.
 * Anything closer to expiry is treated as absent so the next start fetches
 * a fresh one rather than serving one that lapses overnight.
 */
export function readCertFiles(
  stateDir: string,
  host: string,
): { cert: string; key: string; expiresAt: number } | null {
  const stem = join(stateDir, "tls", fileStem(host));
  try {
    const meta = JSON.parse(readFileSync(`${stem}.json`, "utf8")) as { expiresAt?: number };
    const expiresAt = typeof meta.expiresAt === "number" ? meta.expiresAt : 0;
    if (expiresAt - Date.now() < TOO_CLOSE_MS) return null;
    const cert = readFileSync(`${stem}.cert.pem`, "utf8");
    const key = readFileSync(`${stem}.key.pem`, "utf8");
    if (!cert || !key) return null;
    return { cert, key, expiresAt };
  } catch {
    return null;
  }
}

/**
 * What this machine calls itself in DNS: the name it was given, else the
 * first label of its hostname, made safe for a subdomain.
 */
export function labelFor(name: string, hostname: string): string {
  for (const candidate of [name, hostname.split(".")[0] ?? ""]) {
    const label = candidate
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/g, "");
    if (label.length >= 2) return label;
  }
  return "server";
}

/** File endings that name a playlist rather than a folder, dropped from a title. */
const PLAYLIST_ENDING = /\.(m3u8?|pls|xspf|txt|json)$/i;

/**
 * What to call a stream that was started on a path, for people.
 *
 * `nixamp serve ~/Music/live-sets_2024` used to be listed as the machine's
 * hostname, which tells a stranger nothing. The last segment of the path is
 * what the person who made the folder called it, so that is the title: the
 * separators that a filesystem forces become spaces, a playlist loses its
 * ending, and each lowercase word gets a capital. Words with a capital in
 * them already are left alone, so "DJ" and "LoFi" stay as written, and a
 * dash or dot between two digits stays too, so a date is still a date.
 * Empty when the path has no segment worth saying, and the caller falls
 * back to whatever it used before.
 */
export function humanizeSource(source: string): string {
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  let last = "";
  try {
    const path = remote ? new URL(source).pathname : source;
    last = path.split("/").filter(Boolean).pop() ?? "";
    if (remote) last = decodeURIComponent(last);
  } catch {
    return "";
  }
  if (last === "" || last === "~" || last === ".") return "";
  const words = last
    .replace(PLAYLIST_ENDING, "")
    .replace(/(?<!\d)[-_.+]+|[-_.+]+(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (words === "") return "";
  return words
    .split(" ")
    .map((word) => (word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ")
    .slice(0, 60)
    .trim();
}

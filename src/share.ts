/**
 * The share link.
 *
 * `nixamp serve` listens on every interface so the phone in your pocket can
 * reach it, and that is only reasonable because the address is not enough on
 * its own: every request has to carry a key that is printed once, in the link.
 * Someone else on the coffee shop wifi can find the port and gets nothing.
 *
 * The key travels in a cookie, set by opening the link. Nothing in the PWA had
 * to change for that: a browser sends a same-origin cookie with every fetch,
 * every EventSource and every `<audio src>` on its own.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";

/**
 * Two keys, two scopes.
 *
 * The full key drives the player: it can skip, stop, and point the server at a
 * different source. The listen key can only hear it. A stream published to the
 * public directory hands out the listen key, because a link that lets a
 * stranger pause your music is not a link you can publish.
 */
export type Scope = "control" | "listen";

/** The cookie, and the query parameter that sets it. */
export const KEY_COOKIE = "nixamp_key";
export const KEY_QUERY = "k";
export const KEY_HEADER = "x-nixamp-key";

/**
 * 128 bits, base64url. Long enough that guessing is not a strategy, short
 * enough to read down a phone screen when someone types it by hand.
 */
export function newKey(): string {
  return randomBytes(16).toString("base64url");
}

/** Compare without leaking where two keys first differ. */
export function keysMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Every place a key is accepted from, in the order they are looked for. */
export function keyFrom(request: IncomingMessage, url: URL): string | null {
  const query = url.searchParams.get(KEY_QUERY);
  if (query) return query;

  const header = request.headers[KEY_HEADER];
  if (typeof header === "string" && header) return header;

  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === KEY_COOKIE && rest.length > 0) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The Set-Cookie for a browser that just opened the link. */
export function keyCookie(key: string): string {
  // HttpOnly because nothing in the page reads it: the browser attaches it to
  // every same-origin request by itself. No Secure, because the whole point is
  // a plain-http address on your own network.
  return `${KEY_COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

/**
 * Interfaces that exist for containers and virtual machines. An address on one
 * of these reaches a bridge, not the phone on the sofa, and listing six of them
 * buries the one line someone actually needed.
 */
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo)/;

/** Where an address actually goes, which is not always where you would like. */
export function classify(address: string): "private" | "cgnat" | "public" {
  const [a, b] = address.split(".").map(Number) as [number, number];
  if (a === 10) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 169 && b === 254) return "private";
  // 100.64/10 is carrier-grade NAT, which in practice means Tailscale here.
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
}

/**
 * The addresses another device could actually reach this machine on, nearest
 * first. On a server the public one is the point: it is the address a phone
 * somewhere else can open. It is labelled for what it is, because the key in
 * the link is then the only thing between a stranger and the library.
 */
export function reachableAddresses(host: string, port: number): { label: string; url: string }[] {
  const link = (address: string): string => {
    // A bare IPv6 address needs brackets before it is a URL.
    const authority = address.includes(":") ? `[${address}]` : address;
    return `http://${authority}:${port}`;
  };

  if (host !== "0.0.0.0" && host !== "::") return [{ label: "here", url: link(host) }];

  const LABELS = { private: "on your network", cgnat: "on tailscale", public: "on the internet" } as const;
  const found: { label: string; url: string; kind: keyof typeof LABELS }[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of entries ?? []) {
      // Link-local v6 needs a scope id to be usable, and nobody types those in.
      if (entry.internal || entry.family !== "IPv4") continue;
      const kind = classify(entry.address);
      found.push({ label: LABELS[kind], url: link(entry.address), kind });
    }
  }
  const order = { private: 0, cgnat: 1, public: 2 } as const;
  found.sort((x, y) => order[x.kind] - order[y.kind]);
  return [
    { label: "here", url: `http://localhost:${port}` },
    ...found.map(({ label, url }) => ({ label, url })),
  ];
}

/** The full link, key and all. */
export function shareLink(base: string, key: string | null): string {
  return key === null ? base : `${base}/s/${key}`;
}

/**
 * The same stream, as bytes rather than as a page.
 *
 * A share link is for a browser: it answers 302, leaves a cookie behind and
 * redirects to the player. Anything that cannot hold a cookie -- the phone
 * line, curl, ffplay -- gets a 401 from it and no audio. This carries the key
 * in the query instead, which keyFrom() accepts, so a single anonymous GET is
 * enough to start hearing sound.
 */
export function audioLink(base: string, key: string | null): string {
  return key === null ? `${base}/api/live` : `${base}/api/live?${KEY_QUERY}=${encodeURIComponent(key)}`;
}

/**
 * What a key is allowed to do. An unknown key is allowed nothing, which is the
 * same answer as no key at all.
 */
export function scopeOf(offered: string | null, control: string | null, listen: string | null): Scope | null {
  if (offered === null) return null;
  if (control !== null && keysMatch(offered, control)) return "control";
  if (listen !== null && keysMatch(offered, listen)) return "listen";
  return null;
}

/** Paths a listen key may have. Everything else needs the control key. */
export function allowedForListening(path: string): boolean {
  if (path === "/api/command" || path === "/api/source") return false;
  return true;
}

/** How to run a command, so the tests never touch a real firewall. */
export interface Runner {
  read(path: string): string | null;
  run(command: string, args: string[]): { status: number | null; stdout: string };
}

/** Which firewall is in the way, if any. */
export type Firewall = "ufw" | "firewalld";

/**
 * Whether a firewall is running that would keep the port closed to other
 * devices. Listening on 0.0.0.0 proves the socket is open on this machine and
 * nothing more, so this is the difference between "it works" and "it works
 * here".
 */
export function firewallInUse(io: Runner): Firewall | null {
  if (process.platform !== "linux") return null;

  // ufw keeps its state in a file, so asking needs no privileges.
  const ufw = io.read("/etc/ufw/ufw.conf");
  if (ufw && /^ENABLED=yes/im.test(ufw)) return "ufw";

  const firewalld = io.run("systemctl", ["is-active", "firewalld"]);
  if (firewalld.status === 0 && firewalld.stdout.trim() === "active") return "firewalld";
  return null;
}

/** The commands that open and close a port, for each firewall we know. */
export function portCommands(firewall: Firewall, port: number): { open: string[]; close: string[] } {
  return firewall === "ufw"
    ? { open: ["ufw", "allow", `${port}/tcp`], close: ["ufw", "delete", "allow", `${port}/tcp`] }
    : {
        open: ["firewall-cmd", `--add-port=${port}/tcp`],
        close: ["firewall-cmd", `--remove-port=${port}/tcp`],
      };
}

/**
 * Root runs it directly; anyone else goes through sudo, and only when sudo
 * will not stop to ask. A server that hangs on an invisible password prompt is
 * worse than one that tells you the command to run yourself.
 */
export function elevate(io: Runner, command: string[]): string[] | null {
  const [head, ...rest] = command as [string, ...string[]];
  if (typeof process.getuid === "function" && process.getuid() === 0) return [head, ...rest];
  const canSudo = io.run("sudo", ["-n", "true"]);
  return canSudo.status === 0 ? ["sudo", "-n", head, ...rest] : null;
}

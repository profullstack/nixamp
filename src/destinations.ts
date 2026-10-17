/**
 * Whether a link somebody else pasted may be fetched from this machine.
 *
 * A member -- any nixamp.com account -- may put a link on the air on a server
 * that is not theirs. Fetching it is a request from inside the owner's
 * network, so a link to the router, the cloud metadata address or a service
 * on localhost would be the member reaching things only the owner can. The
 * owner may fetch what they like: it is their network. A member's link has to
 * resolve to a public address, every address it resolves to, at every hop
 * this code follows.
 *
 * What it cannot see: a redirect yt-dlp or ffmpeg follows on its own, and a
 * name that resolves differently a second later. The decoder's protocol list
 * (decoder-policy.ts) keeps those off the file system; keeping them off the
 * LAN entirely needs the fetch to happen here, which is later work.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (host: string) => Promise<string[]>;

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((one) => one.address);

function v4Number(address: string): number {
  return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function inV4(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v4Number(address) & mask) >>> 0) === ((v4Number(base) & mask) >>> 0);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Not somewhere on the public internet: loopback, private, link-local, reserved. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return PRIVATE_V4.some(([base, bits]) => inV4(address, base, bits));
  if (kind !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

/** "" when this link may be fetched for a member, else why not. */
export async function refusedDestination(link: string, lookup: Lookup = defaultLookup): Promise<string> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "that is not a link";
  }
  if (!/^(https?|rtmps?):$/i.test(url.protocol)) return "only http, https and rtmp links can be played here";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || /^localhost$/i.test(host) || /\.localhost$/i.test(host)) return "that link points at this machine";
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    return "that link's host does not resolve";
  }
  if (addresses.length === 0) return "that link's host does not resolve";
  if (addresses.some(isPrivateAddress)) return "that link points inside a private network, which only this server's owner may play";
  return "";
}

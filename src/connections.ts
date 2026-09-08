/**
 * Who is listening.
 *
 * A stream is a long-lived request, so the server can say exactly who is
 * connected, to what, since when and how much has gone out. That is the whole
 * point of the admin view: `ss -tn` tells you a socket exists, and nothing
 * about which track is going down it.
 */
import type { IncomingMessage } from "node:http";
import { classify } from "./share.ts";

export type Kind = "stream" | "media" | "events" | "page";

export interface Connection {
  id: number;
  kind: Kind;
  /** The remote address, with an IPv4-mapped IPv6 prefix taken off. */
  address: string;
  /** Where that address lives: your network, tailscale, or the internet. */
  network: "local" | "private" | "cgnat" | "public";
  /** What is going down it, when we know. */
  track: string;
  /** Whatever the client called itself, trimmed to something printable. */
  agent: string;
  startedAt: number;
  /**
   * Bytes handed to the socket, which is not the same as bytes the listener
   * has heard: the kernel buffers, and a slow client can be several seconds
   * behind this number. It is the right figure for "is anything going out".
   */
  bytes: number;
  /** Set when it ends, so the admin view can show what just finished. */
  endedAt: number | null;
}

/** ::ffff:10.0.0.1 is 10.0.0.1 wearing a hat. */
export function normaliseAddress(address: string | undefined): string {
  if (!address) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

/** Loopback is not "your network"; it is this machine. */
export function networkOf(address: string): Connection["network"] {
  if (address === "127.0.0.1" || address === "::1" || address === "unknown") return "local";
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return "public";
  return classify(address);
}

/**
 * A user agent, cut to the part that identifies it. Browsers write a paragraph
 * about every engine they have ever pretended to be.
 */
export function shortAgent(agent: string | undefined): string {
  if (!agent) return "—";
  const known = [
    [/\bFirefox\/([\d.]+)/, "Firefox"],
    [/\bEdg\/([\d.]+)/, "Edge"],
    [/\bOPR\/([\d.]+)/, "Opera"],
    [/\bChrome\/([\d.]+)/, "Chrome"],
    [/\bVersion\/([\d.]+).*\bSafari\//, "Safari"],
    [/\bVLC\/([\d.]+)/, "VLC"],
    [/\bcurl\/([\d.]+)/, "curl"],
    [/\bmpv\b/, "mpv"],
    [/\bLavf\/([\d.]+)/, "ffmpeg"],
  ] as const;
  for (const [pattern, name] of known) {
    const found = pattern.exec(agent);
    if (found) return found[1] ? `${name} ${found[1].split(".")[0]}` : name;
  }
  return agent.slice(0, 24);
}

/**
 * The live set. Finished connections are kept for a while, because "it stopped
 * ten seconds ago" is the most useful thing an admin view can tell you when
 * someone says the stream dropped.
 */
export class Connections {
  private next = 1;
  private readonly items = new Map<number, Connection>();
  /** How many finished connections to remember. */
  constructor(private readonly keep = 50) {}

  open(request: IncomingMessage, kind: Kind, track: string): Connection {
    const address = normaliseAddress(request.socket.remoteAddress);
    const connection: Connection = {
      id: this.next++,
      kind,
      address,
      network: networkOf(address),
      track,
      agent: shortAgent(request.headers["user-agent"]),
      startedAt: Date.now(),
      bytes: 0,
      endedAt: null,
    };
    this.items.set(connection.id, connection);
    return connection;
  }

  close(id: number): void {
    const found = this.items.get(id);
    if (!found || found.endedAt !== null) return;
    found.endedAt = Date.now();
    this.prune();
  }

  add(id: number, bytes: number): void {
    const found = this.items.get(id);
    if (found) found.bytes += bytes;
  }

  /**
   * Live first, oldest connection at the top; then the most recently finished.
   *
   * The id breaks ties because Date.now() has millisecond resolution and ten
   * connections can easily end inside one, which left the order down to
   * whatever the sort happened to do.
   */
  list(): Connection[] {
    const all = [...this.items.values()];
    const live = all
      .filter((c) => c.endedAt === null)
      .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
    const done = all
      .filter((c) => c.endedAt !== null)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.id - a.id);
    return [...live, ...done];
  }

  get active(): number {
    let count = 0;
    for (const item of this.items.values()) if (item.endedAt === null) count++;
    return count;
  }

  /** Drop the oldest finished entries once there are more than we keep. */
  private prune(): void {
    const done = [...this.items.values()]
      .filter((c) => c.endedAt !== null)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || a.id - b.id);
    for (const item of done.slice(0, Math.max(0, done.length - this.keep))) this.items.delete(item.id);
  }
}

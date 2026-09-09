/**
 * The wire format between a running nixamp and any remote that drives it.
 *
 * Kept free of node imports on purpose: the browser client type-checks against
 * this same file, so a change to the protocol breaks both sides at once rather
 * than one of them at runtime.
 */

/** A track as a remote sees it — no filesystem path leaves the machine. */
export interface RemoteTrack {
  title: string;
  artist: string;
  album: string;
  /** Seconds; 0 when ffprobe could not tell us. */
  duration: number;
  /**
   * Whether this is a film rather than a song.
   *
   * The server knows, because it has the path; a remote had been guessing, and
   * guessing wrong -- every remote track went to the audio element, so a video
   * a browser could show played its soundtrack over a blank panel.
   */
  video?: boolean;
  /**
   * The source this track came in with, when it was not part of the library.
   *
   * Absent means it belongs to whatever this server was started on. Present
   * means somebody added a folder or an album afterwards, and the name is what
   * a client puts at the top of that block so the two are not one soup.
   */
  group?: string;
  /**
   * Which folder it sits in, under whatever it was loaded from.
   *
   * Empty for a track at the top. A library is a shelf of albums and seasons,
   * and five thousand files in one flat list is a list nobody can find
   * anything in -- so the shape of the folders comes across and a player can
   * offer them as folders. Relative, always: where the library sits on
   * somebody's disk is their business.
   */
  folder?: string;
  /**
   * Whether this comes off the network rather than off a disk.
   *
   * A channel and a film in a folder are different kinds of thing and belong
   * in different lists -- one is live and one is on demand. Which it is has to
   * be a property of the track, because it was being inferred from how it
   * happened to be loaded: a re-stream that replaced the playlist carried no
   * group, so it appeared in no list of live streams at all and there was
   * nowhere to click it.
   */
  remote?: boolean;
}

/** Everything a remote needs to draw the player. */
export interface Snapshot {
  /** Bumped on every push so a client can drop an out-of-order frame. */
  revision: number;
  /**
   * The library, sent when it is news and left out when it is not.
   *
   * It used to ride in every frame. At twelve frames a second over a library of
   * five thousand, that is five megabytes a second of JSON for a client to
   * parse on the thread that is also decoding the audio -- which is exactly
   * what it sounded like. It is sent on the first frame of a subscription and
   * again whenever the list actually changes; absent means "the same as
   * before", and a client keeps what it had.
   */
  tracks?: RemoteTrack[];
  /**
   * How many tracks there are, in every frame.
   *
   * A client that has not received a list yet still has to draw something, and
   * a count is four bytes rather than half a megabyte.
   */
  trackCount: number;
  index: number;
  playing: boolean;
  position: number;
  /** Analyser bands, 0..1, one per bar. */
  bars: number[];
  /** Left and right peak levels, 0..1. */
  levels: [number, number];
  /** Whether this machine can actually make sound. */
  silent: boolean;
  note: string;
  root: string;
}

export type Command =
  | { type: "play"; index?: number }
  | { type: "toggle" }
  | { type: "stop" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "select"; index: number };

export const COMMAND_TYPES = ["play", "toggle", "stop", "next", "prev", "select"] as const;

/**
 * Commands arrive as untrusted JSON from a browser on the LAN, so nothing is
 * assumed: an unknown type or a non-integer index is a null, not a throw.
 */
export function parseCommand(input: unknown): Command | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string") return null;
  const index = record.index;
  const validIndex = typeof index === "number" && Number.isInteger(index) && index >= 0;

  switch (type) {
    case "toggle":
    case "stop":
    case "next":
    case "prev":
      return { type };
    case "play":
      return validIndex ? { type: "play", index: index as number } : { type: "play" };
    case "select":
      return validIndex ? { type: "select", index: index as number } : null;
    default:
      return null;
  }
}

/** The name a remote shows for a track. */
export function remoteName(track: RemoteTrack): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

export function emptySnapshot(): FullSnapshot {
  return {
    revision: 0,
    tracks: [],
    trackCount: 0,
    index: 0,
    playing: false,
    position: 0,
    bars: [],
    levels: [0, 0],
    silent: true,
    note: "",
    root: "",
  };
}

/**
 * Fold a frame into what the client already had.
 *
 * A frame without `tracks` is not a frame with no tracks: it is a frame that
 * had nothing new to say about them. Every client needs this, so none of them
 * should write it twice.
 */
export function merge(previous: FullSnapshot, incoming: Snapshot): FullSnapshot {
  return { ...incoming, tracks: incoming.tracks ?? previous.tracks };
}

/**
 * A snapshot a client has already folded, so the library is known to be there.
 * Every reader wants this one; only the wire carries the other.
 */
export type FullSnapshot = Snapshot & { tracks: RemoteTrack[] };

/**
 * What "Connect nixamp" looks like from a page: a leaf module, so a client
 * bundle can name these shapes without pulling the server in behind them.
 */

/** The connection as the account holder sees it. Never the tokens. */
export interface LinkView {
  connected: boolean;
  handle: string;
  nixampUserId: string;
  scope: string;
  since: number | null;
}

/** A stream somebody could pick: a channel on one of their servers, as a link a classroom accepts. */
export interface StreamPick {
  server: string;
  serverUrl: string;
  id: string;
  name: string;
  kind: string;
  listeners: number;
  link: string;
}

export interface ServerStreams {
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  playing: boolean;
  nowPlaying: string;
  /** A link to what the server itself is playing, when it is. */
  live: string;
  channels: StreamPick[];
}

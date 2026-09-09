/**
 * `nixamp admin` — what the daemon is doing, and who is listening to it.
 *
 * It talks to a running server over the same HTTP API a browser uses, so it
 * works against the local daemon, against `nixamp serve` in another terminal,
 * or against a nixamp on a different machine entirely.
 */
import { createApp, themes, type Container, type KeyEvent, type Theme } from "@profullstack/hqtui";
import type { Color } from "@profullstack/hqtui";
import type { Connection } from "./connections.ts";
import { daemonUrl, isLoopbackTls, readState } from "./daemon.ts";
import { KEY_HEADER } from "./share.ts";

interface Report {
  connections: Connection[];
  active: number;
  startedAt: number;
  now: number;
}

interface Snapshot {
  tracks: { title: string; artist: string; duration: number }[];
  index: number;
  playing: boolean;
  position: number;
  root: string;
  note: string;
}

export interface AdminOptions {
  url: string;
  key: string | null;
  /**
   * Every address the server found, labelled, share key not yet applied.
   *
   * `url` is the one this process talks to, which for a local daemon is
   * loopback -- correct for asking it questions and useless for handing to
   * anybody. These are the ones worth reading off the screen.
   */
  links: { label: string; url: string }[];
  /** What it is serving, so the admin view says so without being asked. */
  source: string;
}

/** Where to point, from the flags or from the daemon that is running. */
export function resolveTarget(argv: string[]): AdminOptions {
  const at = argv.findIndex((a) => a === "--url" || a === "-u");
  const keyAt = argv.findIndex((a) => a === "--key");
  const url = at === -1 ? null : argv[at + 1];
  const key = keyAt === -1 ? null : (argv[keyAt + 1] ?? null);

  // Pointed somewhere by hand, that address is the only one known.
  if (url) {
    const bare = url.replace(/\/+$/, "");
    return { url: bare, key, links: [{ label: "there", url: bare }], source: "" };
  }

  const state = readState();
  if (state === null) {
    // Named, with an example. "or pass --url" is only an instruction if you
    // already know what belongs after it, and the whole point of this message
    // is that you are looking at a machine you have no handle on.
    throw new Error(
      "nixamp: no daemon is running on this machine.\n" +
        "  Start one:        nixamp daemon start ~/Music\n" +
        "  Or administer another machine, with its share link:\n" +
        "                    nixamp admin --url https://server1.you.nixamp.com:4321 --key KEY\n" +
        "  The URL and key are the two halves of the link that server printed:\n" +
        "  https://host:4321/s/KEY",
    );
  }
  const url_ = daemonUrl(state);
  // Talking to our own daemon, whose certificate names somewhere else. Nothing
  // is in the way on loopback, so there is nothing for a certificate to prove.
  if (isLoopbackTls(url_)) process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  return {
    url: url_,
    key: key ?? state.key,
    // A state file written before 0.5.3 has no list; loopback stands in.
    links: state.urls ?? [{ label: "here", url: daemonUrl(state) }],
    source: state.source,
  };
}

/** Seconds as something a person reads at a glance. */
export function since(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * A key name rather than something somebody typed: "up", "f7", "ctrl+c".
 * Letters and digits only, so anything with a colon or a slash in it is text.
 */
const NAMED_KEY = /^(?:[a-z]+\d*|(?:ctrl|alt|shift|meta)\+.+)$/;

/**
 * What a keypress contributes to a field being typed into.
 *
 * A paste is one event carrying the whole string, not a burst of single
 * characters, so a handler that only accepted `key.length === 1` accepted
 * nothing at all from a paste -- which is how you find you cannot put a URL in
 * the box by any means except typing it out.
 *
 * The ambiguity is real and unavoidable: a pasted word of bare letters is
 * indistinguishable from a key name, and loses. A URL or a path never is,
 * because neither is spelled with letters alone.
 */
export function typed(key: string): string {
  if (key.length === 1) return key >= " " && key !== "\u007f" ? key : "";
  if (NAMED_KEY.test(key)) return "";
  // A paste. Control characters and newlines are not part of an address.
  return key.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function bytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let n = value;
  for (const unit of units) {
    if (n < 1024 || unit === "GiB") return `${n < 10 && unit !== "B" ? n.toFixed(1) : Math.round(n)} ${unit}`;
    n /= 1024;
  }
  return `${value} B`;
}

/** The colour a network deserves: the internet is the one worth noticing. */
function networkColor(theme: Theme, network: Connection["network"]): number {
  return network === "public"
    ? theme.warning
    : network === "cgnat"
      ? theme.secondary
      : network === "local"
        ? theme.muted
        : theme.success;
}

export async function admin(argv: string[]): Promise<void> {
  const target = resolveTarget(argv);
  const headers: Record<string, string> = target.key ? { [KEY_HEADER]: target.key } : {};

  const ask = async <T,>(path: string): Promise<T | null> => {
    try {
      const response = await fetch(`${target.url}${path}`, { headers });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  };

  let report: Report | null = null;
  let snapshot: Snapshot | null = null;
  let error = "";
  let restreaming = "";
  // Which of the two things typing a source means. Adding is the ordinary one
  // and has its own key; replacing throws the library away, so it has another.
  let replacing = false;
  let typing = false;

  const app = await createApp({ theme: themes.matrix, title: "nixamp admin", quitKeys: ["ctrl+c"] });

  const refresh = async (): Promise<void> => {
    const [next, state] = await Promise.all([ask<Report>("/api/connections"), ask<Snapshot>("/api/state")]);
    error = next === null ? `cannot reach ${target.url}` : "";
    if (next) report = next;
    if (state) snapshot = state;
    app.invalidate();
  };

  const timer = setInterval(() => void refresh(), 1000);
  await refresh();

  app.on("key", (event: KeyEvent) => {
    const key = event.key;
    if (typing) {
      if (key === "escape") { typing = false; restreaming = ""; replacing = false; }
      else if (key === "enter") {
        const url = restreaming.trim();
        const asReplacement = replacing;
        typing = false;
        restreaming = "";
        replacing = false;
        if (url) void restream(target, headers, url, asReplacement).then(() => refresh());
      } else if (key === "backspace") restreaming = restreaming.slice(0, -1);
      else restreaming += typed(key);
      app.invalidate();
      return;
    }
    if (key === "q") { app.quit(); return; }
    if (key === "a") { typing = true; replacing = false; app.invalidate(); }
    if (key === "r") { typing = true; replacing = true; app.invalidate(); }
  });

  app.on("exit", () => clearInterval(timer));
  app.render(({ ui, theme }) => draw(ui, theme, {
    url: target.url, report, snapshot, error, typing, restreaming, replacing,
    links: target.links, key: target.key, source: target.source,
  }));

  await app.start();
  clearInterval(timer);
}

/**
 * Hand the server something else to play.
 *
 * Two different asks down one route: adding puts an album on the end of the
 * playlist, replacing points the server somewhere else entirely. The server
 * adds unless told otherwise, so only the second one says anything.
 */
async function restream(
  target: AdminOptions,
  headers: Record<string, string>,
  url: string,
  replacing = false,
): Promise<void> {
  try {
    await fetch(`${target.url}/api/source`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: url, ...(replacing ? { replace: true } : {}) }),
    });
  } catch {
    // The next refresh reports the server being unreachable; this is not the
    // place to make that noise.
  }
}

export interface View {
  url: string;
  report: Report | null;
  snapshot: Snapshot | null;
  error: string;
  typing: boolean;
  restreaming: string;
  /** Whether what is being typed replaces the playlist rather than joining it. */
  replacing?: boolean;
  /** Labelled addresses, and the key that makes them work. */
  links: { label: string; url: string }[];
  key: string | null;
  source: string;
}

export function draw(ui: Container, theme: Theme, view: View): void {
  const { report, snapshot } = view;
  const now = report?.now ?? Date.now();

  ui.row({ size: 7, gap: 1 }, (row) => {
    row.panel({ title: "Server" }, (p) => {
      p.text(view.url, { fg: theme.primary });
      p.label(snapshot?.root ?? "—");
      p.keyValues([
        { label: "Uptime", value: report ? since(now - report.startedAt) : "—", color: theme.accent },
        { label: "Tracks", value: String(snapshot?.tracks.length ?? 0), color: theme.foreground },
        { label: "Listeners", value: String(report?.active ?? 0), color: theme.success },
      ]);
    });

    row.panel({ title: "Now playing" }, (p) => {
      const track = snapshot ? snapshot.tracks[snapshot.index] : undefined;
      p.text(track?.title ?? "nothing", { fg: theme.accent });
      p.label(track?.artist || "—");
      p.keyValues([
        { label: "State", value: snapshot?.playing ? "playing" : "stopped", color: snapshot?.playing ? theme.success : theme.muted },
        { label: "Position", value: snapshot ? since(snapshot.position * 1000) : "—", color: theme.foreground },
      ]);
    });
  });

  // The links, because the point of a daemon is the phone in the other room
  // and the address this process happens to talk to is the one that will not
  // reach it. The key is on them: without it every address is a 401.
  if (view.links.length > 0) {
    const width = Math.max(...view.links.map((link) => link.label.length));
    ui.panel({ title: "Share links", size: view.links.length + (view.source ? 3 : 2) }, (p) => {
      for (const link of view.links) {
        const full = view.key === null ? link.url : `${link.url}/s/${view.key}`;
        p.text(`${link.label.padEnd(width)}  ${full}`, {
          fg: link.label === "on the internet" ? theme.accent : theme.foreground,
        });
      }
      if (view.source) p.label(view.source);
    });
  }

  ui.panel({ title: `Connections (${report?.active ?? 0} live)` }, (p) => {
    if (view.error) {
      p.text(view.error, { fg: theme.danger });
      return;
    }
    const rows = report?.connections ?? [];
    if (rows.length === 0) {
      p.label("Nobody is listening yet.");
      return;
    }

    // A finished connection is drawn in muted colours rather than dropped: the
    // most useful thing an admin view can say is "it stopped ten seconds ago".
    const dim = (row: Connection, live: Color): Color => (row.endedAt === null ? live : theme.muted);

    p.table<Connection>({
      rows,
      header: true,
      headerColor: theme.muted,
      zebra: false,
      columns: [
        { key: "address", title: "Where", min: 12, color: (row) => dim(row, theme.foreground) },
        { key: "network", title: "Network", width: 9, color: (row) => dim(row, networkColor(theme, row.network)) },
        { key: "kind", title: "Kind", width: 7, color: theme.muted },
        { key: "agent", title: "Client", width: 12, color: theme.muted },
        { key: "track", title: "Track", min: 16, color: (row) => dim(row, theme.primary),
          render: (row) => row.track || "—" },
        { key: "for", title: "For", width: 10, align: "right", color: theme.muted,
          render: (row) => (row.endedAt === null
            ? since(now - row.startedAt)
            : `${since(row.endedAt - row.startedAt)} ago`) },
        { key: "bytes", title: "Sent", width: 9, align: "right",
          color: (row) => dim(row, theme.success), render: (row) => bytes(row.bytes) },
      ],
    });
  });

  if (view.typing) {
    ui.panel({
      title: view.replacing ? "Replace the playlist with a URL or a path" : "Add a URL or a path",
      size: 4,
    }, (p) => {
      p.text(`${view.restreaming}_`, { fg: theme.accent });
      p.label(view.replacing
        ? "Enter drops this library and serves that instead. Escape forgets it."
        : "Enter adds it to the playlist. Escape forgets it.");
    });
  }

  ui.statusBar({
    items: [
      { key: "a", label: "Add" },
      { key: "r", label: "Replace" },
      { key: "q", label: "Quit" },
    ],
    right: [{ key: "", label: report ? `${report.connections.length} seen` : "connecting" }],
  });
}

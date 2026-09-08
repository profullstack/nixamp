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
import { daemonUrl, readState } from "./daemon.ts";
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
}

/** Where to point, from the flags or from the daemon that is running. */
export function resolveTarget(argv: string[]): AdminOptions {
  const at = argv.findIndex((a) => a === "--url" || a === "-u");
  const keyAt = argv.findIndex((a) => a === "--key");
  const url = at === -1 ? null : argv[at + 1];
  const key = keyAt === -1 ? null : (argv[keyAt + 1] ?? null);

  if (url) return { url: url.replace(/\/+$/, ""), key };

  const state = readState();
  if (state === null) {
    throw new Error("nixamp: no daemon is running. Start one with `nixamp daemon start`, or pass --url.");
  }
  return { url: daemonUrl(state), key: key ?? state.key };
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
      if (key === "escape") { typing = false; restreaming = ""; }
      else if (key === "enter") {
        const url = restreaming.trim();
        typing = false;
        restreaming = "";
        if (url) void restream(target, headers, url).then(() => refresh());
      } else if (key === "backspace") restreaming = restreaming.slice(0, -1);
      // A printable key is a character; everything else is a name like "f1".
      else if (key.length === 1) restreaming += key;
      app.invalidate();
      return;
    }
    if (key === "q") { app.quit(); return; }
    if (key === "r") { typing = true; app.invalidate(); }
  });

  app.on("exit", () => clearInterval(timer));
  app.render(({ ui, theme }) => draw(ui, theme, {
    url: target.url, report, snapshot, error, typing, restreaming,
  }));

  await app.start();
  clearInterval(timer);
}

/** Ask the server to play something else, which is what re-streaming is. */
async function restream(target: AdminOptions, headers: Record<string, string>, url: string): Promise<void> {
  try {
    await fetch(`${target.url}/api/source`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: url }),
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
    ui.panel({ title: "Re-stream a URL or a path", size: 4 }, (p) => {
      p.text(`${view.restreaming}_`, { fg: theme.accent });
      p.label("Enter plays it here. Escape forgets it.");
    });
  }

  ui.statusBar({
    items: [
      { key: "r", label: "Re-stream" },
      { key: "q", label: "Quit" },
    ],
    right: [{ key: "", label: report ? `${report.connections.length} seen` : "connecting" }],
  });
}

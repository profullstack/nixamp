/**
 * `nixamp sync`: your settings on every machine, through your nixamp.com account.
 *
 * What syncs is what you decided, not what a machine is: the compression
 * policy (compression.json) and the channels you remembered (channels.json).
 * The library path is a place on one disk, the session and the share keys
 * are credentials, the catalogs carry provider URLs with credentials in
 * them, and the daemon's state belongs to one box; none of those leave.
 *
 * The mechanism is @profullstack/synconfig: one snapshot under a revision,
 * a conflict rather than a merge when two machines both saved, and a marker
 * so a load never overwrites an unsynced local edit.
 */
import { hostname } from "node:os";
import { createClient, load, save, status, type SyncContext, type SyncPolicy } from "@profullstack/synconfig";
import { stateDir } from "./daemon.ts";
import { readSession } from "./session.ts";
import { version } from "./meta.ts";

export const SYNC_POLICY: SyncPolicy = {
  files: [
    { path: "compression.json", json: true, label: "compression policy" },
    { path: "channels.json", json: true, label: "remembered channels" },
  ],
  never: ["config.json", "session.json", "keys.json", "cookies.txt", "daemon.json", "index.json", "enrich.json", "sync.json"],
  neverPrefixes: ["tls", "catalogs", "relay-cache"],
  neverSuffixes: [".log", ".pem", ".pid", ".sock"],
};

/** The account the snapshot lives at. Null when not signed in. */
export function syncContext(fetcher: typeof fetch = fetch): SyncContext | null {
  const session = readSession();
  if (session === null) return null;
  return {
    rootDir: stateDir(),
    policy: SYNC_POLICY,
    client: createClient({ baseUrl: session.site, path: "/api/v1/settings", token: session.token, fetchImpl: fetcher }),
    api: session.site,
    host: hostname(),
    app: `nixamp ${version()}`,
  };
}

const when = (iso?: string): string => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

/** `nixamp sync [status|save|load|revisions] [--force] [--dry-run]`. Returns the exit code. */
export async function syncCommand(argv: string[], fetcher: typeof fetch = fetch): Promise<number> {
  const [command = "status", ...rest] = argv;
  const force = rest.includes("--force");
  const dryRun = rest.includes("--dry-run");
  const ctx = syncContext(fetcher);
  if (ctx === null) {
    console.error("nixamp: not signed in. Try `nixamp login`; settings sync keeps them on your account.");
    return 1;
  }

  try {
    if (command === "status") {
      const state = await status(ctx);
      console.log(`here     ${state.marker ? `revision ${state.marker.revision}, synced ${when(state.marker.at)}` : "never synced"}`);
      console.log(`account  ${state.serverRevision !== undefined ? `revision ${state.serverRevision}, saved ${when(state.serverSavedAt)}${state.serverHost ? ` from ${state.serverHost}` : ""}` : "nothing yet"}`);
      if (state.drifted.length) console.log(`changed here: ${state.drifted.join(", ")}  (nixamp sync save)`);
      if (state.behind) console.log("the account is newer  (nixamp sync load)");
      if (state.marker && !state.drifted.length && !state.behind) console.log("in sync.");
      return 0;
    }
    if (command === "save") {
      const result = await save(ctx, { force });
      for (const skip of result.skipped) console.error(`  skipped ${skip.path}: ${skip.reason}`);
      if (result.status === "saved") console.log(`saved revision ${result.revision}: ${result.files} file${result.files === 1 ? "" : "s"}`);
      else if (result.status === "unchanged") console.log(`nothing changed since revision ${result.revision}`);
      else if (result.status === "empty") console.log("nothing to save: no compression policy or remembered channels here yet");
      else {
        console.error(`nixamp: not saved; another machine saved revision ${result.serverRevision} first. \`nixamp sync load\` to take theirs, or \`nixamp sync save --force\`.`);
        return 1;
      }
      return 0;
    }
    if (command === "load") {
      const result = await load(ctx, { force, dryRun });
      for (const reject of result.rejected) console.error(`  ignored ${reject.path}: ${reject.reason}`);
      switch (result.status) {
        case "empty":
          console.log("nothing on the account yet. `nixamp sync save` on the machine whose settings you want.");
          return 0;
        case "same":
          console.log(`already at revision ${result.revision}`);
          return 0;
        case "planned":
          for (const entry of result.plan) console.log(`  ${entry.status.padEnd(8)} ${entry.path}`);
          console.log(`would take revision ${result.revision}; nothing written`);
          return 0;
        case "newer":
          console.error("nixamp: the account holds settings saved by a newer nixamp. `nixamp update` first.");
          return 1;
        case "local_changes":
          console.error(`nixamp: not loaded; ${result.drifted.join(", ")} changed here since the last sync. \`nixamp sync save\` to keep yours, \`nixamp sync load --force\` to replace them.`);
          return 1;
        case "loaded":
          console.log(`loaded revision ${result.revision}: ${result.written.join(", ")}`);
          return 0;
      }
    }
    if (command === "revisions") {
      const revisions = await ctx.client.revisions();
      if (!revisions.length) console.log("nothing saved yet");
      for (const entry of revisions) console.log(`${String(entry.revision).padStart(4)}  ${when(entry.savedAt)}  ${(entry.host ?? "").padEnd(16)}  ${entry.version ?? ""}  ${entry.size} bytes`);
      return 0;
    }
    console.error(`nixamp sync: unknown action ${command}. Try status, save, load or revisions.`);
    return 64;
  } catch (error) {
    console.error(`nixamp: ${(error as Error).message}`);
    return 1;
  }
}

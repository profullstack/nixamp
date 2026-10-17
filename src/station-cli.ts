/**
 * `nixamp station`: stations from a terminal, a script or a cron job.
 *
 * Talks to the daemon on this machine with its control key, or to another
 * server with --url and --key, exactly as `nixamp admin` does. Every command
 * takes --json for a script; without it, a line a person can read. Exit codes
 * a script can branch on: 0 done, 1 the server said no (the reason and a
 * stable code are printed), 2 the command was wrong, 3 the server could not
 * be reached.
 *
 * Nothing here publishes as a side effect. `create` and `start` leave a
 * station private; `publish` is its own command and says on what basis.
 */
import { resolveTarget } from "./admin.ts";
import { readState } from "./daemon.ts";
import { KEY_HEADER } from "./share.ts";

import { USAGE } from "./station-usage.ts";

export { USAGE };

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

class Unreachable extends Error {}

export async function station(argv: string[]): Promise<number> {
  const [command, id] = argv;
  const json = has(argv, "--json");
  if (!command || command === "help" || has(argv, "--help")) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  let target;
  try {
    target = resolveTarget(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 3;
  }
  const headers: Record<string, string> = { "content-type": "application/json", ...(target.key ? { [KEY_HEADER]: target.key } : {}) };
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    let response: Response;
    try {
      response = await fetch(`${target.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new Unreachable(`could not reach ${target.url}: ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
    return { status: response.status, body: parsed };
  };
  const needId = (): string | null => {
    if (!id || id.startsWith("--")) {
      console.error(`nixamp station ${command} needs a station id. \`nixamp station list\` shows them.`);
      return null;
    }
    return id;
  };
  const show = (answer: Answer, line: (body: Record<string, unknown>) => string): number => {
    if (json) {
      console.log(JSON.stringify(answer.body, null, 2));
    } else if (answer.status < 400) {
      console.log(line(answer.body));
    }
    if (answer.status >= 400) {
      if (!json) console.error(`nixamp: ${String(answer.body["error"] ?? "refused")} (${String(answer.body["code"] ?? answer.status)})`);
      return 1;
    }
    return 0;
  };
  const describe = (station: Record<string, unknown>): string => {
    const links = (station["links"] ?? {}) as Record<string, string>;
    return [
      `${String(station["name"])}  [${String(station["id"])}]`,
      `  state       ${String(station["state"])} (wanted ${String(station["desired"])})`,
      `  visibility  ${String(station["visibility"])}${station["listed"] ? ", listed in the directory" : ""}`,
      `  rotation    ${station["shuffle"] ? "shuffle" : "in order"}${station["repeat"] ? ", repeating" : ", once"}; ${(station["items"] as unknown[] | undefined)?.length ?? 0} files at ${String(station["bitrate"])} kbps`,
      ...(station["error"] ? [`  problem     ${String(station["error"])}`] : []),
      ...((station["excluded"] as unknown[] | undefined)?.length ? [`  left out   ${(station["excluded"] as unknown[]).length} files (nixamp station retry)`] : []),
      ...(station["visibility"] !== "private" && links["page"] ? [`  listen      ${links["page"]}`] : []),
    ].join("\n");
  };

  try {
    switch (command) {
      case "list": {
        const answer = await call("GET", "/api/v1/stations?limit=200");
        return show(answer, (body) => {
          const all = (body["stations"] as Record<string, unknown>[] | undefined) ?? [];
          return all.length === 0 ? "No stations yet. nixamp station create --name NAME --folder PATH" : all.map(describe).join("\n\n");
        });
      }
      case "create": {
        const name = flag(argv, "--name");
        if (!name) {
          console.error("nixamp station create needs --name");
          return 2;
        }
        const items = flag(argv, "--items");
        let folder = flag(argv, "--folder");
        if (folder !== undefined) {
          // A path under the library is taken relative to it.
          const root = readState()?.source ?? "";
          if (root && folder.startsWith(root)) folder = folder.slice(root.length);
        }
        if (items === undefined && folder === undefined) {
          console.error("nixamp station create needs --folder PATH or --items 0,1,2");
          return 2;
        }
        const bitrate = flag(argv, "--bitrate");
        const answer = await call("POST", "/api/v1/stations", {
          name,
          ...(items !== undefined ? { items: items.split(",").map((one) => Number(one.trim())) } : { folder }),
          shuffle: has(argv, "--shuffle"),
          repeat: !has(argv, "--no-repeat"),
          ...(bitrate ? { bitrate: Number(bitrate) } : {}),
        });
        return show(answer, (body) => `Made (private, stopped):\n${describe(body["station"] as Record<string, unknown>)}`);
      }
      case "show":
      case "status": {
        const station = needId();
        if (!station) return 2;
        return show(await call("GET", `/api/v1/stations/${station}`), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "start":
      case "stop":
      case "skip":
      case "retry": {
        const station = needId();
        if (!station) return 2;
        return show(await call("POST", `/api/v1/stations/${station}/${command}`, {}), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "publish": {
        const station = needId();
        if (!station) return 2;
        const basis = flag(argv, "--basis");
        const unlisted = has(argv, "--unlisted");
        const access: Record<string, unknown> = {
          visibility: unlisted ? "unlisted" : "public",
          listed: !unlisted && !has(argv, "--no-list"),
          ...(basis ? { rights: { basis, note: flag(argv, "--note") ?? "" } } : {}),
        };
        return show(await call("POST", `/api/v1/stations/${station}/access`, access), (body) => describe(body["station"] as Record<string, unknown>));
      }
      case "unpublish": {
        const station = needId();
        if (!station) return 2;
        const access = has(argv, "--private") ? { visibility: "private" } : { listed: false };
        return show(await call("POST", `/api/v1/stations/${station}/access`, access), (body) => {
          const dropped = Number(body["dropped"] ?? 0);
          return `${describe(body["station"] as Record<string, unknown>)}${dropped ? `\n  ${dropped} listener(s) disconnected; old links no longer work.` : ""}`;
        });
      }
      case "link": {
        const station = needId();
        if (!station) return 2;
        const answer = has(argv, "--rotate")
          ? await call("POST", `/api/v1/stations/${station}/rotate-link`, {})
          : await call("GET", `/api/v1/stations/${station}`);
        return show(answer, (body) => {
          const links = ((body["station"] as Record<string, unknown>)["links"] ?? {}) as Record<string, string>;
          return [`page    ${links["page"]}`, `stream  ${links["stream"]}`, `m3u     ${links["m3u"]}`].join("\n");
        });
      }
      case "delete": {
        const station = needId();
        if (!station) return 2;
        return show(await call("DELETE", `/api/v1/stations/${station}`), () => `Deleted ${station}. Its files were not touched.`);
      }
      default:
        console.error(`nixamp station: no command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof Unreachable) {
      console.error(`nixamp: ${error.message}`);
      return 3;
    }
    throw error;
  }
}

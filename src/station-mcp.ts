/**
 * Stations as MCP tools: what `nixamp station` does, for an agent.
 *
 * The same API and the same rules as the CLI and the page. On this machine
 * the tools use the daemon's control key, which is what being on the machine
 * means; for another server they send this machine's nixamp.com session,
 * which the server accepts only if that account owns it. Publishing is its
 * own tool and asks for the basis, exactly as for a person.
 */
import { daemonUrl, readState } from "./daemon.ts";
import { readSession } from "./session.ts";
import { KEY_HEADER } from "./share.ts";

const STRING = { type: "string" } as const;
const ID = { ...STRING, description: "The station's id (10 characters), from station_list." };
const SERVER = { ...STRING, description: "A nixamp server's address; this machine's daemon when omitted." };

export const STATION_TOOLS = [
  {
    name: "station_list",
    description: "List this server's stations: id, name, state (live, stopped, offline...), visibility and listening link.",
    inputSchema: { type: "object", properties: { server: SERVER } },
  },
  {
    name: "station_get",
    description: "One station in full: files, rotation, state, any problem, and its links.",
    inputSchema: { type: "object", properties: { server: SERVER, id: ID }, required: ["id"] },
  },
  {
    name: "station_create",
    description: "Make a station from a folder in the library (path relative to it, \"\" for all of it) or from track indexes. It starts private and stopped; nothing is published.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        name: STRING,
        folder: { ...STRING, description: "A folder under the library, e.g. \"Albums/Late Night\"." },
        items: { type: "array", items: { type: "integer" }, description: "Track indexes, as /api/state lists them." },
        description: STRING,
        shuffle: { type: "boolean" },
        repeat: { type: "boolean", description: "Round and round (default) or once." },
        bitrate: { type: "integer", description: "kbps: 64, 96, 128 (default), 160, 192, 256 or 320." },
        idempotencyKey: { ...STRING, description: "Asking again with the same key returns the same station." },
      },
      required: ["name"],
    },
  },
  {
    name: "station_update",
    description: "Rename, describe, change files or rotation. Edits to the files land on the next track.",
    inputSchema: {
      type: "object",
      properties: { server: SERVER, id: ID, name: STRING, description: STRING, folder: STRING, items: { type: "array", items: { type: "integer" } }, shuffle: { type: "boolean" }, repeat: { type: "boolean" }, bitrate: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "station_control",
    description: "start, stop or skip a station, or retry the files it left out. Starting does not publish.",
    inputSchema: {
      type: "object",
      properties: { server: SERVER, id: ID, action: { type: "string", enum: ["start", "stop", "skip", "retry"] } },
      required: ["id", "action"],
    },
  },
  {
    name: "station_publish",
    description: "Make a station unlisted (a link) or public (and listed in the nixamp.com directory). Public needs the basis on which it may be broadcast: owned, permission, licensed or public-domain. A declaration, not legal clearance.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        id: ID,
        visibility: { type: "string", enum: ["unlisted", "public"] },
        listed: { type: "boolean", description: "In the directory (public only). Default true for public." },
        basis: { type: "string", enum: ["owned", "permission", "licensed", "public-domain"] },
        note: STRING,
      },
      required: ["id", "visibility"],
    },
  },
  {
    name: "station_unpublish",
    description: "Take a station out of the directory, or make it private: its links stop working and listeners are disconnected.",
    inputSchema: { type: "object", properties: { server: SERVER, id: ID, private: { type: "boolean" } }, required: ["id"] },
  },
];

interface Result {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const say = (value: string, isError = false): Result => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

export interface StationToolOptions {
  fetcher?: typeof fetch;
  /** Where the local daemon is and its key; the tests hand these in. */
  local?: { url: string; key: string | null } | null;
  session?: { site: string; token: string } | null;
}

/** Where to send a tool's request, and with which credential. */
export function connect(args: Record<string, unknown>, options: StationToolOptions): { base: string; headers: Record<string, string> } | { error: string } {
  const server = typeof args["server"] === "string" ? args["server"].replace(/\/+$/, "") : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (server === "") {
    const local = options.local === undefined ? (() => { const state = readState(); return state ? { url: daemonUrl(state), key: state.key } : null; })() : options.local;
    if (!local) return { error: "No nixamp daemon runs on this machine. Start one (nixamp daemon start ~/Music) or pass `server`." };
    if (local.key) headers[KEY_HEADER] = local.key;
    return { base: local.url, headers };
  }
  const session = options.session === undefined ? readSession() : options.session;
  if (!session) return { error: "Another server needs this machine signed in as its owner: nixamp login." };
  headers["authorization"] = `Bearer ${session.token}`;
  return { base: server, headers };
}

export function isStationTool(name: string): boolean {
  return STATION_TOOLS.some((tool) => tool.name === name);
}

function line(station: Record<string, unknown>): string {
  const links = (station["links"] ?? {}) as Record<string, string>;
  const problem = station["error"] ? `; problem: ${String(station["error"])}` : "";
  const link = station["visibility"] !== "private" && links["page"] ? `\n  listen: ${links["page"]}` : "";
  return `${String(station["name"])} [${String(station["id"])}] ${String(station["state"])}, ${String(station["visibility"])}${station["listed"] ? " and listed" : ""}${problem}${link}`;
}

export async function callStationTool(name: string, args: Record<string, unknown>, options: StationToolOptions = {}): Promise<Result> {
  const send = options.fetcher ?? fetch;
  const target = connect(args, options);
  if ("error" in target) return say(target.error, true);
  const { base, headers } = target;
  const id = typeof args["id"] === "string" ? args["id"] : "";
  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
    const response = await send(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, body: parsed };
  };
  const refused = (body: Record<string, unknown>): Result => say(`${String(body["error"] ?? "refused")} (${String(body["code"] ?? "error")})`, true);
  const pick = (keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));

  try {
    if (name === "station_list") {
      const answer = await call("GET", "/api/v1/stations?limit=200");
      if (!answer.ok) return refused(answer.body);
      const all = (answer.body["stations"] as Record<string, unknown>[] | undefined) ?? [];
      return say(all.length === 0 ? "No stations on this server yet." : all.map(line).join("\n"));
    }
    if (!/^[a-z0-9]{10}$/.test(id) && name !== "station_create") return say("Which station? Pass its id from station_list.", true);
    if (name === "station_get") {
      const answer = await call("GET", `/api/v1/stations/${id}`);
      return answer.ok ? say(JSON.stringify(answer.body["station"], null, 2)) : refused(answer.body);
    }
    if (name === "station_create") {
      const answer = await call("POST", "/api/v1/stations", pick(["name", "folder", "items", "description", "shuffle", "repeat", "bitrate", "idempotencyKey"]));
      return answer.ok ? say(`Made, private and stopped: ${line(answer.body["station"] as Record<string, unknown>)}`) : refused(answer.body);
    }
    if (name === "station_update") {
      const answer = await call("PATCH", `/api/v1/stations/${id}`, pick(["name", "description", "folder", "items", "shuffle", "repeat", "bitrate"]));
      return answer.ok ? say(line(answer.body["station"] as Record<string, unknown>)) : refused(answer.body);
    }
    if (name === "station_control") {
      const action = String(args["action"] ?? "");
      if (!["start", "stop", "skip", "retry"].includes(action)) return say("action is start, stop, skip or retry", true);
      const answer = await call("POST", `/api/v1/stations/${id}/${action}`, {});
      return answer.ok ? say(line(answer.body["station"] as Record<string, unknown>)) : refused(answer.body);
    }
    if (name === "station_publish") {
      const visibility = args["visibility"] === "public" ? "public" : "unlisted";
      const answer = await call("POST", `/api/v1/stations/${id}/access`, {
        visibility,
        listed: visibility === "public" && args["listed"] !== false,
        ...(typeof args["basis"] === "string" ? { rights: { basis: args["basis"], note: typeof args["note"] === "string" ? args["note"] : "" } } : {}),
      });
      return answer.ok ? say(line(answer.body["station"] as Record<string, unknown>)) : refused(answer.body);
    }
    if (name === "station_unpublish") {
      const answer = await call("POST", `/api/v1/stations/${id}/access`, args["private"] === true ? { visibility: "private" } : { listed: false });
      if (!answer.ok) return refused(answer.body);
      const dropped = Number(answer.body["dropped"] ?? 0);
      return say(`${line(answer.body["station"] as Record<string, unknown>)}${dropped ? `\n${dropped} listener(s) disconnected.` : ""}`);
    }
  } catch (error) {
    return say(`Could not reach ${base}: ${(error as Error).message}`, true);
  }
  return say(`No such tool: ${name}`, true);
}

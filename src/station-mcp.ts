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
    description: "Make a station from a folder in the library (path relative to it, \"\" for all of it), a playlist, or track indexes. It starts private and stopped; nothing is published.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        name: STRING,
        folder: { ...STRING, description: "A folder under the library, e.g. \"Albums/Late Night\"." },
        items: { type: "array", items: { type: "integer" }, description: "Track indexes, as /api/state lists them." },
        playlist: { ...STRING, description: "A playlist id (playlist_list): the station plays its ready items in order." },
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
    name: "station_auto",
    description: "A station for every genre in the library (radio from music tags, TV from film genres), kept up to date after every library scan, with a short break between songs and films. Unlisted; publishing stays a separate step. off: true stops the automation.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        video: { type: "boolean" }, minItems: { type: "integer" }, minFilms: { type: "integer" },
        maxVideoRunning: { type: "integer" }, breaksEvery: { type: "integer" }, start: { type: "boolean" }, off: { type: "boolean" },
      },
    },
  },
  {
    name: "station_ai",
    description: "AI radio: stations whose music is composed by AI (ElevenLabs Music or a local model) a few tracks a day, within a monthly budget of seconds. action status (default), create (preset lofi|synthwave|ambient|chiptune|punk|jazz, or name + style), generate (one track now), update, remove, budget (monthlySeconds), resume. A created station is public on the guide with basis owned unless publish is false.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        action: { type: "string", enum: ["status", "create", "generate", "update", "remove", "budget", "resume"] },
        key: { ...STRING, description: "The AI station's key (10 hex characters), from status." },
        preset: STRING, name: STRING, style: { ...STRING, description: "The music in words: genre, instruments, mood, tempo. Name no artist." },
        description: STRING, vocals: { type: "boolean" }, trackSeconds: { type: "integer" }, perDay: { type: "integer" },
        enabled: { type: "boolean" }, publish: { type: "boolean" }, monthlySeconds: { type: "integer" },
      },
    },
  },
  {
    name: "station_shares",
    description: "Listener shares: anybody may share an MP3 link or file from the public guide; AI files it under a genre and holds anything that looks like a commercial release. action status (default; waiting shares), list (state), configure (open, moderation ai|owner, publish, maxMb, perHour), approve, reject, delete.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        action: { type: "string", enum: ["status", "list", "configure", "approve", "reject", "delete"] },
        id: { ...STRING, description: "A share's id (12 hex characters)." },
        state: { type: "string", enum: ["held", "approved", "reported", "rejected", "failed", "withdrawn"] },
        reason: STRING,
        open: { type: "boolean" }, moderation: { type: "string", enum: ["ai", "owner"] }, publish: { type: "boolean" },
        maxMb: { type: "integer" }, perHour: { type: "integer" },
      },
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
    if (name === "station_auto") {
      const answer = await call("POST", "/api/v1/stations/auto", pick(["video", "minItems", "minFilms", "maxVideoRunning", "breaksEvery", "start", "off"]));
      return answer.ok ? say(JSON.stringify(answer.body["report"], null, 2)) : refused(answer.body);
    }
    if (name === "station_ai") {
      const action = String(args["action"] ?? "status");
      const key = typeof args["key"] === "string" && /^[a-f0-9]{10}$/.test(args["key"]) ? args["key"] : "";
      const fields = ["preset", "name", "style", "description", "vocals", "trackSeconds", "perDay", "enabled", "publish"];
      const answer = action === "status" ? await call("GET", "/api/v1/stations/ai")
        : action === "create" ? await call("POST", "/api/v1/stations/ai/stations", pick(fields))
        : action === "budget" ? await call("POST", "/api/v1/stations/ai", pick(["monthlySeconds"]))
        : action === "resume" ? await call("POST", "/api/v1/stations/ai", { resume: true })
        : !key ? null
        : action === "generate" ? await call("POST", `/api/v1/stations/ai/stations/${key}/generate`, {})
        : action === "update" ? await call("PATCH", `/api/v1/stations/ai/stations/${key}`, pick(fields))
        : action === "remove" ? await call("DELETE", `/api/v1/stations/ai/stations/${key}`)
        : undefined;
      if (answer === null) return say("Which AI station? Pass its key from action status.", true);
      if (answer === undefined) return say("action is status, create, generate, update, remove, budget or resume", true);
      return answer.ok ? say(JSON.stringify(answer.body, null, 2)) : refused(answer.body);
    }
    if (name === "station_shares") {
      const action = String(args["action"] ?? "status");
      const share = typeof args["id"] === "string" && /^[a-f0-9]{12}$/.test(args["id"]) ? args["id"] : "";
      const answer = action === "status" ? await call("GET", "/api/v1/stations/shares?state=held")
        : action === "list" ? await call("GET", `/api/v1/stations/shares${typeof args["state"] === "string" ? `?state=${encodeURIComponent(args["state"])}` : ""}`)
        : action === "configure" ? await call("POST", "/api/v1/stations/shares", pick(["open", "moderation", "publish", "maxMb", "perHour"]))
        : !share ? null
        : action === "approve" || action === "reject" ? await call("POST", `/api/v1/stations/shares/${share}/${action}`, pick(["reason"]))
        : action === "delete" ? await call("DELETE", `/api/v1/stations/shares/${share}`)
        : undefined;
      if (answer === null) return say("Which share? Pass its id from action status or list.", true);
      if (answer === undefined) return say("action is status, list, configure, approve, reject or delete", true);
      return answer.ok ? say(JSON.stringify(answer.body, null, 2)) : refused(answer.body);
    }
    if (!/^[a-z0-9]{10}$/.test(id) && name !== "station_create") return say("Which station? Pass its id from station_list.", true);
    if (name === "station_get") {
      const answer = await call("GET", `/api/v1/stations/${id}`);
      return answer.ok ? say(JSON.stringify(answer.body["station"], null, 2)) : refused(answer.body);
    }
    if (name === "station_create") {
      const answer = await call("POST", "/api/v1/stations", pick(["name", "folder", "items", "playlist", "description", "shuffle", "repeat", "bitrate", "idempotencyKey"]));
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

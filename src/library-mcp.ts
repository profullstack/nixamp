/**
 * The library as MCP tools: what is here, find something, look again.
 *
 * Same target and credential rules as the station tools (station-mcp.ts):
 * this machine's daemon by its control key, or another server as its owner.
 */
import { connect, type StationToolOptions } from "./station-mcp.ts";

const STRING = { type: "string" } as const;
const SERVER = { ...STRING, description: "A nixamp server's address; this machine's daemon when omitted." };

export const LIBRARY_TOOLS = [
  {
    name: "library_status",
    description: "How many items the library has in each state (ready, pending, failed, unsupported, unavailable), its sources, and their last scans.",
    inputSchema: { type: "object", properties: { server: SERVER } },
  },
  {
    name: "library_search",
    description: "Find items in the library by words (title, artist, album, genre, folder) and filters. Returns ids usable for stations (as track paths) and corrections.",
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER,
        q: STRING, artist: STRING, album: STRING, genre: STRING, folder: STRING,
        state: { type: "string", enum: ["ready", "pending", "failed", "unsupported", "unavailable", "all"] },
        limit: { type: "integer" }, offset: { type: "integer" },
      },
    },
  },
  {
    name: "library_browse",
    description: "The library grouped: every artist, album, genre or top-level folder, with counts.",
    inputSchema: {
      type: "object",
      properties: { server: SERVER, kind: { type: "string", enum: ["artists", "albums", "genres", "folders"] }, q: STRING, limit: { type: "integer" } },
      required: ["kind"],
    },
  },
  {
    name: "playlist_list",
    description: "This listener's playlists on the server: id, name, how many items.",
    inputSchema: { type: "object", properties: { server: SERVER } },
  },
  {
    name: "playlist_create",
    description: "A new playlist from library item ids (from library_search), in order. A playlist can then be a station: station_create with playlist.",
    inputSchema: { type: "object", properties: { server: SERVER, name: STRING, items: { type: "array", items: STRING } }, required: ["name"] },
  },
  {
    name: "playlist_add",
    description: "Add library items to a playlist, at the end or at a place.",
    inputSchema: { type: "object", properties: { server: SERVER, id: STRING, items: { type: "array", items: STRING }, at: { type: "integer" } }, required: ["id", "items"] },
  },
  {
    name: "library_scan",
    description: "Look at a source again: new files are read, changed ones re-read, gone ones marked unavailable. Returns a job id; library_status shows when it is done.",
    inputSchema: { type: "object", properties: { server: SERVER, source: STRING, force: { type: "boolean" } } },
  },
];

export function isLibraryTool(name: string): boolean {
  return LIBRARY_TOOLS.some((tool) => tool.name === name);
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const say = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export async function callLibraryTool(name: string, args: Record<string, unknown>, options: StationToolOptions = {}): Promise<Result> {
  const send = options.fetcher ?? fetch;
  const target = connect(args, options);
  if ("error" in target) return say(target.error, true);
  const get = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
    const response = await send(`${target.base}${path}`, { method, headers: target.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const refused = (body: Record<string, unknown>): Result => say(`${String(body["error"] ?? "refused")} (${String(body["code"] ?? "error")})`, true);
  try {
    if (name === "library_status") {
      const answer = await get("GET", "/api/v1/library");
      return answer.ok ? say(JSON.stringify(answer.body, null, 2)) : refused(answer.body);
    }
    if (name === "library_search") {
      const query = new URLSearchParams();
      for (const key of ["q", "artist", "album", "genre", "folder", "state"]) if (typeof args[key] === "string") query.set(key, args[key] as string);
      for (const key of ["limit", "offset"]) if (typeof args[key] === "number") query.set(key, String(args[key]));
      const answer = await get("GET", `/api/v1/library/items?${query}`);
      if (!answer.ok) return refused(answer.body);
      const items = (answer.body["items"] as Record<string, unknown>[]) ?? [];
      const lines = items.map((one) => `${String(one["id"])}  ${String(one["artist"] || "?")} — ${String(one["title"])}${one["album"] ? ` (${String(one["album"])})` : ""}  ${String(one["rel"])}`);
      return say(lines.length ? `${lines.join("\n")}\n${String(answer.body["total"])} in all` : "Nothing matches.");
    }
    if (name === "library_browse") {
      const kind = String(args["kind"] ?? "");
      const query = new URLSearchParams();
      if (typeof args["q"] === "string") query.set("q", args["q"]);
      if (typeof args["limit"] === "number") query.set("limit", String(args["limit"]));
      const answer = await get("GET", `/api/v1/library/browse/${encodeURIComponent(kind)}?${query}`);
      if (!answer.ok) return refused(answer.body);
      const groups = (answer.body["groups"] as Array<{ name: string; count: number; artist?: string }>) ?? [];
      return say(groups.map((one) => `${one.name}${one.artist ? ` — ${one.artist}` : ""} (${one.count})`).join("\n") || "Nothing yet.");
    }
    if (name === "playlist_list") {
      const answer = await get("GET", "/api/v1/library/playlists");
      if (!answer.ok) return refused(answer.body);
      const lists = (answer.body["playlists"] as Array<Record<string, unknown>>) ?? [];
      return say(lists.map((one) => `${String(one["id"])}  ${String(one["name"])} (${String(one["count"])})`).join("\n") || "No playlists yet.");
    }
    if (name === "playlist_create" || name === "playlist_add") {
      const answer = name === "playlist_create"
        ? await get("POST", "/api/v1/library/playlists", { name: args["name"], items: args["items"] ?? [] })
        : await get("POST", `/api/v1/library/playlists/${encodeURIComponent(String(args["id"] ?? ""))}/items`, { items: args["items"], ...(typeof args["at"] === "number" ? { at: args["at"] } : {}) });
      if (!answer.ok) return refused(answer.body);
      const list = answer.body["playlist"] as Record<string, unknown>;
      return say(`${String(list["id"])}  ${String(list["name"])}: ${String(list["count"])} items, revision ${String(list["revision"])}`);
    }
        if (name === "library_scan") {
      let source = typeof args["source"] === "string" ? args["source"] : "";
      if (!source) {
        const listed = await get("GET", "/api/v1/library/sources");
        const all = (listed.body["sources"] as Record<string, unknown>[]) ?? [];
        if (all.length !== 1) return say("Which source? library_status lists them.", true);
        source = String(all[0]!["id"]);
      }
      const answer = await get("POST", `/api/v1/library/sources/${source}/scan`, { force: args["force"] === true });
      return answer.ok ? say(`Scanning; job ${String((answer.body["job"] as Record<string, unknown>)["jobId"])}.`) : refused(answer.body);
    }
  } catch (error) {
    return say(`Could not reach ${target.base}: ${(error as Error).message}`, true);
  }
  return say(`No such tool: ${name}`, true);
}

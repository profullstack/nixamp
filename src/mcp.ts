/**
 * `nixamp mcp` -- nixamp as a tool an agent can use.
 *
 * The Model Context Protocol is JSON-RPC 2.0 over a pipe: one message per
 * line on stdin, one per line on stdout. That is the whole transport, which
 * is why this needs no dependency -- adding an SDK to a CLI that is packed
 * into a tarball and run under node would cost more than it saves.
 *
 * What it offers is the watch party, because that is the part of nixamp an
 * agent can usefully do something with: find the party, say where it is, put
 * one on the air, move everybody to the same second. It signs in as whoever
 * this machine is signed in as -- the session on disk, or NIXAMP_TOKEN --
 * because an agent holding its own credential is a credential nobody revokes.
 *
 * Anything written to stdout that is not a response corrupts the stream, so
 * every diagnostic goes to stderr. That is the one rule of this file.
 */
import { createInterface } from "node:readline";
import { clock, type PartyRow } from "./party.ts";
import { readSession } from "./session.ts";

export const PROTOCOL_VERSION = "2025-06-18";

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const STRING = { type: "string" } as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: "watch_parties_list",
    description:
      "List the watch parties on right now that this account could join. Each one is a room on nixamp bridged from the site hosting the film (bittorrented.com, for instance), with where playback has got to.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { ...STRING, description: "Only parties bridged by this client, e.g. bittorrented." },
        limit: { type: "integer", description: "At most this many (default 30)." },
      },
    },
  },
  {
    name: "watch_party_get",
    description:
      "One watch party, by the code the hosting site shows, or by its nixamp room id or slug. Answers where the film is now, the link to watch it, and the nixamp room link.",
    inputSchema: {
      type: "object",
      properties: { code: { ...STRING, description: "The party code, room id or slug." } },
      required: ["code"],
    },
  },
  {
    name: "watch_party_host",
    description:
      "Put a watch party on the air as a nixamp room, so it is joinable from every nixamp client. Idempotent: calling it again for a party that is already bridged updates it rather than making a second room.",
    inputSchema: {
      type: "object",
      properties: {
        code: { ...STRING, description: "The party code on the hosting site." },
        title: { ...STRING, description: "What to call the room." },
        partyUrl: { ...STRING, description: "Where to watch it on the hosting site." },
        mediaTitle: { ...STRING, description: "What is playing." },
        visibility: { ...STRING, description: "public, unlisted (default) or private." },
      },
      required: ["code"],
    },
  },
  {
    name: "watch_party_sync",
    description:
      "Say where playback is, so everybody joining lands on the same second. Only the host of the party may do this.",
    inputSchema: {
      type: "object",
      properties: {
        code: STRING,
        positionSeconds: { type: "number", description: "Seconds into the film." },
        playing: { type: "boolean", description: "False if it is paused (default true)." },
      },
      required: ["code", "positionSeconds"],
    },
  },
  {
    name: "watch_party_end",
    description: "End a watch party. Only its host may.",
    inputSchema: { type: "object", properties: { code: STRING }, required: ["code"] },
  },
];

export interface McpOptions {
  fetcher?: typeof fetch;
  /** Injected by the tests; the session on disk otherwise. */
  session?: { site: string; token: string } | null;
  say?: (line: string) => void;
}

/** A tool answer, in the shape MCP wants: content blocks, and a flag for failure. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failed(value: string): ToolResult {
  return { content: [{ type: "text", text: value }], isError: true };
}

function describe(row: PartyRow): string {
  return [
    `${row.party.partyCode} — ${row.event.title}${row.host ? " (this account is the host)" : ""}`,
    `${row.party.playing ? "playing" : "paused"} at ${clock(row.party.positionNow)}${row.party.mediaTitle ? `, ${row.party.mediaTitle}` : ""}`,
    `bridged from ${row.party.origin}; event ${row.event.id} is ${row.event.status}, ${row.event.visibility}`,
    `watch: ${row.links.partyUrl || row.links.nixampUrl}`,
    `nixamp room: ${row.links.nixampUrl}`,
  ].join("\n");
}

/**
 * Run one tool. Separate from the transport so it can be tested without a
 * pipe, and so the same call is reachable from anywhere else that wants it.
 */
export async function callTool(name: string, args: Record<string, unknown>, options: McpOptions = {}): Promise<ToolResult> {
  const session = options.session === undefined ? readSession() : options.session;
  if (!session) {
    return failed("This machine is not signed in to nixamp. Run `nixamp login`, or set NIXAMP_TOKEN.");
  }
  const send = options.fetcher ?? fetch;
  const site = session.site.replace(/\/+$/, "");
  const where = `${site}/api/v1/watch-parties`;
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const code = typeof args["code"] === "string" ? args["code"] : "";

  const answerOf = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `nixamp answered ${response.status}`;
  };

  try {
    if (name === "watch_parties_list") {
      const url = new URL(where);
      if (typeof args["origin"] === "string" && args["origin"]) url.searchParams.set("origin", args["origin"]);
      if (typeof args["limit"] === "number") url.searchParams.set("limit", String(args["limit"]));
      const response = await send(url.toString(), { headers });
      if (!response.ok) return failed(await answerOf(response));
      const body = (await response.json()) as { parties?: PartyRow[] };
      const rows = body.parties ?? [];
      return text(rows.length === 0 ? "No watch parties are on right now." : rows.map(describe).join("\n\n"));
    }

    if (name === "watch_party_get") {
      if (!code) return failed("Which party? Pass the code the hosting site shows.");
      const response = await send(`${where}/${encodeURIComponent(code)}`, { headers });
      if (!response.ok) return failed(await answerOf(response));
      return text(describe((await response.json()) as PartyRow));
    }

    if (name === "watch_party_host") {
      if (!code) return failed("Which party? Pass the code the hosting site shows.");
      const response = await send(where, {
        method: "POST",
        headers,
        body: JSON.stringify({
          partyCode: code,
          ...(typeof args["title"] === "string" ? { title: args["title"] } : {}),
          ...(typeof args["partyUrl"] === "string" ? { partyUrl: args["partyUrl"] } : {}),
          ...(typeof args["mediaTitle"] === "string" ? { mediaTitle: args["mediaTitle"] } : {}),
          ...(typeof args["visibility"] === "string" ? { visibility: args["visibility"] } : {}),
        }),
      });
      if (!response.ok) return failed(await answerOf(response));
      return text(describe((await response.json()) as PartyRow));
    }

    if (name === "watch_party_sync") {
      if (!code) return failed("Which party?");
      const at = args["positionSeconds"];
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
        return failed("positionSeconds must be a number of seconds into the film.");
      }
      const response = await send(`${where}/${encodeURIComponent(code)}/playback`, {
        method: "POST",
        headers,
        body: JSON.stringify({ positionSeconds: at, playing: args["playing"] !== false }),
      });
      if (!response.ok) return failed(await answerOf(response));
      return text(describe((await response.json()) as PartyRow));
    }

    if (name === "watch_party_end") {
      if (!code) return failed("Which party?");
      const response = await send(`${where}/${encodeURIComponent(code)}/end`, { method: "POST", headers });
      if (!response.ok) return failed(await answerOf(response));
      return text(`Ended ${code}.`);
    }
  } catch (error) {
    return failed(`Could not reach ${site}: ${(error as Error).message}`);
  }
  return failed(`No such tool: ${name}`);
}

/** One JSON-RPC message in, one answer out -- or null for a notification. */
export async function handleMessage(message: Request, options: McpOptions = {}): Promise<Record<string, unknown> | null> {
  const id = message.id ?? null;
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });

  if (message.method === "initialize") {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nixamp", title: "nixamp watch parties", version: "1" },
      instructions:
        "Watch parties on nixamp. A party lives on the site hosting the film and is bridged here as a room every nixamp client can join. Codes are the ones that site shows; positions are seconds into the film.",
    });
  }
  // Notifications carry no id and are answered with silence, which is what
  // the protocol means by one: replying to notifications/initialized with a
  // result whose id is null is the mistake that hangs a client.
  if (message.id === undefined || message.id === null) {
    if (message.method.startsWith("notifications/")) return null;
  }
  if (message.method === "tools/list") return reply({ tools: TOOLS });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/call") {
    const name = String(message.params?.["name"] ?? "");
    const args = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((tool) => tool.name === name)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `no such tool: ${name}` } };
    }
    return reply(await callTool(name, args, options));
  }
  if (id === null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${message.method}` } };
}

/** The stdio server. Resolves when stdin closes, which is how a client stops it. */
export async function mcp(options: McpOptions = {}): Promise<number> {
  const out = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const lines = createInterface({ input: process.stdin });
  // Ordered on purpose: a client may send initialize and tools/list without
  // waiting, and answering out of order is a client that never sees the
  // tools. Each message is finished before the next is begun.
  let chain: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    chain = chain.then(async () => {
      let message: Request;
      try {
        message = JSON.parse(trimmed) as Request;
      } catch {
        out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      try {
        const answer = await handleMessage(message, options);
        if (answer) out(answer);
      } catch (error) {
        out({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: (error as Error).message },
        });
      }
    });
  });
  await new Promise<void>((done) => lines.on("close", () => void chain.then(done)));
  return 0;
}

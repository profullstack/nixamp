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
 * one on the air, move everybody to the same second. And the room: hear a
 * recording (nixamp.com's own ear, see speech.ts), say a line in a trollbox,
 * read one back. It signs in as whoever
 * this machine is signed in as -- the session on disk, or NIXAMP_TOKEN --
 * because an agent holding its own credential is a credential nobody revokes.
 *
 * Anything written to stdout that is not a response corrupts the stream, so
 * every diagnostic goes to stderr. That is the one rule of this file.
 */
import { createInterface } from "node:readline";
import { clock, type PartyRow } from "./party.ts";
import { readSession } from "./session.ts";
import { askToHear, wavOf } from "./transcribe.ts";
import { readTranscript } from "./transcript.ts";
import { personaLines, readPersona, readVoices, writePersona } from "./profile.ts";

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
  {
    name: "transcribe_audio",
    description:
      "The words in a recording on this machine, heard by nixamp.com's own open-source ear (Whisper). Any format ffmpeg reads; up to a minute. Given a server, the words are also posted to that server's trollbox as this account.",
    inputSchema: {
      type: "object",
      properties: {
        path: { ...STRING, description: "The recording's path on this machine." },
        language: { ...STRING, description: "A two-letter language code, when Whisper should not guess." },
        server: { ...STRING, description: "Post the words to this nixamp's trollbox: its address, as in its share link." },
        channel: { ...STRING, description: "Which of that server's channels; its own stream (live) by default." },
      },
      required: ["path"],
    },
  },
  {
    name: "trollbox_say",
    description:
      "Say a line in a live room's trollbox, as this account and under its public handle. A room is a nixamp server's address and one of its channels (or `live`, the server's own stream).",
    inputSchema: {
      type: "object",
      properties: {
        server: { ...STRING, description: "The nixamp server's address, as in its share link." },
        channel: { ...STRING, description: "The channel's id, or live (default)." },
        text: { ...STRING, description: "The line. At most 500 characters." },
      },
      required: ["server", "text"],
    },
  },
  {
    name: "transcript_read",
    description:
      "What a live channel is saying: the recent lines of its transcript, oldest first, each with when its sound was heard. The server carrying the channel captions it while somebody asks. Pass the server's address and share key, and the channel's id.",
    inputSchema: {
      type: "object",
      properties: {
        url: { ...STRING, description: "The nixamp server's address, e.g. https://server1.chovy.nixamp.com:4321." },
        key: { ...STRING, description: "The share key from its link, when it has one." },
        channel: { ...STRING, description: "The channel's id on that server (default: main)." },
        after: { type: "number", description: "Only lines heard after this moment (ms since the epoch)." },
      },
      required: ["url"],
    },
  },
  {
    name: "profile_get",
    description: "Who the rooms know this account as: its handle, the voice its trollbox lines are read in on the phone, the OpenProfile URL, and the voice that would be used right now.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "profile_set",
    description:
      "Set this account's handle, the voice its lines are read in on the phone (female, male, any, or a voice id from voices_list), and/or its OpenProfile URL (whose Voice, Gender or Pronouns pick the voice when none is set). Any one may be given alone.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { ...STRING, description: "Letters, digits and hyphens, 2 to 30 characters." },
        voice: { ...STRING, description: "female, male, any, or a voice id such as ElevenLabs.pNInz6obpgDQGcFmaJgB." },
        profile: { ...STRING, description: "The URL of an OpenProfile.md, or an empty string to clear it." },
      },
    },
  },
  {
    name: "voices_list",
    description: "The voices trollbox lines can be read in on the phone: the provider in use and the women's and men's voice ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "trollbox_read",
    description: "The recent lines in a live room's trollbox, oldest first: who said what, and when.",
    inputSchema: {
      type: "object",
      properties: {
        server: { ...STRING, description: "The nixamp server's address, as in its share link." },
        channel: { ...STRING, description: "The channel's id, or live (default)." },
        after: { ...STRING, description: "Only lines after this moment (an ISO timestamp)." },
      },
      required: ["server"],
    },
  },
];

interface TrollboxLine {
  id: string;
  handle: string;
  body: string;
  createdAt: string;
}

function said(line: TrollboxLine): string {
  return `${line.createdAt}  ${line.handle}: ${line.body}`;
}

export interface McpOptions {
  fetcher?: typeof fetch;
  /** Injected by the tests; the session on disk otherwise. */
  session?: { site: string; token: string } | null;
  /** How a recording becomes a WAV; the tests hand in a fake. */
  wavOf?: typeof wavOf;
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

    const server = typeof args["server"] === "string" ? args["server"].trim() : "";
    const channel = typeof args["channel"] === "string" && args["channel"].trim() ? args["channel"].trim() : "live";

    if (name === "transcribe_audio") {
      const path = typeof args["path"] === "string" ? args["path"] : "";
      if (!path) return failed("Which recording? Pass its path.");
      let wav: Uint8Array;
      try {
        wav = (options.wavOf ?? wavOf)(path);
      } catch (error) {
        return failed((error as Error).message);
      }
      const answer = await askToHear(session, {
        wav,
        ...(typeof args["language"] === "string" ? { language: args["language"] } : {}),
        ...(server ? { server, channel } : {}),
      }, send, site);
      if (!answer.ok) return failed(answer.error);
      if (answer.heard.text === "") return text("Heard nothing in that recording.");
      return text(answer.heard.message
        ? `${answer.heard.text}\n\nSaid in the room for ${channel} at ${server} as ${answer.heard.message.handle}.`
        : answer.heard.text);
    }

    if (name === "trollbox_say") {
      if (!server) return failed("Which room? Pass the server's address.");
      const line = typeof args["text"] === "string" ? args["text"] : "";
      if (!line.trim()) return failed("Say what? Pass the text.");
      const response = await send(`${site}/api/v1/trollbox`, {
        method: "POST",
        headers,
        body: JSON.stringify({ server, channel, body: line }),
      });
      if (!response.ok) return failed(await answerOf(response));
      const body = (await response.json()) as { message?: TrollboxLine };
      return text(body.message ? `Said, as ${body.message.handle}: ${body.message.body}` : "Said.");
    }

    if (name === "transcript_read") {
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (!url) return failed("Which server? Pass its address.");
      const got = await readTranscript(
        { url, key: typeof args["key"] === "string" && args["key"] ? args["key"] : null },
        channel === "live" ? "main" : channel,
        typeof args["after"] === "number" ? args["after"] : 0,
        send,
      );
      if (!got.ok) return failed(got.error);
      if (got.answer.recent.length === 0) {
        return text(got.answer.error
          ? `Nothing yet: ${got.answer.error}`
          : "Nothing said yet. The server has just started listening; ask again in a few seconds.");
      }
      return text(got.answer.recent.map((line) => `${new Date(line.at).toISOString()}  ${line.text}`).join("\n"));
    }

    if (name === "profile_get") {
      const answer = await readPersona(session, send);
      if (!answer.ok) return failed(answer.error);
      return text(personaLines(answer.body).join("\n"));
    }

    if (name === "profile_set") {
      const wanted: { handle?: string; voice?: string; profile?: string } = {};
      if (typeof args["handle"] === "string") wanted.handle = args["handle"];
      if (typeof args["voice"] === "string") wanted.voice = args["voice"];
      if (typeof args["profile"] === "string") wanted.profile = args["profile"];
      if (Object.keys(wanted).length === 0) return failed("Set what? Pass handle, voice and/or profile.");
      const answer = await writePersona(session, wanted, send);
      if (!answer.ok) return failed(answer.error);
      return text(personaLines(answer.body).join("\n"));
    }

    if (name === "voices_list") {
      const answer = await readVoices(session, send);
      if (!answer.ok) return failed(answer.error);
      return text([`Voices: ${answer.body.provider}.`, "Women:", ...answer.body.female.map((one) => `  ${one}`), "Men:", ...answer.body.male.map((one) => `  ${one}`)].join("\n"));
    }

    if (name === "trollbox_read") {
      if (!server) return failed("Which room? Pass the server's address.");
      const url = new URL(`${site}/api/v1/trollbox`);
      url.searchParams.set("server", server);
      url.searchParams.set("channel", channel);
      if (typeof args["after"] === "string" && args["after"]) url.searchParams.set("after", args["after"]);
      const response = await send(url.toString(), { headers });
      if (!response.ok) return failed(await answerOf(response));
      const body = (await response.json()) as { messages?: TrollboxLine[] };
      const lines = body.messages ?? [];
      return text(lines.length === 0 ? `Nobody has said anything in the room for ${channel} at ${server}.` : lines.map(said).join("\n"));
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
      serverInfo: { name: "nixamp", title: "nixamp: watch parties and rooms", version: "1" },
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

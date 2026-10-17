/**
 * The station directory as MCP tools anybody may use: what is on, anywhere.
 *
 * nixamp.com's guide lists every public, listed station on every server in
 * its directory (each server is asked for its own guide). These tools read
 * that list, so an agent with no account and no nixamp installed can find a
 * station and hand somebody its link, and can share a track to a server that
 * takes listener shares -- the same as the guide's form, with the same
 * declaration. Nothing here changes a station; that is the owner's, with the
 * owner's tools.
 */

const STRING = { type: "string" } as const;

export const PUBLIC_TOOLS = [
  {
    name: "stations_list",
    description: "Every public station on nixamp, on any server: name, radio or TV, group (ai, shared, radio, tv), whether it is live, what is playing, and the link to watch or listen. No sign-in needed.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["audio", "video"], description: "Only radio (audio) or only TV (video)." },
        group: { type: "string", enum: ["ai", "shared", "radio", "tv"] },
      },
    },
  },
  {
    name: "station_find",
    description: "Find public nixamp stations whose name, or what is playing, matches the words given (e.g. \"data structures\", \"lofi\", \"jazz\"). Returns each match with its link.",
    inputSchema: { type: "object", properties: { query: { ...STRING, description: "Words to look for." } }, required: ["query"] },
  },
  {
    name: "station_share",
    description: "Share a music file by its link with the server a station is on, for its listener-share stations. The sharer must have the right to have it broadcast and say on what basis; AI files it under a genre and checks it before it airs. Returns a status link.",
    inputSchema: {
      type: "object",
      properties: {
        station: { ...STRING, description: "A station's link or id from stations_list: the track goes to that station's server." },
        url: { ...STRING, description: "A direct link to the MP3 (or OGG, FLAC, M4A, WAV)." },
        basis: { type: "string", enum: ["owned", "permission", "licensed", "creative-commons", "public-domain"] },
        note: { ...STRING, description: "Licence, credit, a link to the artist." },
        by: { ...STRING, description: "A name to credit the sharer with." },
        agree: { type: "boolean", description: "true: the sharer has the right to share this for broadcast." },
      },
      required: ["station", "url", "basis", "agree"],
    },
  },
] as const;

export function isPublicTool(name: string): boolean {
  return PUBLIC_TOOLS.some((tool) => tool.name === name);
}

interface Entry {
  id?: string;
  name: string;
  kind: string;
  group?: string;
  state: string;
  page: string;
  nowPlaying: { title?: string; artist?: string } | null;
}

export interface PublicToolOptions {
  /** The guide's stations; nixamp.com's own list by default. */
  guide?: () => Promise<unknown[]>;
  fetcher?: typeof fetch;
  site?: string;
}

const say = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

async function stations(options: PublicToolOptions): Promise<Entry[]> {
  const raw = options.guide
    ? await options.guide()
    : await (async () => {
        const answer = await (options.fetcher ?? fetch)(`${(options.site ?? "https://nixamp.com").replace(/\/+$/, "")}/api/v1/stations/guide`, { signal: AbortSignal.timeout(15_000) });
        if (!answer.ok) throw new Error(`the guide answered HTTP ${answer.status}`);
        return ((await answer.json()) as { stations?: unknown[] }).stations ?? [];
      })();
  return raw.filter((one): one is Entry => typeof one === "object" && one !== null && typeof (one as Entry).name === "string" && typeof (one as Entry).page === "string");
}

function line(one: Entry): string {
  const now = one.nowPlaying && (one.nowPlaying.title || one.nowPlaying.artist) ? ` — now: ${[one.nowPlaying.title, one.nowPlaying.artist].filter(Boolean).join(" — ")}` : "";
  return `${one.name} [${one.kind === "video" ? "TV" : "radio"}${one.group ? `, ${one.group}` : ""}] ${one.state === "live" ? "LIVE" : one.state}${now}\n  ${one.page}`;
}

export async function callPublicTool(name: string, args: Record<string, unknown>, options: PublicToolOptions = {}) {
  try {
    const all = await stations(options);
    if (name === "stations_list") {
      const shown = all.filter((one) => (!args["kind"] || one.kind === args["kind"]) && (!args["group"] || one.group === args["group"]));
      return say(shown.length ? shown.map(line).join("\n") : "No public stations match.");
    }
    if (name === "station_find") {
      const words = String(args["query"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return say("Say what to look for.", true);
      const hay = (one: Entry): string => [one.name, one.nowPlaying?.title, one.nowPlaying?.artist, one.group, one.kind === "video" ? "tv video" : "radio audio"].join(" ").toLowerCase();
      const found = all.filter((one) => words.every((word) => hay(one).includes(word)));
      return say(found.length ? found.map(line).join("\n") : `No public station matches "${String(args["query"])}". stations_list shows them all.`);
    }
    if (name === "station_share") {
      const wanted = String(args["station"] ?? "");
      const station = all.find((one) => one.page === wanted || one.id === wanted || (wanted && one.page.includes(`/station/${wanted}`)));
      if (!station) return say("Which station? Pass a link or id from stations_list.", true);
      const origin = new URL(station.page).origin;
      const answer = await (options.fetcher ?? fetch)(`${origin}/api/v1/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: args["url"], basis: args["basis"], note: args["note"] ?? "", by: args["by"] ?? "", agree: args["agree"] === true }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
      if (!answer.ok) return say(`${String(body["error"] ?? `HTTP ${answer.status}`)} (${String(body["code"] ?? answer.status)})`, true);
      return say(`Shared. It is being fetched and checked now; how it goes: ${origin}${String(body["status"])}`);
    }
    return say(`No such tool: ${name}`, true);
  } catch (error) {
    return say(`Could not read the station guide: ${(error as Error).message}`, true);
  }
}

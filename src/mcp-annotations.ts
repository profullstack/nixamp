/**
 * Titles and behaviour hints for every MCP tool nixamp and backtoschool.help
 * serve (MCP 2025-06-18 `title` + `annotations`).
 *
 * The Claude connectors directory and ChatGPT apps both refuse a server whose
 * tools do not say, each, whether they only read, whether they can destroy
 * something, and whether they reach outside nixamp. Kept in one table rather
 * than on each definition so the five tool files stay as they are and a test
 * can check that no tool is left out.
 *
 *   r  readOnlyHint      nothing changes
 *   d  destructiveHint   something can be deleted, ended or taken down
 *   o  openWorldHint     talks to something outside nixamp's own data
 *                        (another site, a payment, the public, an AI provider)
 */
interface Hints {
  title: string;
  r: boolean;
  d: boolean;
  o: boolean;
}

const HINTS: Record<string, Hints> = {
  // watch parties, rooms, transcripts (mcp.ts)
  watch_parties_list: { title: "List watch parties", r: true, d: false, o: false },
  watch_party_get: { title: "Get a watch party", r: true, d: false, o: false },
  watch_party_host: { title: "Host a watch party", r: false, d: false, o: true },
  watch_party_sync: { title: "Sync watch party playback", r: false, d: false, o: false },
  watch_party_end: { title: "End a watch party", r: false, d: true, o: false },
  transcribe_audio: { title: "Transcribe audio", r: false, d: false, o: true },
  transcript_get: { title: "Get a transcript", r: true, d: false, o: false },
  media_hash: { title: "Hash a media file", r: true, d: false, o: true },
  media_get: { title: "Look up a media file", r: true, d: false, o: false },
  transcripts_list: { title: "List my transcripts", r: true, d: false, o: false },
  translate_text: { title: "Translate text", r: false, d: false, o: true },
  trollbox_say: { title: "Say something in a room", r: false, d: false, o: true },
  transcript_read: { title: "Read a transcript", r: true, d: false, o: false },
  profile_get: { title: "Get my room profile", r: true, d: false, o: false },
  profile_set: { title: "Set my room profile", r: false, d: false, o: false },
  voices_list: { title: "List trollbox voices", r: true, d: false, o: false },
  trollbox_read: { title: "Read a room's trollbox", r: true, d: false, o: false },
  music_catalog: { title: "Browse the AI label catalogue", r: true, d: false, o: true },
  music_buy: { title: "Buy AI label music", r: false, d: false, o: true },
  music_purchases: { title: "List my music purchases", r: true, d: false, o: false },
  // stations on a server you run (station-mcp.ts)
  station_list: { title: "List my stations", r: true, d: false, o: false },
  station_get: { title: "Get a station", r: true, d: false, o: false },
  station_create: { title: "Create a station", r: false, d: false, o: false },
  station_update: { title: "Update a station", r: false, d: false, o: false },
  station_control: { title: "Start, stop or skip a station", r: false, d: false, o: false },
  station_publish: { title: "Publish a station", r: false, d: false, o: true },
  station_auto: { title: "Manage genre stations", r: false, d: false, o: false },
  station_ai: { title: "Manage AI radio", r: false, d: false, o: true },
  station_label: { title: "Manage the AI label", r: false, d: true, o: true },
  station_shares: { title: "Review listener shares", r: false, d: true, o: false },
  station_holders: { title: "Manage copyright holders", r: false, d: true, o: false },
  station_unpublish: { title: "Unpublish a station", r: false, d: true, o: true },
  // the public directory (directory-mcp.ts)
  stations_list: { title: "List public stations", r: true, d: false, o: true },
  station_find: { title: "Find public stations", r: true, d: false, o: true },
  station_share: { title: "Share a track with a station", r: false, d: false, o: true },
  // the library on a server you run (library-mcp.ts)
  library_status: { title: "Library status", r: true, d: false, o: false },
  library_search: { title: "Search the library", r: true, d: false, o: false },
  library_browse: { title: "Browse the library", r: true, d: false, o: false },
  playlist_list: { title: "List playlists", r: true, d: false, o: false },
  playlist_create: { title: "Create a playlist", r: false, d: false, o: false },
  playlist_add: { title: "Add to a playlist", r: false, d: false, o: false },
  library_scan: { title: "Rescan a library source", r: false, d: false, o: false },
  // backtoschool.help classes (school-mcp.ts)
  classes_list: { title: "List classes", r: true, d: false, o: false },
  class_get: { title: "Get a class", r: true, d: false, o: false },
  class_teach: { title: "Teach a class now", r: false, d: false, o: true },
  class_create: { title: "Create a class", r: false, d: false, o: false },
  class_update: { title: "Update a class", r: false, d: false, o: false },
  class_start: { title: "Start a class", r: false, d: false, o: true },
  class_end: { title: "End a class", r: false, d: true, o: false },
  class_delete: { title: "Delete a class", r: false, d: true, o: false },
  classes_check: { title: "Check my live classes", r: true, d: false, o: false },
};

/** Tool names with no entry, for the test that keeps the table complete. */
export function unannotated(tools: ReadonlyArray<{ name: string }>): string[] {
  return tools.map((tool) => tool.name).filter((name) => !(name in HINTS));
}

/** The tools as tools/list answers them: each with a title and its hints. */
export function annotate<T extends { name: string }>(tools: ReadonlyArray<T>): Array<T & { title: string; annotations: Record<string, unknown> }> {
  return tools.map((tool) => {
    const hints = HINTS[tool.name];
    const title = hints?.title ?? tool.name;
    return {
      ...tool,
      title,
      annotations: {
        title,
        readOnlyHint: hints?.r ?? false,
        destructiveHint: hints?.d ?? true,
        idempotentHint: false,
        openWorldHint: hints?.o ?? true,
      },
    };
  });
}

/**
 * The cache fields Claude Code's MCP client requires on every list result
 * (all three; one missing rejects the whole list as "tools fetch failed").
 */
export const LIST_CACHE = { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } as const;

/** A tools/list result: annotated tools plus the cache fields. */
export function toolsListResult(tools: ReadonlyArray<{ name: string }>, scope: "public" | "private" = "private"): Record<string, unknown> {
  return { tools: annotate(tools), ...LIST_CACHE, cacheScope: scope };
}

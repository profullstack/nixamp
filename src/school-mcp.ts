/**
 * backtoschool.help classes as MCP tools: what `nixamp school` does, for an agent.
 *
 * Reading what is on needs nobody; making, starting, ending and deleting a
 * class needs the token the rest of nixamp uses, because a class is a live
 * event on the same accounts. `class_teach` is the one-call path from a
 * station link (station_list / station_create) to a class on the air.
 */
import {
  broadcastHealth, checkClasses, classUrl, createClass, deleteClass, getClass, listClasses, moveClass, teach, updateClass,
  type SchoolClass, type SchoolOptions,
} from "./school-client.ts";

const STRING = { type: "string" } as const;
const SLUG = { ...STRING, description: "The class's slug, id, or its backtoschool.help/live/<slug> link." };
const BROADCAST = { ...STRING, description: "What plays: a nixamp station link (https://<server>.nixamp.com:4321/station/<id>?t=<token>), a nixamp.com share link, a Pairux room, or an https .m3u8/.mp4/.mp3 URL." };
const FIELDS = {
  title: STRING,
  description: STRING,
  topic: STRING,
  visibility: { type: "string", enum: ["public", "unlisted", "private"] },
  startsAt: { ...STRING, description: "ISO 8601; leave out to start now (class_teach) or keep it a draft (class_create)." },
  chatEnabled: { type: "boolean" },
  handRaiseEnabled: { type: "boolean" },
} as const;

export const SCHOOL_PUBLIC_TOOLS = [
  {
    name: "classes_list",
    description: "Classes on backtoschool.help: live now, scheduled, drafts or ended. Each with its link, status and what it broadcasts. No sign-in needed (mine=true needs one).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "scheduled", "starting", "live", "encore", "ended", "cancelled", "archived"] },
        mine: { type: "boolean", description: "Only the classes this account hosts." },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "class_get",
    description: "One class in full, and whether its broadcast is playing right now.",
    inputSchema: { type: "object", properties: { slug: SLUG }, required: ["slug"] },
  },
];

export const SCHOOL_TOOLS = [
  ...SCHOOL_PUBLIC_TOOLS,
  {
    name: "class_teach",
    description: "Make a class of a broadcast and put it on the air now: the one call from a station link to a live class. Returns the class link.",
    inputSchema: { type: "object", properties: { broadcastUrl: BROADCAST, ...FIELDS }, required: ["title", "broadcastUrl"] },
  },
  {
    name: "class_create",
    description: "Make a class without starting it: a draft, or scheduled when startsAt is given.",
    inputSchema: { type: "object", properties: { broadcastUrl: BROADCAST, ...FIELDS }, required: ["title"] },
  },
  {
    name: "class_update",
    description: "Change a class you host: title, description, topic, broadcast, visibility, time, chat or raised hands.",
    inputSchema: { type: "object", properties: { slug: SLUG, broadcastUrl: BROADCAST, ...FIELDS }, required: ["slug"] },
  },
  {
    name: "class_start",
    description: "Put a class you host on the air.",
    inputSchema: { type: "object", properties: { slug: SLUG }, required: ["slug"] },
  },
  {
    name: "class_end",
    description: "End a class you host. It stays listed as ended; a repeating class schedules its next session.",
    inputSchema: { type: "object", properties: { slug: SLUG }, required: ["slug"] },
  },
  {
    name: "class_delete",
    description: "Delete a class you host, for good.",
    inputSchema: { type: "object", properties: { slug: SLUG }, required: ["slug"] },
  },
  {
    name: "classes_check",
    description: "Your live classes, each with whether its broadcast still plays. A class stays live until ended, so this finds the ones showing a dead player; end or delete those.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function isSchoolTool(name: string): boolean {
  return SCHOOL_TOOLS.some((tool) => tool.name === name);
}

export function isSchoolPublicTool(name: string): boolean {
  return SCHOOL_PUBLIC_TOOLS.some((tool) => tool.name === name);
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const say = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

function line(item: SchoolClass, options: SchoolOptions): string {
  return `${item.status.padEnd(9)} ${item.title}\n  ${classUrl(item, options)}${item.broadcastUrl ? `\n  plays ${item.broadcastUrl}` : ""}`;
}

function fieldsOf(args: Record<string, unknown>): Record<string, unknown> {
  const keys = ["title", "description", "topic", "visibility", "startsAt", "chatEnabled", "handRaiseEnabled", "broadcastUrl"];
  return Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
}

export async function callSchoolTool(name: string, args: Record<string, unknown>, options: SchoolOptions = {}): Promise<Result> {
  const slug = typeof args["slug"] === "string" ? args["slug"] : "";
  try {
    if (name === "classes_list") {
      const items = await listClasses({
        ...(typeof args["status"] === "string" ? { status: args["status"] } : {}),
        ...(args["mine"] === true ? { mine: true } : {}),
        ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      }, options);
      return say(items.length ? items.map((one) => line(one, options)).join("\n\n") : "No classes match.");
    }
    if (name === "classes_check") {
      const checked = await checkClasses(options);
      if (checked.length === 0) return say("You have no live classes.");
      return say(checked.map(({ item, health }) => `${health.ok === true ? "plays " : health.ok === false ? "BROKEN" : "unknown"}  ${item.slug}: ${health.reason}`).join("\n"));
    }
    if (!slug && name !== "class_teach" && name !== "class_create") return say("Which class? Pass its slug (classes_list).", true);
    if (name === "class_get") {
      const item = await getClass(slug, options);
      const health = await broadcastHealth(item.broadcastUrl, options.fetcher ?? fetch);
      return say(`${JSON.stringify(item, null, 2)}\n\nbroadcast: ${health.ok === true ? "playing" : health.ok === false ? "NOT playing" : "unknown"} (${health.reason})`);
    }
    if (name === "class_teach") {
      const item = await teach(fieldsOf(args), options);
      return say(`On the air: ${classUrl(item, options)}`);
    }
    if (name === "class_create") {
      const item = await createClass(fieldsOf(args), options);
      return say(`Made (${item.status}): ${classUrl(item, options)}\nclass_start ${item.slug} puts it on the air.`);
    }
    if (name === "class_update") {
      const { slug: _slug, ...rest } = args;
      const item = await updateClass(slug, fieldsOf(rest), options);
      return say(line(item, options));
    }
    if (name === "class_start" || name === "class_end") {
      const item = await moveClass(slug, name === "class_start" ? "start" : "end", options);
      return say(line(item, options));
    }
    if (name === "class_delete") {
      await deleteClass(slug, options);
      return say(`Deleted ${slug}.`);
    }
  } catch (error) {
    return say((error as Error).message, true);
  }
  return say(`No such tool: ${name}`, true);
}

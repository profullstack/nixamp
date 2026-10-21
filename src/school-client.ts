/**
 * backtoschool.help as a client: its classes are nixamp's live events, served
 * by the same process on another host, so one nixamp token signs in to both.
 *
 * The CLI (school-cli.ts) and the MCP tools (school-mcp.ts) are both this
 * file; neither talks HTTP itself.
 *
 * `broadcastHealth` is the reason this exists as much as the CRUD: a class
 * stays "live" until somebody ends it, long after the channel it points at
 * was stopped, and the page then shows a player that never plays. It asks the
 * broadcast itself, with only what the public link already carries.
 */
import { readSession } from "./session.ts";

export const SCHOOL_SITE = "https://backtoschool.help";

type Fetcher = typeof fetch;

export interface SchoolOptions {
  /** backtoschool.help unless NIXAMP_SCHOOL_URL says otherwise; the tests hand in a local server. */
  site?: string;
  /** The session on disk (or NIXAMP_TOKEN) unless given; null means signed out. */
  token?: string | null;
  fetcher?: Fetcher;
}

export interface SchoolClass {
  id: string;
  slug: string;
  title: string;
  status: string;
  visibility: string;
  kind: string;
  version: number;
  ownerId: string;
  broadcastUrl?: string | null;
  description?: string;
  topic?: string;
  hostName?: string;
  startsAt?: string | null;
  [key: string]: unknown;
}

export class SchoolError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export function schoolSite(options: SchoolOptions = {}): string {
  return (options.site ?? process.env["NIXAMP_SCHOOL_URL"] ?? SCHOOL_SITE).replace(/\/+$/, "");
}

export function classUrl(item: Pick<SchoolClass, "slug">, options: SchoolOptions = {}): string {
  return `${schoolSite(options)}/live/${item.slug}`;
}

function tokenOf(options: SchoolOptions): string | null {
  if (options.token !== undefined) return options.token;
  return readSession()?.token ?? null;
}

async function call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}, options: SchoolOptions = {}): Promise<Record<string, unknown>> {
  const token = tokenOf(options);
  if (init.auth && !token) throw new SchoolError("Not signed in. Run `nixamp login`, or set NIXAMP_TOKEN.", 401);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await (options.fetcher ?? fetch)(`${schoolSite(options)}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new SchoolError(String(body["error"] ?? `backtoschool.help answered ${response.status}`), response.status);
  return body;
}

const eventOf = (body: Record<string, unknown>): SchoolClass => (body["event"] ?? body) as SchoolClass;
const ref = (value: string): string => encodeURIComponent(value.replace(/^.*\/live\//, "").replace(/[?#].*$/, ""));

export async function listClasses(query: { status?: string; kind?: string; mine?: boolean; limit?: number } = {}, options: SchoolOptions = {}): Promise<SchoolClass[]> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.kind) params.set("kind", query.kind);
  if (query.mine) params.set("mine", "true");
  params.set("limit", String(query.limit ?? 60));
  const body = await call(`/api/v1/events?${params}`, { auth: query.mine === true }, options);
  return (body["events"] as SchoolClass[]) ?? [];
}

/** A class by its slug, id, or the /live/<slug> link. */
export async function getClass(slug: string, options: SchoolOptions = {}): Promise<SchoolClass> {
  return eventOf(await call(`/api/v1/events/${ref(slug)}`, {}, options));
}

export async function createClass(input: Record<string, unknown>, options: SchoolOptions = {}): Promise<SchoolClass> {
  return eventOf(await call("/api/v1/events", { method: "POST", body: { kind: "class", visibility: "public", ...input }, auth: true }, options));
}

export async function updateClass(slug: string, patch: Record<string, unknown>, options: SchoolOptions = {}): Promise<SchoolClass> {
  const current = await getClass(slug, options);
  return eventOf(await call(`/api/v1/events/${ref(current.id)}`, { method: "PATCH", body: { ...patch, version: current.version }, auth: true }, options));
}

/** start, end, doors, encore, cancel or archive. Each wants the version it saw, so it is read first. */
export async function moveClass(slug: string, action: "start" | "end" | "doors" | "encore" | "cancel" | "archive", options: SchoolOptions = {}): Promise<SchoolClass> {
  const current = await getClass(slug, options);
  return eventOf(await call(`/api/v1/events/${ref(current.id)}/${action}`, { method: "POST", body: { version: current.version }, auth: true }, options));
}

export async function deleteClass(slug: string, options: SchoolOptions = {}): Promise<void> {
  await call(`/api/v1/events/${ref(slug)}`, { method: "DELETE", auth: true }, options);
}

/** Make a class of a broadcast and put it on the air in one go. */
export async function teach(input: Record<string, unknown>, options: SchoolOptions = {}): Promise<SchoolClass> {
  const made = await createClass(input, options);
  return moveClass(made.slug, "start", options);
}

export interface Health {
  ok: boolean | null;
  reason: string;
}

/**
 * Does this broadcast play? true and false are answers; null is "cannot tell
 * from here" (a Pairux room), which a prune must leave alone.
 */
export async function broadcastHealth(link: string | null | undefined, fetcher: Fetcher = fetch, timeoutMs = 8000): Promise<Health> {
  if (!link) return { ok: false, reason: "no broadcast link" };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, reason: "not a link" };
  }
  const get = (target: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetcher(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
  try {
    // A station page: its own token opens its state.
    const station = /^\/station\/([a-z0-9]{10})\/?$/.exec(url.pathname)?.[1];
    if (station && url.hostname.endsWith(".nixamp.com")) {
      const response = await get(`${url.origin}/api/v1/stations/${station}/state?t=${encodeURIComponent(url.searchParams.get("t") ?? "")}`);
      if (!response.ok) return { ok: false, reason: `station ${station} answered ${response.status}` };
      const state = (await response.json()) as { state?: string };
      return state.state === "live" ? { ok: true, reason: `station ${station} is live` } : { ok: false, reason: `station ${station} is ${state.state ?? "not live"}` };
    }
    // nixamp.com/?url=<server>/view/<listen key>&play=channel:<id>: the listen key reads the server's channels.
    if ((url.hostname === "nixamp.com" || url.hostname === "www.nixamp.com") && url.searchParams.get("url")) {
      const server = new URL(url.searchParams.get("url")!);
      const key = /\/view\/([^/?#]+)/.exec(server.pathname)?.[1] ?? "";
      const play = url.searchParams.get("play") ?? "live";
      const response = await get(`${server.origin}/api/streams?k=${encodeURIComponent(key)}`);
      if (!response.ok) return { ok: false, reason: `${server.host} answered ${response.status}` };
      const streams = (await response.json()) as { server?: { live?: boolean }; channels?: Array<{ id: string }> };
      if (play.startsWith("channel:")) {
        const id = play.slice("channel:".length);
        return (streams.channels ?? []).some((one) => one.id === id)
          ? { ok: true, reason: `channel ${id} is on ${server.hostname}` }
          : { ok: false, reason: `channel ${id} is no longer on ${server.hostname}` };
      }
      if (play === "live") return streams.server?.live ? { ok: true, reason: `${server.hostname} is live` } : { ok: false, reason: `${server.hostname} is not live` };
      return { ok: true, reason: `${server.hostname} is up` };
    }
    if (url.hostname === "pairux.com" || url.hostname === "www.pairux.com") return { ok: null, reason: "a Pairux room; cannot tell from here" };
    // Direct media: one byte is enough to know it is there.
    const response = await get(url.href, { range: "bytes=0-0" });
    return response.ok ? { ok: true, reason: `${url.hostname} serves it` } : { ok: false, reason: `${url.hostname} answered ${response.status}` };
  } catch (error) {
    return { ok: false, reason: `unreachable: ${(error as Error).message}` };
  }
}

/** Your live classes, each with whether its broadcast plays. */
export async function checkClasses(options: SchoolOptions = {}, status = "live"): Promise<Array<{ item: SchoolClass; health: Health }>> {
  const items = await listClasses({ mine: true, status }, options);
  return Promise.all(items.map(async (item) => ({ item, health: await broadcastHealth(item.broadcastUrl, options.fetcher ?? fetch) })));
}

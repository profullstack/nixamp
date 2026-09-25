/**
 * Naming a join link by asking the server it points at.
 *
 * A link preview is read before any script runs, so the shell has to say what
 * is on the air. When the linked server is in this directory, its listing says
 * so and joinSubject answers from that. When it is not — somebody's own nixamp,
 * shared directly — there was nothing to say and the card fell back to the
 * site's generic title.
 *
 * The rule that produced that fallback is worth keeping: a name taken from the
 * query string would let whoever wrote the link choose how the card reads on
 * somebody else's domain, which is a phishing primitive rather than a feature.
 * So the name is not taken from the query. It is fetched from the server the
 * link points at, which can only describe itself.
 *
 * The share key travels in the link, and a server that is key-gated answers
 * only with it. Using it here grants nothing new: whoever holds the link
 * already holds the key.
 */

/** What /api/streams says about itself. Only the parts this file reads. */
interface StreamsAnswer {
  server?: { name?: unknown };
  channels?: { id?: unknown; name?: unknown; art?: unknown; kind?: unknown }[];
}

/** What a join card needs, matching joinSubject's shape. */
export interface RemoteSubject {
  title: string;
  where: string;
  image?: string;
  kind?: "audio" | "video";
}

/**
 * How long to wait for a server to name itself.
 *
 * This runs before the page is sent, so it is a budget for somebody waiting on
 * a tab to open. A server that is slow, asleep or gone simply does not name the
 * card, which is exactly what happened before this existed.
 */
const TIMEOUT_MS = 1200;

/**
 * How long an answer is reused.
 *
 * A link shared into a busy channel is fetched once per crawler that unfurls
 * it, and they arrive together. A minute is long enough to collapse that into
 * one request and short enough that renaming a channel shows up while somebody
 * is still looking at it.
 */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; subject: RemoteSubject | null }>();

/**
 * Hosts a server must never be asked to fetch.
 *
 * The address comes from the query string, so without this the page is a probe
 * anyone can point at anything this machine can reach — a cloud metadata
 * endpoint, a database admin port, a service on the loopback interface. The
 * cost of being wrong here is not a bad preview, it is an open proxy.
 */
function isPubliclyRoutable(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  // IPv6 loopback and the unique-local / link-local ranges.
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return false;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // link-local, and AWS metadata
    if (a >= 224) return false; // multicast and reserved
  }
  return true;
}

/** The share key a link carries, from /view/<key> or ?k=. */
export function keyFromLink(link: URL): string {
  const viewed = /^\/view\/([^/]+)\/?$/.exec(link.pathname);
  if (viewed?.[1]) return decodeURIComponent(viewed[1]);
  return link.searchParams.get("k") ?? "";
}

/**
 * Ask the linked server what it is called, and what the wanted channel is
 * called on it.
 *
 * Returns null for every failure — an unreachable server, a refusal, a shape
 * that is not what we expect, an address we will not fetch. The caller then
 * renders the generic shell, which is what it did before.
 */
export async function remoteSubject(
  linkHref: string,
  wantedChannel: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RemoteSubject | null> {
  let link: URL;
  try {
    link = new URL(linkHref);
  } catch {
    return null;
  }

  // https only. An http link from an https page is blockable mixed content in
  // the browser anyway, and fetching it here would be the one part of the
  // journey that was not protected.
  if (link.protocol !== "https:") return null;
  if (!isPubliclyRoutable(link.hostname)) return null;

  const key = keyFromLink(link);
  const cacheKey = `${link.origin}|${key}|${wantedChannel}`;
  const now = deps.now ?? Date.now;
  const hit = cache.get(cacheKey);
  if (hit && now() - hit.at < TTL_MS) return hit.subject;

  const doFetch = deps.fetchImpl ?? fetch;
  let subject: RemoteSubject | null = null;

  try {
    const asked = new URL("/api/streams", link.origin);
    if (key !== "") asked.searchParams.set("k", key);
    const answer = await doFetch(asked.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (answer.ok) {
      const body = (await answer.json()) as StreamsAnswer;
      const where = typeof body.server?.name === "string" ? body.server.name : "";
      const channels = Array.isArray(body.channels) ? body.channels : [];
      const found = wantedChannel === ""
        ? undefined
        : channels.find((one) => one.id === wantedChannel || one.name === wantedChannel);

      if (found && typeof found.name === "string" && found.name !== "") {
        subject = {
          title: found.name,
          where,
          ...(typeof found.art === "string" && found.art !== "" ? { image: found.art } : {}),
          ...(found.kind === "audio" || found.kind === "video" ? { kind: found.kind } : {}),
        };
      } else if (wantedChannel === "" && where !== "") {
        // No channel asked for: the server itself is the subject.
        subject = { title: where, where: "" };
      }
    }
  } catch {
    // Unreachable, refused, timed out, or not JSON. All the same answer.
    subject = null;
  }

  // Failures are cached too, deliberately: a server that is down should not be
  // re-asked by every crawler unfurling the same link in the same minute.
  cache.set(cacheKey, { at: now(), subject });
  return subject;
}

/** Testing seam: the cache outlives a request by design. */
export function __clearRemoteSubjectCache(): void {
  cache.clear();
}

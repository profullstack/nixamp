import {
  adsUnlessEntitled,
  type AdBreakOptions,
  type AdCreative,
  type EntitlementLike,
} from "@profullstack/player";

/**
 * Adverts for listeners who are not paying.
 *
 * nixamp is a music player, so the creative is normally an MP3 and plays with
 * no picture: the artwork stays where it is and only a badge sits over it.
 *
 * Nothing here decides entitlement beyond the obvious case. A listener with no
 * session cannot be a paying one, which is the only claim this can make safely
 * on its own; when the host knows better it says so through `paid`.
 */

/** How often a break comes round. ?adsEvery= overrides it for a quick test. */
const DEFAULT_EVERY_SECONDS = 300;

/**
 * Where a break gets filled from.
 *
 * crawlproof runs the auction, meters the impression and answers with one file
 * to play, exactly as it does for a banner. Asking it per break rather than
 * carrying a URL is the difference between an advert that is counted and one
 * that is not: a hardcoded file plays for nobody's campaign and bills nobody.
 *
 * An unfilled break comes back as `{url: null}`, which is a perfectly good
 * answer: no advert, the listener keeps their music.
 */
const AD_SERVER = "https://crawlproof.com/api/ads/stream";

/** What an entitlement has to name for this listener to count as paying. */
const PRODUCT = "nixamp.pro";

/**
 * What this listener has paid for.
 *
 * nixamp has no OpenAccess client yet, so this endpoint does not exist and the
 * answer is "nothing" — which is correct, because there is no pass to hold.
 * Written as the real request rather than a stub so that the day the hub is
 * wired, adverts stop for subscribers without anything here changing.
 *
 * A miss is not an error. Signed out, no endpoint, no session: to this question
 * they all mean the same thing.
 */
async function heldEntitlements(): Promise<EntitlementLike[]> {
  try {
    const res = await fetch("/api/entitlements", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as EntitlementLike[] | { entitlements?: EntitlementLike[] };
    return Array.isArray(body) ? body : (body.entitlements ?? []);
  } catch {
    return [];
  }
}

/** nixamp.com's own inventory slot, format video_preroll_5s. */
const AD_SLOT = "7e0ea02c-c40f-4cdd-b4d3-93b2baca8f2c";

export interface AdSettings {
  /** True when this listener is paying. Adverts are suppressed for them. */
  paid?: boolean;
  /** Overridden by ?adsEvery= for testing. */
  everySeconds?: number;
  /** A different inventory slot, for a surface that is not nixamp.com. */
  slot?: string;
}

/**
 * Read the query string.
 *
 * Waiting five minutes to see whether a break fires is not a test anybody runs
 * twice, so `?adsEvery=20` shortens it and `?ads=0` turns them off. Both are
 * clamped: a query string must not be able to ask for an advert every second.
 */
function fromQuery(search: string): {
  enabled: boolean | null;
  everySeconds: number | null;
  adUrl: string | null;
  now: boolean;
} {
  const params = new URLSearchParams(search);
  const ads = params.get("ads");
  const every = Number(params.get("adsEvery"));
  const now = params.get("adNow");
  return {
    // Asking for one immediately is asking for adverts.
    enabled: now !== null ? true : ads === null ? null : ads !== "0" && ads !== "false",
    everySeconds: Number.isFinite(every) && every > 0 ? Math.min(3600, Math.max(5, every)) : null,
    adUrl: safeAdUrl(params.get("adUrl")),
    now: now !== null && now !== "0" && now !== "false",
  };
}

/** Whether ?adNow was asked for, read without building the whole settings object. */
export function adNowRequested(search = location.search): boolean {
  return fromQuery(search).now;
}

/** Only https, so the parameter cannot smuggle in a javascript: or data: URL. */
function safeAdUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, location.origin);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function adSettings(
  settings: AdSettings = {},
  search = location.search,
): Promise<AdBreakOptions | null> {
  const query = fromQuery(search);
  // ?ads=0 turns them off outright, for a demonstration that should not be
  // interrupted. Otherwise the shared rule decides, against OpenAccess.
  if (query.enabled === false) return null;

  const ads: AdBreakOptions = {
    everySeconds: query.everySeconds ?? settings.everySeconds ?? DEFAULT_EVERY_SECONDS,
    next: async (): Promise<AdCreative | null> => {
      // A creative named in the query string, so a break can be seen working
      // without a serving backend behind it. Same-origin or https only: this
      // must not become a way to make nixamp.com play an arbitrary javascript:
      // or data: URL at somebody.
      if (query.adUrl) return { url: query.adUrl };
      try {
        const url = `${AD_SERVER}?slot=${encodeURIComponent(settings.slot ?? AD_SLOT)}&kind=video`;
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) return null;
        const body = (await res.json()) as { url?: string | null; kind?: "audio" | "video" };
        return body.url ? { url: body.url, kind: body.kind } : null;
      } catch {
        // A break nobody can fill is a break that does not happen. The listener
        // keeps their music either way.
        return null;
      }
    },
    onError: (error) => console.warn("advert failed", error),
  };

  // ?ads=1 is for demonstrating the break on an account that may well be
  // paying, so it skips the question.
  if (query.enabled === true) return ads;
  // A caller that already knows this listener is paying has answered it.
  if (settings.paid === true) return null;
  // Otherwise OpenAccess decides, which is the same rule every player uses.
  return adsUnlessEntitled({ product: PRODUCT, entitlements: heldEntitlements, ads });
}

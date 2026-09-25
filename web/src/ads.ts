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

/**
 * How often a break comes round.
 *
 * Ten minutes, against a five second spot: a listener gives up about one
 * second in a hundred and twenty, which is the difference between a station
 * that carries advertising and one that is mostly advertising.
 *
 * Back from the ten seconds it was turned down to while the chain was being
 * watched. That is done: the fill, the audio at streaming level, the
 * entitlement check and the playback have all been seen working together, so
 * the reason for the short interval is gone. ?adsEvery= still overrides it for
 * the next time something needs watching.
 */
const DEFAULT_EVERY_SECONDS = 600;

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
 * Which kind of break to ask for.
 *
 * A radio station is audio and has nowhere to put a picture, so asking for
 * video hands a music listener a film to interrupt their music. The serving
 * side already understands the difference and will answer with the audible
 * companion when a creative has one; it just has to be asked the right
 * question.
 *
 * Decided per break rather than once, because nixamp swaps between audio and
 * video as the listener moves between a station and a film.
 */
function breakKind(): "audio" | "video" {
  const video = document.querySelector<HTMLVideoElement>("#video");
  const playing = video && !video.hidden && video.currentSrc && !video.paused;
  return playing ? "video" : "audio";
}

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

/**
 * Telling the network what the listener actually did.
 *
 * The break endpoint meters that an advert was CHOSEN. Only the player knows
 * whether it then ran, and the difference between those two numbers is the
 * whole question — an advert selected for a listener who never heard a second
 * of it is not an advert that played, and without this it is indistinguishable
 * from one that did.
 *
 * Reported with an image request rather than fetch or sendBeacon. It needs no
 * CORS preflight, it survives the page being torn down, and it is the same
 * pixel the network's own units use, so there is one endpoint and one
 * definition of "started" rather than two that drift.
 *
 * What is NOT reported here is quartiles. The player exposes the start and the
 * end of a break, not its progress, so a quarter-watched advert is honestly
 * unknown rather than guessed at from a timer. Reporting a midpoint we did not
 * observe would be worse than reporting nothing.
 */
type BreakReport = { decision: string; endpoint: string; url: string };

let current: BreakReport | null = null;

function report(type: string): void {
  if (!current) return;
  try {
    const q =
      `${current.endpoint}?d=${encodeURIComponent(current.decision)}` +
      `&t=${encodeURIComponent(type)}&s=player`;
    new Image().src = q;
  } catch {
    // A measurement we could not send is not the listener's problem.
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
        const url =
          `${AD_SERVER}?slot=${encodeURIComponent(settings.slot ?? AD_SLOT)}` +
          `&kind=${breakKind()}`;
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          url?: string | null;
          kind?: "audio" | "video";
          decisionId?: string | null;
          eventsUrl?: string | null;
        };
        if (!body.url) return null;
        // Kept so the break's outcome can be reported against the same
        // decision the network handed out. Null when the network could not
        // record one, which means measurement is off for this break and the
        // advert plays exactly as it would have.
        current =
          body.decisionId && body.eventsUrl
            ? { decision: body.decisionId, endpoint: body.eventsUrl, url: body.url }
            : null;
        return { url: body.url, kind: body.kind };
      } catch {
        // A break nobody can fill is a break that does not happen. The listener
        // keeps their music either way.
        return null;
      }
    },
    onBreakStart: (info) => {
      // Guard on the url: a break that started is only this decision's if it
      // is playing this decision's file.
      if (current && current.url !== info.url) current = null;
      report("start");
    },
    onBreakEnd: (info) => {
      // `skipped` is the listener choosing to leave; anything else reaching
      // the end is the advert having played through.
      report(info.skipped ? "abandon" : "complete");
      current = null;
    },
    onError: (error) => {
      report("error");
      current = null;
      console.warn("advert failed", error);
    },
  };

  // ?ads=1 is for demonstrating the break on an account that may well be
  // paying, so it skips the question.
  if (query.enabled === true) return ads;
  // A caller that already knows this listener is paying has answered it.
  if (settings.paid === true) return null;
  // Otherwise OpenAccess decides, which is the same rule every player uses.
  return adsUnlessEntitled({ product: PRODUCT, entitlements: heldEntitlements, ads });
}

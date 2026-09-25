// Where an advert for a break comes from.
//
// nixamp does not decide which advert plays, or record that it played. Both
// belong to the ad network: it runs the auction and meters the impression, and
// a second opinion here would be a second set of numbers. This module is a
// proxy with an opinion about failure, nothing more.
//
// The opinion is that a break nobody can fill does not happen. The player
// treats anything without a url as "no advert" and keeps playing music, which
// is the only behaviour worth defaulting to when the alternative is silence in
// somebody's ears.

/** The network's break endpoint. Overridable so a deployment can point elsewhere. */
const AD_ORIGIN = process.env.AD_ORIGIN ?? "https://crawlproof.com";

/**
 * This property's slot at the network.
 *
 * Without it there is nothing to ask about, and asking anyway would spend a
 * request per break to be told the same thing. Unset means adverts are off for
 * this deployment, which is the right default for somebody running nixamp on
 * their own machine: their listeners are themselves.
 */
const AD_SLOT = process.env.AD_SLOT ?? "";

/**
 * How long to wait.
 *
 * A break is a gap in the music, so the budget is what a listener will not
 * notice. Past it the advert is simply not worth having — the player falls back
 * to content, which is a better outcome than a pause while a third party thinks
 * about it.
 */
const TIMEOUT_MS = 1500;

export type Advert = { url: string; kind: "audio" | "video" } | { url: null };

/** No advert. The shape the player expects, not an error. */
const NONE: Advert = { url: null };

export async function nextAdvert(
  kindParam: string | null,
  deps: { fetchImpl?: typeof fetch; origin?: string; slot?: string } = {},
): Promise<Advert> {
  const slot = deps.slot ?? AD_SLOT;
  if (!slot) return NONE;

  // Audio unless a caller says otherwise. nixamp is a music player: the artwork
  // stays where it is and a video creative has nowhere to go.
  const kind = kindParam === "video" ? "video" : "audio";
  const doFetch = deps.fetchImpl ?? fetch;
  const origin = deps.origin ?? AD_ORIGIN;

  // AbortSignal.timeout rather than a race, so the socket is actually closed
  // rather than left running behind a promise nobody reads.
  try {
    const res = await doFetch(
      `${origin}/api/ads/stream?slot=${encodeURIComponent(slot)}&kind=${kind}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return NONE;

    const body = (await res.json()) as { url?: unknown; kind?: unknown };
    // Only https, and only a real string. This url is handed to a media element
    // in somebody's browser, so a javascript: or data: value arriving from the
    // network must not survive being proxied through here.
    if (typeof body.url !== "string") return NONE;
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return NONE;
    }
    if (parsed.protocol !== "https:") return NONE;

    return {
      url: parsed.toString(),
      kind: body.kind === "video" ? "video" : "audio",
    };
  } catch {
    // A timeout, a refused connection, malformed JSON. All the same answer.
    return NONE;
  }
}

/**
 * Does this name read as two sides playing each other?
 *
 * "NFL: Chiefs vs Bills", "Lakers @ Celtics", "Rangers at Celtic 19:45": a
 * fixture, which nichedb's sports collection keeps with a score. "Live at
 * Wembley" and "Dinner at Eight" are not, and a wrong score line under a
 * concert is worse than none.
 *
 * Shared by the server, which decides where to ask, and the browser, which
 * decides how to ask about a channel. No imports, so it bundles anywhere.
 */

/** A league or country before a colon: "NFL: ", "UK: ", "EPL - ". */
const PREFIX = /^[A-Za-z0-9 .&'-]{1,20}(?::|\s-)\s+/;
/** A trailing time, with or without am/pm and a zone: "19:45", "7:30 PM EDT", "(20:00)". */
const TIME = /(?:\s+|\s*[-|(]\s*)\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?:\s+[A-Z]{2,4})?\)?\s*$/i;
/** What sits between the two sides. "at" is the weakest of these and reads twice below. */
const APART = /\s+(?:vs\.?|v\.?|at|@)\s+/i;
/** A side that begins like this is a sentence, not a team. */
const NOT_A_TEAM = /^(?:the|a|an|live|tonight|recorded|filmed|concert|home|dinner|breakfast|lunch|midnight|night|one night|death|murder|meet me|panic|sunset|sunrise)\b/i;

function twoSides(text: string): boolean {
  // Twice: "Chiefs vs Bills - 7:30 PM EDT" has the dash and the time and the zone.
  const parts = text.replace(TIME, "").replace(TIME, "").trim().split(APART);
  if (parts.length !== 2) return false;
  return parts.every((side) => {
    const s = side.trim();
    return s.length >= 2 && s.length <= 48 && /[A-Za-z]/.test(s) && !NOT_A_TEAM.test(s);
  });
}

export function isMatchupName(name: string): boolean {
  const text = String(name ?? "").trim();
  if (text === "") return false;
  // With the league in front and without: "NFL: Chiefs vs Bills" reads either
  // way, and "Chiefs vs. Bills - 7:30 PM" must not lose its teams as a prefix.
  return twoSides(text.replace(PREFIX, "")) || twoSides(text);
}

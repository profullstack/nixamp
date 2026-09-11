/**
 * A television is a different room.
 *
 * On a Fire TV, Silk moves a pointer with the remote's ring and scrolls the
 * page when that pointer reaches an edge. What it cannot do is scroll a box
 * inside the page: a list with its own scrollbar shows its first nine rows
 * and stops, and the eighty folders on a real server are simply unreachable.
 * The same goes for every other set-top browser. So on a television the
 * lists give up their scrollbars and page with buttons instead, and the type
 * is sized for a screen three metres away.
 */

/**
 * Fire TV (Silk on an AFT* device), Android TV, Google TV, the Samsung and
 * LG and Sony sets, Roku, Chromecast, the consoles. Silk on a Fire tablet is
 * not a television, which is what the AFT check is for.
 */
const TELEVISION = /\bAFT\w*\b.*\bSilk\b|\bSilk\b.*\bAFT\w*\b|Android ?TV|Google ?TV|SMART-?TV|Tizen|Web0S|WebOS|BRAVIA|CrKey|Roku|Xbox|PlayStation|HbbTV|NetCast|VIDAA|Viera|AppleTV/i;

/**
 * Whether this page is on a television. `?tv=1` says so from any browser,
 * which is how it is looked at from a desk; `?tv=0` says the opposite.
 */
export function isTelevision(userAgent: string, search = ""): boolean {
  const forced = new URLSearchParams(search).get("tv");
  if (forced !== null) return forced !== "0" && forced !== "no" && forced !== "off";
  return TELEVISION.test(userAgent);
}

/** How many rows of a list are on screen at once. */
export function pageSize(television: boolean): number {
  return television ? 25 : 100;
}

/**
 * Which rows of `total` page `page` shows, with `page` pulled back into
 * range: a folder with three pages does not keep a fourth from the last one.
 */
export function pageWindow(total: number, page: number, size: number): { page: number; from: number; to: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  const from = at * size;
  return { page: at, from, to: Math.min(total, from + size), pages };
}

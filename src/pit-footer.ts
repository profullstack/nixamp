/**
 * The pit.world global footer (site name, search, ring, publish), fetched on
 * the server and appended as the last thing in <body> of the nixamp.com pages.
 *
 * A module-level cache: the last good copy is served, and one older than an
 * hour is refreshed in the background (3s timeout). A failed refresh keeps the
 * old copy; with no copy at all the page goes out unchanged, so pit.world being
 * down never breaks a page.
 */
const PIT_FOOTER_URL = "https://pit.world/snippets/footer.html?site=nixamp.com";
const MAX_AGE_MS = 60 * 60 * 1000;

let cached = "";
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

export function refreshPitFooter(): Promise<void> {
  inflight ??= fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      const text = res.ok ? await res.text() : "";
      if (!text.includes("data-pit-footer")) throw new Error(`pit footer: HTTP ${res.status}`);
      cached = text;
      fetchedAt = Date.now();
    })
    .catch(() => {
      fetchedAt = Date.now() - MAX_AGE_MS + 60_000; // try again in a minute
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The page with the footer before its last </body>, or the page unchanged. */
export function withPitFooter(page: string): string {
  if (Date.now() - fetchedAt > MAX_AGE_MS) void refreshPitFooter();
  if (!cached || page.includes("data-pit-footer")) return page;
  const at = page.lastIndexOf("</body>");
  return at < 0 ? page : page.slice(0, at) + cached + page.slice(at);
}

import { footerHtml, footerHtmlSync } from "@profullstack/footer";

const OPTIONS = {
  site: "https://nixamp.com/",
  since: 2026,
  tagline: "MIT License",
  links: [
    { label: "Code", href: "https://github.com/profullstack/nixamp" },
    { label: "r/nixamp", href: "https://www.reddit.com/r/nixamp" },
  ],
  builtIndieHref: "https://built.indie.pit.world/for?site=https://nixamp.com/",
  pwamartHref: "https://pwamart.com/for?site=https://nixamp.com/",
};

const REFRESH_MS = 15 * 60 * 1000;
let html = footerHtmlSync(OPTIONS);
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  inflight ??= footerHtml(OPTIONS)
    .then((value) => {
      html = value;
      fetchedAt = Date.now();
    })
    .catch(() => {
      fetchedAt = Date.now() - REFRESH_MS + 60_000;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Add the shared footer to Nixamp pages while avoiding a second copy in its app shell. */
export function withUniversalFooter(page: string): string {
  if (Date.now() - fetchedAt > REFRESH_MS) void refresh();
  if (page.includes("data-pfs-footer=")) return page;
  const at = page.lastIndexOf("</body>");
  return at < 0 ? page : page.slice(0, at) + html + page.slice(at);
}

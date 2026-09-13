import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WebSite {
  web: string;
  site: string;
}

/** Explicit origins only: a caller's Host header must never become an invite URL. */
export function webSitesFromEnv(value = process.env["NIXAMP_WEB_SITES"]): Map<string, WebSite> {
  const sites = new Map<string, WebSite>();
  if (!value) return sites;
  const entries: unknown = JSON.parse(value);
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("NIXAMP_WEB_SITES must map public origins to web directories");
  }
  for (const [origin, directory] of Object.entries(entries)) {
    const url = new URL(origin);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || typeof directory !== "string") {
      throw new Error(`Invalid web site: ${origin}`);
    }
    const web = resolve(directory);
    if (!existsSync(join(web, "index.html"))) throw new Error(`Missing web build: ${web}`);
    if (sites.has(url.host)) throw new Error(`Duplicate web host: ${url.host}`);
    sites.set(url.host, { web, site: url.origin });
  }
  return sites;
}

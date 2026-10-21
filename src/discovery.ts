/**
 * How an agent, a store or a person finds every way into nixamp from nixamp.com
 * alone: /llms.txt names the MCP servers, the API and the desktop downloads;
 * /openapi.json describes the API; /api/v1/health says it is up; /download is
 * the desktop app, and /download/<target> sends the browser straight to that
 * installer on the latest release.
 *
 * Only nixamp.com answers these (the server where accounts live). A home
 * server is somebody's own machine and has no business advertising itself.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const RELEASES = "https://github.com/profullstack/nixamp/releases";
const LATEST_API = "https://api.github.com/repos/profullstack/nixamp/releases/latest";

/** Each installer release.yml builds, by the address /download/<target> gives it. */
export const DESKTOP_TARGETS: ReadonlyArray<{ target: string; label: string; suffix: string }> = [
  { target: "mac-arm64", label: "macOS (Apple silicon)", suffix: "-mac-arm64.dmg" },
  { target: "mac-x64", label: "macOS (Intel)", suffix: "-mac-x64.dmg" },
  { target: "win-x64", label: "Windows (x64)", suffix: "-win-x64.exe" },
  { target: "win-arm64", label: "Windows (ARM)", suffix: "-win-arm64.exe" },
  { target: "linux-x64", label: "Linux AppImage (x86_64)", suffix: "-linux-x86_64.AppImage" },
  { target: "linux-arm64", label: "Linux AppImage (arm64)", suffix: "-linux-arm64.AppImage" },
  { target: "deb-amd64", label: "Debian/Ubuntu .deb (amd64)", suffix: "-linux-amd64.deb" },
  { target: "deb-arm64", label: "Debian/Ubuntu .deb (arm64)", suffix: "-linux-arm64.deb" },
];

export const DISCOVERY_PATHS = new Set(["/llms.txt", "/openapi.json", "/api/v1/health", "/download"]);
export const isDiscoveryPath = (path: string): boolean => DISCOVERY_PATHS.has(path) || /^\/download\/[a-z0-9-]{1,20}$/.test(path);

export interface ReleaseAsset { name: string; browser_download_url: string }
export interface Release { tag_name: string; assets: ReleaseAsset[] }

/** The installer for `target` among a release's files, or null when that build is missing. */
export function desktopAsset(release: Release | null, target: string): string | null {
  const spec = DESKTOP_TARGETS.find((one) => one.target === target);
  if (!spec || !release) return null;
  return release.assets.find((asset) => asset.name.startsWith("nixamp-") && asset.name.endsWith(spec.suffix))?.browser_download_url ?? null;
}

/**
 * The latest published release, asked of GitHub at most every ten minutes. A
 * failed ask keeps the last answer; with none, the downloads fall back to the
 * releases page, which is never wrong, only one click longer.
 */
export function latestRelease(fetcher: typeof fetch = fetch, now: () => number = Date.now): () => Promise<Release | null> {
  let kept: { at: number; release: Release | null } = { at: -Infinity, release: null };
  return async () => {
    if (now() - kept.at < 10 * 60_000) return kept.release;
    try {
      const response = await fetcher(LATEST_API, { headers: { accept: "application/vnd.github+json", "user-agent": "nixamp.com" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as Release;
      kept = { at: now(), release: { tag_name: String(body.tag_name ?? ""), assets: Array.isArray(body.assets) ? body.assets : [] } };
    } catch {
      kept = { at: now(), release: kept.release };
    }
    return kept.release;
  };
}

export function llmsTxt(site: string): string {
  const desktop = DESKTOP_TARGETS.map((one) => `- ${one.label}: ${site}/download/${one.target}`).join("\n");
  return `# nixamp

> Broadcast live radio, television and film from your own machine. Open source streaming you run yourself: a terminal player, a web app (PWA) and a desktop app on one engine. Listen free, go live in one command, monetize with x402.

## Web app (PWA)
- ${site}/ : the player and remote, installable
- ${site}/music : AI music, live and on demand, installable on its own

## CLI
- Install: curl -fsSL ${site}/install.sh | sh
- Windows: irm ${site}/install.ps1 | iex
- npm: npx -y nixamp

## MCP
- Public, no account (stations, what is on, share a track): ${site}/mcp/public
- Signed in (watch parties, rooms, transcripts, music, your stations): ${site}/mcp , a nixamp token as the bearer (\`nixamp token create\`) or OAuth
- Local over stdio: npx -y nixamp mcp

## API
- OpenAPI: ${site}/openapi.json
- Base: ${site}/api/v1
- GET /api/v1/health
- GET /api/v1/music : the AI label's catalogue, every genre station, artist and album
- GET /api/v1/stations : public stations
- GET /api/v1/guide/rooms : live rooms
- GET /api/v1/guide/vods : films and shows on demand
- GET /api/directory : every nixamp server that is broadcasting
- GET /api/v1/auth/me : who the bearer token is
- POST /api/v1/auth/device/code : sign a CLI or agent in from a browser

## Desktop app
Downloads: ${site}/download
${desktop}
- Every release: ${RELEASES}
`;
}

const ok = { description: "OK", content: { "application/json": { schema: { type: "object" } } } };
const signedIn = { description: "Not signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const route = (summary: string, tags: string[], auth = false) => ({
  summary,
  tags,
  ...(auth ? { security: [{ bearer: [] }], responses: { 200: ok, 401: signedIn } } : { responses: { 200: ok } }),
});

/** The API as OpenAPI 3.1: what an agent can call on nixamp.com, and which calls want a token. */
export function openapiDocument(site: string, version: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "nixamp",
      version,
      description: "Live radio, television and film from your own machine. Public routes answer anybody; the rest want a nixamp token as the bearer (`nixamp token create`).",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: site }],
    externalDocs: { description: "llms.txt: MCP, CLI, desktop and API in one place", url: `${site}/llms.txt` },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A nixamp token (`nixamp token create`) or an OAuth access token." } },
      schemas: { Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] } },
    },
    paths: {
      "/api/v1/health": { get: route("Is nixamp.com up, and which version", ["meta"]) },
      "/api/directory": { get: route("Every nixamp server that is broadcasting", ["stations"]) },
      "/api/v1/stations": { get: route("Public stations", ["stations"]) },
      "/api/v1/guide/rooms": { get: route("Live rooms on the guide", ["stations"]) },
      "/api/v1/guide/vods": { get: route("Films and shows on demand", ["stations"]) },
      "/api/v1/opendirs": { get: route("Open directories nixamp has indexed", ["stations"]) },
      "/api/v1/music": { get: route("The AI label's catalogue: genre stations, artists, albums", ["music"]) },
      "/api/v1/auth/providers": { get: route("How you can sign in", ["auth"]) },
      "/api/v1/auth/device/code": { post: route("Start a device sign-in (CLI or agent); a person approves it in a browser", ["auth"]) },
      "/api/v1/auth/device/token": { post: route("Collect the token once the device sign-in is approved", ["auth"]) },
      "/api/v1/auth/me": { get: route("Who the bearer is", ["auth"], true) },
      "/api/v1/auth/tokens": { get: route("Your tokens", ["auth"], true), post: route("Make a token", ["auth"], true) },
      "/api/v1/follows": { get: route("Who you follow", ["social"], true) },
      "/api/v1/favorites": { get: route("Your favourite stations", ["social"], true) },
      "/api/v1/servers": { get: route("Your nixamp servers", ["servers"], true) },
      "/mcp/public": { post: route("MCP (streamable HTTP, JSON-RPC): the public station tools", ["mcp"]) },
      "/mcp": { post: route("MCP (streamable HTTP, JSON-RPC): every tool, as the bearer", ["mcp"], true) },
    },
  };
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one]!);

const STYLE = "body{margin:0;background:#080c09;color:#d8e6da;font:16px/1.5 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:28px;margin:0 0 4px}a{color:#7ee787}ul{padding:0;list-style:none}li{margin:10px 0}li a{display:block;padding:12px 14px;border:1px solid #1f2b22;border-radius:8px;text-decoration:none}li a:hover{border-color:#7ee787}code{background:#111a13;padding:2px 6px;border-radius:4px}.by{color:#8aa08e;margin:0 0 24px}";

export function downloadPage(site: string, release: Release | null): string {
  const tag = release?.tag_name ? ` ${escape(release.tag_name)}` : "";
  const items = DESKTOP_TARGETS.map((one) => `<li><a href="/download/${one.target}">${escape(one.label)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download the desktop app · nixamp</title><meta name="description" content="nixamp for macOS, Windows and Linux: the player, the radio console and a nixamp server in one app.">
<link rel="canonical" href="${escape(site)}/download"><link rel="icon" href="/favicon.png" type="image/png"><style>${STYLE}</style></head>
<body><main><h1>nixamp for your desktop</h1><p class="by">The player, the radio console and a nixamp server in one app${tag}.</p>
<ul>${items}</ul>
<p>Or in a terminal: <code>curl -fsSL ${escape(site)}/install.sh | sh</code></p>
<p><a href="/">Open the web app</a> · <a href="${RELEASES}">Every release</a> · <a href="/llms.txt">For agents</a></p></main></body></html>`;
}

export interface DiscoveryContext {
  site: string;
  version: string;
  release: () => Promise<Release | null>;
  json: (response: ServerResponse, code: number, body: unknown) => void;
}

function send(response: ServerResponse, code: number, type: string, body: string, method: string, extra: Record<string, string> = {}): void {
  response.writeHead(code, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": "public, max-age=300", "access-control-allow-origin": "*", ...extra });
  response.end(method === "HEAD" ? undefined : body);
}

/** Answers a discovery path; false when `path` is not one, so the caller carries on. */
export async function handleDiscovery(request: IncomingMessage, response: ServerResponse, path: string, ctx: DiscoveryContext): Promise<boolean> {
  if (!isDiscoveryPath(path)) return false;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return true;
  }
  const site = ctx.site.replace(/\/+$/, "");
  if (path === "/api/v1/health") {
    ctx.json(response, 200, { ok: true, name: "nixamp", version: ctx.version });
    return true;
  }
  if (path === "/llms.txt") {
    send(response, 200, "text/plain; charset=utf-8", llmsTxt(site), method);
    return true;
  }
  if (path === "/openapi.json") {
    send(response, 200, "application/json; charset=utf-8", JSON.stringify(openapiDocument(site, ctx.version), null, 2), method);
    return true;
  }
  if (path === "/download") {
    send(response, 200, "text/html; charset=utf-8", downloadPage(site, await ctx.release()), method, { "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
    return true;
  }
  const target = path.slice("/download/".length);
  if (!DESKTOP_TARGETS.some((one) => one.target === target)) {
    ctx.json(response, 404, { error: `no such download; one of ${DESKTOP_TARGETS.map((one) => one.target).join(", ")}` });
    return true;
  }
  // Short-lived: the next release moves it.
  response.writeHead(302, { location: desktopAsset(await ctx.release(), target) ?? `${RELEASES}/latest`, "cache-control": "public, max-age=300" });
  response.end();
  return true;
}

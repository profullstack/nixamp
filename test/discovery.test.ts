import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DESKTOP_TARGETS, RELEASES, desktopAsset, handleDiscovery, isDiscoveryPath, latestRelease, llmsTxt, openapiDocument, type Release,
} from "../src/discovery.ts";

const SITE = "https://nixamp.com";
const release: Release = {
  tag_name: "v0.63.3",
  assets: [
    "nixamp-0.63.3-linux-amd64.deb", "nixamp-0.63.3-linux-arm64.AppImage", "nixamp-0.63.3-linux-arm64.deb", "nixamp-0.63.3-linux-x64.tar.gz",
    "nixamp-0.63.3-linux-x86_64.AppImage", "nixamp-0.63.3-mac-arm64.dmg", "nixamp-0.63.3-mac-arm64.zip", "nixamp-0.63.3-mac-x64.dmg",
    "nixamp-0.63.3-win-arm64.exe", "nixamp-0.63.3-win-x64.exe", "nixamp-0.63.3-win-x64.zip", "nixamp-cli-0.63.3.tar.gz",
  ].map((name) => ({ name, browser_download_url: `${RELEASES}/download/v0.63.3/${name}` })),
};

test("every desktop target finds its installer on a real release, and only that one", () => {
  const found = DESKTOP_TARGETS.map((one) => desktopAsset(release, one.target)?.split("/").pop());
  assert.deepEqual(found, [
    "nixamp-0.63.3-mac-arm64.dmg", "nixamp-0.63.3-mac-x64.dmg", "nixamp-0.63.3-win-x64.exe", "nixamp-0.63.3-win-arm64.exe",
    "nixamp-0.63.3-linux-x86_64.AppImage", "nixamp-0.63.3-linux-arm64.AppImage", "nixamp-0.63.3-linux-amd64.deb", "nixamp-0.63.3-linux-arm64.deb",
  ]);
  assert.equal(desktopAsset(release, "beos"), null);
  assert.equal(desktopAsset(null, "mac-arm64"), null);
  assert.equal(desktopAsset({ tag_name: "v1", assets: [] }, "mac-arm64"), null);
});

test("llms.txt names the public MCP, the stdio MCP, the API and a Desktop section a store can read", () => {
  const text = llmsTxt(SITE);
  assert.match(text, /https:\/\/nixamp\.com\/mcp\/public/);
  assert.match(text, /npx -y nixamp mcp/);
  assert.match(text, /https:\/\/nixamp\.com\/openapi\.json/);
  assert.match(text, /^- GET \/api\/v1\/health$/m);
  assert.match(text, /curl -fsSL https:\/\/nixamp\.com\/install\.sh \| sh/);
  // pwamart reads the section under a "Desktop" heading: a Downloads: page, then one line per platform.
  const desktop = text.split(/^## Desktop app$/m)[1]!.split(/^## /m)[0]!;
  assert.match(desktop, /^Downloads: https:\/\/nixamp\.com\/download$/m);
  for (const one of DESKTOP_TARGETS) assert.ok(desktop.includes(`- ${one.label}: ${SITE}/download/${one.target}`), one.target);
});

test("the OpenAPI document is 3.1, points at the site, and marks the signed-in routes", () => {
  const doc = openapiDocument(SITE, "9.9.9") as { openapi: string; info: { version: string }; servers: { url: string }[]; paths: Record<string, Record<string, { security?: unknown }>> };
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, "9.9.9");
  assert.deepEqual(doc.servers, [{ url: SITE }]);
  assert.equal(doc.paths["/api/v1/health"]!["get"]!.security, undefined);
  assert.deepEqual(doc.paths["/api/v1/auth/me"]!["get"]!.security, [{ bearer: [] }]);
  assert.ok(doc.paths["/mcp/public"]!["post"]);
});

test("a failed ask of GitHub keeps the last answer and does not ask again for ten minutes", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const fetcher = (async () => {
    calls += 1;
    if (fail) throw new Error("offline");
    return new Response(JSON.stringify(release), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const latest = latestRelease(fetcher, () => now);
  assert.equal((await latest())?.tag_name, "v0.63.3");
  now = 60_000;
  await latest();
  assert.equal(calls, 1);
  fail = true;
  now = 11 * 60_000;
  assert.equal((await latest())?.tag_name, "v0.63.3");
  assert.equal(calls, 2);
});

test("the routes: text, JSON, the download page, a redirect per platform, and nothing else", async () => {
  let known: Release | null = release;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    void handleDiscovery(request, response, path, {
      site: `${SITE}/`, version: "1.2.3", release: async () => known,
      json: (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
    }).then((handled) => { if (!handled) { response.writeHead(418); response.end(); } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const llms = await fetch(`${base}/llms.txt`);
    assert.match(llms.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(await llms.text(), /^# nixamp/);

    const spec = await fetch(`${base}/openapi.json`);
    assert.equal((await spec.json() as { info: { version: string } }).info.version, "1.2.3");

    assert.deepEqual(await (await fetch(`${base}/api/v1/health`)).json(), { ok: true, name: "nixamp", version: "1.2.3" });

    const page = await (await fetch(`${base}/download`)).text();
    assert.match(page, /v0\.63\.3/);
    for (const one of DESKTOP_TARGETS) assert.ok(page.includes(`href="/download/${one.target}"`));

    const mac = await fetch(`${base}/download/mac-arm64`, { redirect: "manual" });
    assert.equal(mac.status, 302);
    assert.equal(mac.headers.get("location"), `${RELEASES}/download/v0.63.3/nixamp-0.63.3-mac-arm64.dmg`);

    // GitHub unreachable: the releases page, never a dead link.
    known = null;
    assert.equal((await fetch(`${base}/download/win-x64`, { redirect: "manual" })).headers.get("location"), `${RELEASES}/latest`);

    assert.equal((await fetch(`${base}/download/beos`)).status, 404);
    assert.equal((await fetch(`${base}/llms.txt`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/somewhere-else`)).status, 418);
    assert.equal(isDiscoveryPath("/download/../etc"), false);
  } finally {
    server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { EmptyEngine, createServer } from "../src/server.ts";
import { isLegalPath, legalPage } from "../src/legal.ts";
import { webSitesFromEnv } from "../src/web-sites.ts";

test("legal pages: headings, effective date, MCP section, no dashes", () => {
  assert.equal(isLegalPath("/privacy"), "privacy");
  assert.equal(isLegalPath("/terms/"), "terms");
  assert.equal(isLegalPath("/privacy-policy"), null);
  for (const site of ["nixamp", "school"] as const) {
    const privacy = legalPage("privacy", site, "https://example.test");
    const terms = legalPage("terms", site, "https://example.test");
    assert.match(privacy, /<h1>Privacy Policy<\/h1>/);
    assert.match(privacy, /<title>Privacy Policy/);
    assert.match(privacy, /AI agents and MCP/);
    assert.match(privacy, /\/mcp\/public/);
    assert.match(terms, /<h1>Terms of Service<\/h1>/);
    assert.match(terms, /<title>Terms of Service/);
    for (const page of [privacy, terms]) {
      assert.match(page, /Effective date: November 11, 2026/);
      assert.match(page, /href="\/privacy"/);
      assert.match(page, /href="\/terms"/);
      assert.doesNotMatch(page, /[–—]/);
    }
  }
  assert.match(legalPage("privacy", "school", "https://backtoschool.help"), /backtoschool\.help\/mcp/);
  assert.doesNotMatch(legalPage("privacy", "school", "https://backtoschool.help"), /pit\.world/);
});

test("legal pages answer on nixamp.com and backtoschool.help only", async () => {
  const defaultWeb = mkdtempSync(join(tmpdir(), "nixamp-web-"));
  const schoolWeb = mkdtempSync(join(tmpdir(), "nixamp-school-"));
  writeFileSync(join(defaultWeb, "index.html"), "<title>NixAmp</title>");
  writeFileSync(join(schoolWeb, "index.html"), "<title>BackToSchool.help</title>");
  const server = createServer(new EmptyEngine(), {
    web: defaultWeb,
    webSites: webSitesFromEnv(JSON.stringify({ "https://backtoschool.help": schoolWeb })),
    media: true,
    version: "test",
    load: async () => [],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = (path: string, host: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { host } });
  try {
    for (const [path, heading] of [["/privacy", "Privacy Policy"], ["/terms", "Terms of Service"]] as const) {
      const nixamp = await get(path, "nixamp.com");
      assert.equal(nixamp.status, 200);
      const nixampHtml = await nixamp.text();
      assert.ok(nixampHtml.includes(`<h1>${heading}</h1>`));
      assert.ok(nixampHtml.includes("https://nixamp.com/mcp"));
      const school = await get(path, "backtoschool.help");
      assert.equal(school.status, 200);
      const schoolHtml = await school.text();
      assert.ok(schoolHtml.includes(`<h1>${heading}</h1>`));
      assert.ok(schoolHtml.includes("BackToSchool.help"));
      // A self-hosted box on its own host is not ours to write a policy for.
      assert.notEqual((await get(path, "server1.example.test")).status, 200);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(defaultWeb, { recursive: true, force: true });
    rmSync(schoolWeb, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { adCsp, renderGuide, withPageAd } from "../src/station-guide.ts";

const ads = { site: "site-1", slot: "slot-1" };

test("the guide as a home page carries no ad; as an inner page, one", () => {
  assert.doesNotMatch(renderGuide([], "", ads, "", true), /api\/ads\/frame/);
  assert.equal(renderGuide([], "", ads, "", false).match(/api\/ads\/frame/g)?.length, 1);
  // The tracker is not an ad: it stays on the home page.
  assert.match(renderGuide([], "", ads, "", true), /stats\.js/);
});

test("an inner page gets one text_link line at the top of its content, and room for it in its CSP", () => {
  const page = withPageAd(`<body><nav>x</nav><main class="station-app"><h1>Punk</h1></main><footer>f</footer></body>`, ads);
  assert.equal(page.match(/api\/ads\/frame/g)?.length, 1);
  assert.match(page, /<main class="station-app">\n<div class="ad-unit ad-text_link"><iframe [^>]*format=text_link/);
  assert.ok(page.indexOf("ad-unit") < page.indexOf("<h1>"));
  assert.equal(adCsp("default-src 'self'", ads), "default-src 'self'; frame-src 'self' https://crawlproof.com");
});

test("no slot, no ad and the CSP as it was", () => {
  const html = "<main><p>x</p></main>";
  assert.equal(withPageAd(html, {}), html);
  assert.equal(adCsp("default-src 'none'", {}), "default-src 'none'");
});

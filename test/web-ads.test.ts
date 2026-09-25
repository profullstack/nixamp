import { describe, expect, it } from "bun:test";
import { adNowRequested, adSettings } from "../web/src/ads.ts";

// The player's own side of a break: what the link that opened the page is
// allowed to say about it. Entitlement is OpenAccess's question and is tested
// where that rule lives; the proxy that fills a break is in ads.test.ts.
//
// Everything here is decided from the query alone, before any entitlement
// lookup, so none of it needs a network.

describe("the link that opened the page still gets a say", () => {
  // A link carrying url= has its whole query stripped from the address bar at
  // startup, because it holds a share key. That happens synchronously, while
  // these are read after an await, so reaching for location.search found it
  // already empty: every override was dropped on exactly the shared stream
  // links a listener opens. Both now take the query as an argument.

  it("?ads=0 turns adverts off outright", async () => {
    expect(await adSettings({}, "?ads=0")).toBeNull();
    expect(await adSettings({}, "?ads=false")).toBeNull();
  });

  it("?ads=1 turns them on without asking about entitlement", async () => {
    expect(await adSettings({}, "?ads=1")).not.toBeNull();
  });

  it("reads the interval from the query it is handed", async () => {
    const ads = await adSettings({}, "?ads=1&adsEvery=10");
    expect(ads?.everySeconds).toBe(10);
  });

  it("clamps an interval that would ask for an advert every second", async () => {
    expect((await adSettings({}, "?ads=1&adsEvery=1"))?.everySeconds).toBe(5);
    expect((await adSettings({}, "?ads=1&adsEvery=99999"))?.everySeconds).toBe(3600);
  });

  it("leaves the interval to the default when the query says nothing", async () => {
    // Not pinned to a number: the default is deliberately turned down while the
    // network is being watched, and pinning it here would fail that change
    // rather than test this one.
    const ads = await adSettings({}, "?ads=1");
    expect(ads?.everySeconds).toBeGreaterThan(0);
    expect(ads?.everySeconds).not.toBe(10_000);
  });

  it("?adNow is read from the query it is handed, not the address bar", () => {
    expect(adNowRequested("?adNow")).toBe(true);
    expect(adNowRequested("?adNow=1")).toBe(true);
    expect(adNowRequested("?ads=1&adsEvery=10&adNow")).toBe(true);
    expect(adNowRequested("")).toBe(false);
    expect(adNowRequested("?adNow=0")).toBe(false);
    expect(adNowRequested("?adNow=false")).toBe(false);
  });

  it("?adNow implies adverts, even for a listener who is paying", async () => {
    // Asking for one immediately is asking for adverts: it is how a break is
    // demonstrated on an account that may well hold a pass.
    expect(await adSettings({ paid: true }, "?adNow")).not.toBeNull();
  });

  it("a listener known to be paying gets none when nothing was asked", async () => {
    expect(await adSettings({ paid: true }, "")).toBeNull();
  });
});

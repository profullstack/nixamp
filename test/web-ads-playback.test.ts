import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { adSettings } from "../web/src/ads.ts";

// Reporting what the listener actually did with a break.
//
// The network already meters that an advert was CHOSEN. These cover the other
// half: that the outcome goes back, against the decision the network handed
// out, and that a break with nothing to report against still plays.

type Sent = string[];

function captureBeacons(): Sent {
  const sent: Sent = [];
  class FakeImage {
    set src(v: string) {
      sent.push(v);
    }
  }
  (globalThis as unknown as { Image: unknown }).Image = FakeImage;
  return sent;
}

// breakKind() asks the DOM whether a video is on screen, to decide whether the
// break should be audio or video. There is no DOM here and that question is not
// what these cover, so it is answered "no video" — without this, next() throws
// on `document` and its own catch turns every break into an unfilled one.
//
// Installed ONLY when there is no document at all, and torn down by deleting
// rather than assigning undefined. Bun runs every test file in one process, so
// a `document` written here outlives this file: assigning it back to undefined
// took the DOM away from every suite that runs after this one and failed 28
// tests that have nothing to do with adverts.
let installedDocument = false;

function stubDom() {
  if ((globalThis as unknown as { document?: unknown }).document) return;
  (globalThis as unknown as { document: unknown }).document = {
    querySelector: () => null,
  };
  installedDocument = true;
}

function restoreDom() {
  if (!installedDocument) return;
  delete (globalThis as unknown as { document?: unknown }).document;
  installedDocument = false;
}

function stubBreak(body: unknown, ok = true) {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    ok,
    json: async () => body,
  });
}

const realFetch = globalThis.fetch;
const realImage = (globalThis as unknown as { Image?: unknown }).Image;

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  (globalThis as unknown as { Image?: unknown }).Image = realImage;
  restoreDom();
});

const FILLED = {
  url: "https://crawlproof.com/ads/house/preroll.mp4",
  kind: "audio",
  decisionId: "11111111-2222-4333-8444-555555555555",
  eventsUrl: "https://crawlproof.com/api/ads/video/events",
};

describe("a break reports its outcome", () => {
  let sent: Sent;
  beforeEach(() => {
    sent = captureBeacons();
    stubDom();
  });

  it("reports a start against the decision the network handed out", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    const creative = await ads!.next();
    expect(creative).toMatchObject({ url: FILLED.url });

    ads!.onBreakStart!({ url: FILLED.url, index: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("https://crawlproof.com/api/ads/video/events");
    expect(sent[0]).toContain(`d=${FILLED.decisionId}`);
    expect(sent[0]).toContain("t=start");
  });

  it("reports a completion when the advert reached the end", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    await ads!.next();
    ads!.onBreakStart!({ url: FILLED.url, index: 0 });
    ads!.onBreakEnd!({ url: FILLED.url, index: 0, skipped: false });
    expect(sent.at(-1)).toContain("t=complete");
  });

  it("reports an abandon when the listener skipped out", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    await ads!.next();
    ads!.onBreakStart!({ url: FILLED.url, index: 0 });
    ads!.onBreakEnd!({ url: FILLED.url, index: 0, skipped: true });
    expect(sent.at(-1)).toContain("t=abandon");
  });

  it("reports an error, so a break that would not load is not silent", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    await ads!.next();
    ads!.onError!(new Error("media"));
    expect(sent.at(-1)).toContain("t=error");
  });

  it("stops reporting once the break is over", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    await ads!.next();
    ads!.onBreakStart!({ url: FILLED.url, index: 0 });
    ads!.onBreakEnd!({ url: FILLED.url, index: 0, skipped: false });
    const after = sent.length;
    // A second end for the same break must not add a second completion.
    ads!.onBreakEnd!({ url: FILLED.url, index: 0, skipped: false });
    expect(sent).toHaveLength(after);
  });
});

describe("a break with nothing to report against still plays", () => {
  let sent: Sent;
  beforeEach(() => {
    sent = captureBeacons();
    stubDom();
  });

  it("plays the advert when the network recorded no decision", async () => {
    // decisionId null is the network saying measurement is off for this one.
    // The listener must not notice, and nothing must be sent.
    stubBreak({ ...FILLED, decisionId: null, eventsUrl: null });
    const ads = await adSettings({}, "?ads=1");
    const creative = await ads!.next();
    expect(creative).toMatchObject({ url: FILLED.url });
    ads!.onBreakStart!({ url: FILLED.url, index: 0 });
    ads!.onBreakEnd!({ url: FILLED.url, index: 0, skipped: false });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing for the ?adUrl= test creative, which is not a real fill", async () => {
    const ads = await adSettings({}, "?ads=1&adUrl=https://example.com/x.mp3");
    await ads!.next();
    ads!.onBreakStart!({ url: "https://example.com/x.mp3", index: 0 });
    expect(sent).toHaveLength(0);
  });

  it("does not attribute a break that is playing a different file", async () => {
    stubBreak(FILLED);
    const ads = await adSettings({}, "?ads=1");
    await ads!.next();
    // A start for some other url is not this decision's start.
    ads!.onBreakStart!({ url: "https://example.com/other.mp3", index: 0 });
    expect(sent).toHaveLength(0);
  });

  it("does not report when the break was unfilled", async () => {
    stubBreak({ url: null });
    const ads = await adSettings({}, "?ads=1");
    expect(await ads!.next()).toBeNull();
    ads!.onBreakStart!({ url: "", index: 0 });
    expect(sent).toHaveLength(0);
  });
});

import { describe, expect, it } from "bun:test";
import { nextAdvert } from "../src/ads.ts";

const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("a break nobody can fill does not happen", () => {
  it("asks for nothing when this deployment has no slot", async () => {
    // Somebody running nixamp on their own machine has no advertising
    // relationship, and their listeners are themselves. Asking anyway would
    // spend a request per break to be told the same thing.
    let called = false;
    const res = await nextAdvert(null, {
      slot: "",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ url: null });
    expect(called).toBe(false);
  });

  it("returns no advert when the network refuses", async () => {
    const res = await nextAdvert(null, {
      slot: "s",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    expect(res).toEqual({ url: null });
  });

  it("returns no advert when the network throws or times out", async () => {
    const res = await nextAdvert(null, {
      slot: "s",
      fetchImpl: (async () => {
        throw new Error("timed out");
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ url: null });
  });

  it("returns no advert for an unfilled break", async () => {
    // The network answers 200 with a null url when the auction found nothing.
    // That is not an error and must not be treated as one.
    const res = await nextAdvert(null, { slot: "s", fetchImpl: ok({ url: null }) });
    expect(res).toEqual({ url: null });
  });

  it("returns no advert for malformed JSON", async () => {
    const res = await nextAdvert(null, {
      slot: "s",
      fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    expect(res).toEqual({ url: null });
  });
});

describe("only an https url survives being proxied", () => {
  it("refuses javascript: and data:", async () => {
    // This value is handed to a media element in somebody's browser. A hostile
    // or compromised network response must not be able to choose what runs
    // there just because nixamp passed it along.
    for (const url of ["javascript:alert(1)", "data:audio/mp3;base64,AAAA"]) {
      expect(await nextAdvert(null, { slot: "s", fetchImpl: ok({ url }) })).toEqual({ url: null });
    }
  });

  it("refuses plain http", async () => {
    // nixamp.com is https, so an http creative is blockable mixed content the
    // browser would refuse anyway — better to not promise it will play.
    expect(
      await nextAdvert(null, { slot: "s", fetchImpl: ok({ url: "http://cdn/ad.mp3" }) }),
    ).toEqual({ url: null });
  });

  it("refuses a url that is not a string", async () => {
    expect(await nextAdvert(null, { slot: "s", fetchImpl: ok({ url: 42 }) })).toEqual({ url: null });
  });

  it("passes an https creative through", async () => {
    const res = await nextAdvert(null, {
      slot: "s",
      fetchImpl: ok({ url: "https://cdn.example/ad.m4a", kind: "audio" }),
    });
    expect(res).toEqual({ url: "https://cdn.example/ad.m4a", kind: "audio" });
  });
});

describe("audio unless asked otherwise", () => {
  it("requests audio by default, because there is nowhere to put a picture", async () => {
    let asked = "";
    await nextAdvert(null, {
      slot: "s",
      fetchImpl: (async (input: string | URL) => {
        asked = String(input);
        return new Response(JSON.stringify({ url: "https://cdn/a.m4a" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(asked).toContain("kind=audio");
  });

  it("passes video through when the caller asks for it", async () => {
    let asked = "";
    const res = await nextAdvert("video", {
      slot: "s",
      fetchImpl: (async (input: string | URL) => {
        asked = String(input);
        return new Response(JSON.stringify({ url: "https://cdn/a.mp4", kind: "video" }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    expect(asked).toContain("kind=video");
    expect(res).toEqual({ url: "https://cdn/a.mp4", kind: "video" });
  });

  it("treats an unrecognised kind as audio rather than guessing", async () => {
    const res = await nextAdvert("interpretive-dance", {
      slot: "s",
      fetchImpl: ok({ url: "https://cdn/a.m4a", kind: "hologram" }),
    });
    expect(res).toEqual({ url: "https://cdn/a.m4a", kind: "audio" });
  });

  it("encodes the slot, so a slot id cannot alter the query", async () => {
    let asked = "";
    await nextAdvert(null, {
      slot: "a&kind=video&x=1",
      fetchImpl: (async (input: string | URL) => {
        asked = String(input);
        return new Response(JSON.stringify({ url: null }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(asked).toContain("slot=a%26kind%3Dvideo%26x%3D1");
    expect(asked).toContain("kind=audio");
  });
});

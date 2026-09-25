import { beforeEach, describe, expect, it } from "bun:test";
import { __clearRemoteSubjectCache, keyFromLink, remoteSubject } from "../src/remote-subject.ts";

const STREAMS = {
  server: { name: "server1" },
  channels: [
    { id: "cat-5193be51be49", name: "SPORTS: NBC Sports California", art: "https://cdn/a.jpg", kind: "video" },
    { id: "url-d47daa7e24ab", name: "Sintel (5.1 surround)", art: "" },
  ],
};

const answering = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => __clearRemoteSubjectCache());

describe("the name comes from the server, never the query", () => {
  it("names the channel the link asks for", async () => {
    const subject = await remoteSubject(
      "https://server1.example.com:4321/view/JV5m_XbnQFD0K9_JEnGEXw",
      "cat-5193be51be49",
      { fetchImpl: answering(STREAMS) },
    );
    expect(subject).toEqual({
      title: "SPORTS: NBC Sports California",
      where: "server1",
      image: "https://cdn/a.jpg",
      kind: "video",
    });
  });

  it("names the server when no channel is asked for", async () => {
    const subject = await remoteSubject("https://server1.example.com/view/k", "", {
      fetchImpl: answering(STREAMS),
    });
    expect(subject).toEqual({ title: "server1", where: "" });
  });

  it("says nothing about a channel the server does not have", async () => {
    // The query named it; the server did not. The query does not get to win,
    // because that is the whole point of asking.
    const subject = await remoteSubject("https://server1.example.com/view/k", "cat-invented", {
      fetchImpl: answering(STREAMS),
    });
    expect(subject).toBeNull();
  });

  it("sends the share key the link carries", async () => {
    let asked = "";
    await remoteSubject("https://server1.example.com/view/SECRET-KEY", "", {
      fetchImpl: (async (input: string | URL) => {
        asked = String(input);
        return new Response(JSON.stringify(STREAMS), { status: 200 });
      }) as unknown as typeof fetch,
    });
    // A key-gated server answers only with it, and whoever holds the link
    // already holds the key.
    expect(asked).toContain("/api/streams");
    expect(asked).toContain("k=SECRET-KEY");
  });
});

describe("it will not be used as a probe", () => {
  const shouldRefuse = [
    "http://server1.example.com/view/k", // not https
    "https://localhost:4321/view/k",
    "https://127.0.0.1/view/k",
    "https://10.1.2.3/view/k",
    "https://172.16.0.9/view/k",
    "https://192.168.1.5/view/k",
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://[::1]/view/k",
    "https://box.local/view/k",
    "file:///etc/passwd",
    "not a url",
  ];

  for (const href of shouldRefuse) {
    it(`refuses ${href}`, async () => {
      let called = false;
      const subject = await remoteSubject(href, "", {
        fetchImpl: (async () => {
          called = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      });
      expect(subject).toBeNull();
      // The address comes from the query string. Without this the page is a
      // probe anyone can point at anything this machine can reach.
      expect(called).toBe(false);
    });
  }
});

describe("a server that cannot answer simply does not name the card", () => {
  it("returns nothing on a refusal", async () => {
    expect(
      await remoteSubject("https://server1.example.com/view/k", "", {
        fetchImpl: answering({}, 401),
      }),
    ).toBeNull();
  });

  it("returns nothing when the fetch throws or times out", async () => {
    expect(
      await remoteSubject("https://server1.example.com/view/k", "", {
        fetchImpl: (async () => {
          throw new Error("timed out");
        }) as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns nothing for a shape that is not what we expect", async () => {
    expect(
      await remoteSubject("https://server1.example.com/view/k", "", {
        fetchImpl: answering({ server: { name: 42 } }),
      }),
    ).toBeNull();
  });
});

describe("answers are reused briefly", () => {
  it("asks once for the same link inside the window", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(STREAMS), { status: 200 });
    }) as unknown as typeof fetch;

    const href = "https://server1.example.com/view/k";
    await remoteSubject(href, "", { fetchImpl: counting });
    await remoteSubject(href, "", { fetchImpl: counting });
    // A link shared into a busy channel is unfurled by several crawlers at
    // once; they should cost the linked server one request, not several.
    expect(calls).toBe(1);
  });

  it("caches a failure too, so a server that is down is not hammered", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new Error("down");
    }) as unknown as typeof fetch;

    const href = "https://down.example.com/view/k";
    await remoteSubject(href, "", { fetchImpl: failing });
    await remoteSubject(href, "", { fetchImpl: failing });
    expect(calls).toBe(1);
  });

  it("asks again once the window has passed", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(STREAMS), { status: 200 });
    }) as unknown as typeof fetch;

    const href = "https://server1.example.com/view/k";
    let clock = 1_000_000;
    await remoteSubject(href, "", { fetchImpl: counting, now: () => clock });
    clock += 61_000;
    await remoteSubject(href, "", { fetchImpl: counting, now: () => clock });
    // Renaming a channel should show up while somebody is still looking at it.
    expect(calls).toBe(2);
  });
});

describe("the share key is read from either spelling", () => {
  it("reads /view/<key>", () => {
    expect(keyFromLink(new URL("https://a.example.com/view/abc123"))).toBe("abc123");
  });

  it("reads ?k=", () => {
    expect(keyFromLink(new URL("https://a.example.com/?k=abc123"))).toBe("abc123");
  });

  it("is empty when the link carries none", () => {
    expect(keyFromLink(new URL("https://a.example.com/"))).toBe("");
  });
});

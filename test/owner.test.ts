import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_MS, Owner, needsAdmin, needsMember } from "../src/owner.ts";

/** A nixamp.com that answers for exactly one token, and counts the asking. */
function fakeSite(knownToken: string, accountId: string) {
  let asked = 0;
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    asked++;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ok = headers["authorization"] === `Bearer ${knownToken}`;
    return {
      ok,
      json: async () => (ok ? { account: { id: accountId } } : { error: "not signed in" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, asked: () => asked };
}

const ownerOf = (over: Partial<ConstructorParameters<typeof Owner>[0]> = {}) => {
  const site = fakeSite("good-token", "owner-1");
  return {
    site,
    owner: new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: site.fetcher, ...over }),
  };
};

test("the control key is enough on its own", async () => {
  // Possession of the share link means you are at the machine, or somebody at
  // it told you. No account needed.
  const { owner } = ownerOf();
  assert.deepEqual(await owner.check(true, ""), { allowed: true, as: "key" });

  // And it still works on a server nobody has claimed.
  const { owner: unclaimed } = ownerOf({ ownerId: "" });
  assert.deepEqual(await unclaimed.check(true, ""), { allowed: true, as: "key" });
});

test("the owner's session is enough from anywhere", async () => {
  const { owner } = ownerOf();
  assert.deepEqual(await owner.check(false, "good-token"), { allowed: true, as: "owner" });
});

test("somebody else's session is not", async () => {
  const site = fakeSite("their-token", "someone-else");
  const owner = new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: site.fetcher });
  // A real, valid nixamp.com account that does not own this server.
  assert.deepEqual(await owner.check(false, "their-token"), { allowed: false, as: null });
});

test("a token nixamp.com refuses is nobody", async () => {
  const { owner } = ownerOf();
  assert.deepEqual(await owner.check(false, "made-up"), { allowed: false, as: null });
  assert.deepEqual(await owner.check(false, ""), { allowed: false, as: null });
});

test("a server nobody has claimed admits nobody by account", async () => {
  const { owner } = ownerOf({ ownerId: "" });
  assert.equal(owner.claimed, false);
  // Crucially not "everybody": an unclaimed server is administered by its
  // control link alone.
  assert.deepEqual(await owner.check(false, "good-token"), { allowed: false, as: null });
});

test("nixamp.com being unreachable does not make everyone the owner", async () => {
  const failing = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const owner = new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: failing });

  assert.deepEqual(await owner.check(false, "good-token"), { allowed: false, as: null });
  // The control key is the way in while identity cannot be checked.
  assert.deepEqual(await owner.check(true, ""), { allowed: true, as: "key" });
});

test("an answer is remembered, so admin requests do not each cost a round trip", async () => {
  let now = 1_000_000;
  const site = fakeSite("good-token", "owner-1");
  const owner = new Owner({
    ownerId: "owner-1",
    site: "https://nixamp.com",
    fetcher: site.fetcher,
    now: () => now,
  });

  await owner.check(false, "good-token");
  await owner.check(false, "good-token");
  await owner.check(false, "good-token");
  assert.equal(site.asked(), 1);

  // And not remembered for long: a revoked session should stop working in
  // about a minute, not at the next restart.
  now += CACHE_MS + 1;
  await owner.check(false, "good-token");
  assert.equal(site.asked(), 2);
});

test("a refusal is remembered too", async () => {
  const site = fakeSite("good-token", "owner-1");
  const owner = new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: site.fetcher });
  // Otherwise a wrong token costs a round trip every time it is presented.
  await owner.check(false, "wrong");
  await owner.check(false, "wrong");
  assert.equal(site.asked(), 1);
});

test("forgetting takes effect at once", async () => {
  const site = fakeSite("good-token", "owner-1");
  const owner = new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: site.fetcher });
  await owner.check(false, "good-token");
  owner.forget();
  await owner.check(false, "good-token");
  assert.equal(site.asked(), 2);
});

test("a member may go live, and take off what they put on, and nothing else that administers", () => {
  // Going live: a file here, a catalog entry, keeping something started on demand.
  assert.equal(needsMember("/api/tracks/3/live", "POST"), true);
  assert.equal(needsMember("/api/catalogs/k/entries/e/live", "POST"), true);
  assert.equal(needsMember("/api/channels/cat-e/keep", "POST"), true);
  // Taking off: the handler checks whose; the gate lets a member ask.
  assert.equal(needsMember("/api/channels/cat-e", "DELETE"), true);
  // Not a member's: the source, the connections, the catalogs, the links,
  // restarting somebody else's channel, publishing.
  assert.equal(needsMember("/api/source", "POST"), false);
  assert.equal(needsMember("/api/connections", "GET"), false);
  assert.equal(needsMember("/api/catalogs", "POST"), false);
  assert.equal(needsMember("/api/links/play", "POST"), false);
  assert.equal(needsMember("/api/channels/cat-e/restart", "POST"), false);
  assert.equal(needsMember("/api/channels/cat-e", "POST"), false);
  assert.equal(needsMember("/api/live/start", "POST"), false);
  // Everything a member may do is something that needs administering at all.
  for (const [path, method] of [["/api/tracks/3/live", "POST"], ["/api/catalogs/k/entries/e/live", "POST"], ["/api/channels/x/keep", "POST"], ["/api/channels/x", "DELETE"]] as const) {
    assert.equal(needsAdmin(path, method), true, `${method} ${path}`);
  }
});

test("the paths that need an administrator, and the ones that do not", () => {
  assert.equal(needsAdmin("/api/connections"), true);
  assert.equal(needsAdmin("/api/source"), true);
  assert.equal(needsAdmin("/api/broadcast"), true);
  assert.equal(needsAdmin("/api/broadcast/destinations"), true);
  assert.equal(needsAdmin("/api/ingest"), true);
  assert.equal(needsAdmin("/api/ingest/chunk"), true);
  assert.equal(needsAdmin("/api/admin"), true);
  // Going live with something from a catalog, or keeping a channel that was
  // started on demand, is administering; picking something to play is not.
  assert.equal(needsAdmin("/api/catalogs/k/entries/e/live", "POST"), true);
  assert.equal(needsAdmin("/api/catalogs/k/entries/e/play", "POST"), false);
  // Having the server fetch a link is a decoder on somebody else's machine.
  assert.equal(needsAdmin("/api/links/play", "POST"), true);
  assert.equal(needsAdmin("/api/links/download", "GET"), true);
  assert.equal(needsAdmin("/api/channels/cat-e/keep", "POST"), true);
  assert.equal(needsAdmin("/api/channels/cat-e", "GET"), false);
  // A file on this server going on the air is the same act as a catalog entry.
  assert.equal(needsAdmin("/api/tracks/12/live", "POST"), true);
  assert.equal(needsAdmin("/api/tracks/12/live-ish", "POST"), false);
  // Asking what a name is reveals nothing about this server.
  assert.equal(needsAdmin("/api/enrich", "GET"), false);

  // Listening is not administering.
  assert.equal(needsAdmin("/api/state"), false);
  assert.equal(needsAdmin("/api/stream/0"), false);
  assert.equal(needsAdmin("/api/media/0"), false);
  assert.equal(needsAdmin("/api/events"), false);
  assert.equal(needsAdmin("/api/health"), false);
  assert.equal(needsAdmin("/"), false);
  // A path that merely starts with the same letters is not the same path.
  assert.equal(needsAdmin("/api/sources-of-truth"), false);

  // Listing this machine in a public directory is administering it.
  assert.equal(needsAdmin("/api/live/start"), true);
  assert.equal(needsAdmin("/api/live/stop"), true);
  assert.equal(needsAdmin("/api/live/state"), false);
  // But /api/live is the public listen address -- the one the phone line is
  // handed -- so gating it by prefix would shut the front door to lock the
  // office.
  assert.equal(needsAdmin("/api/live"), false);
});

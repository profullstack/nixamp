import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  contentType, createServer, DEFAULT_PORT, EmptyEngine, PlayerEngine,
  parseRange, parseServeArgs, safeJoin, toRemoteTracks,
  type Engine,
} from "../src/server.ts";
import { emptySnapshot, parseCommand, remoteName, type Command, type Snapshot } from "../src/protocol.ts";
import { certifiable, isIpAddress, lookupPublicIp, reachableAddresses } from "../src/share.ts";
import { daemonLines } from "../src/daemon.ts";
import { Owner } from "../src/owner.ts";
import { Directory } from "../src/directory.ts";

test("serve flags parse, and a bad one is a message rather than a NaN", () => {
  // A platform that hands out the port would otherwise change what "default"
  // means halfway through this test.
  delete process.env.PORT;
  const bare = parseServeArgs([]);
  assert.equal(bare.root, ".");
  assert.equal(bare.port, DEFAULT_PORT);
  // Every interface, so the phone on the sofa can reach it. What makes that
  // safe is the key in the share link, which is on by default with it.
  assert.equal(bare.host, "0.0.0.0");
  assert.equal(bare.web, null);
  assert.equal(bare.media, true);
  assert.equal(bare.key, true);

  const full = parseServeArgs(["~/Music", "--port", "9000", "--host", "0.0.0.0", "--web", "web/dist", "--no-media"]);
  assert.equal(full.root, "~/Music");
  assert.equal(full.port, 9000);
  assert.equal(full.host, "0.0.0.0");
  assert.equal(full.web, "web/dist");
  assert.equal(full.media, false);

  assert.equal(parseServeArgs(["-p", "8080"]).port, 8080);
  assert.throws(() => parseServeArgs(["--port", "banana"]), /port number/);
  assert.throws(() => parseServeArgs(["--port", "99999"]), /port number/);
  assert.throws(() => parseServeArgs(["--port"]), /needs a value/);
  assert.throws(() => parseServeArgs(["--nope"]), /unknown option/);
});

test("PORT is honoured, because that is how a platform hands one out", () => {
  const before = process.env.PORT;
  try {
    process.env.PORT = "8080";
    assert.equal(parseServeArgs([]).port, 8080);
    // An explicit flag still wins over the environment.
    assert.equal(parseServeArgs(["--port", "9000"]).port, 9000);
    // Nonsense in the environment falls back rather than listening on NaN.
    process.env.PORT = "not-a-port";
    assert.equal(parseServeArgs([]).port, DEFAULT_PORT);
    process.env.PORT = "0";
    assert.equal(parseServeArgs([]).port, DEFAULT_PORT);
  } finally {
    if (before === undefined) delete process.env.PORT; else process.env.PORT = before;
  }
});

test("commands from a browser are validated, not trusted", () => {
  assert.deepEqual(parseCommand({ type: "stop" }), { type: "stop" });
  assert.deepEqual(parseCommand({ type: "play" }), { type: "play" });
  assert.deepEqual(parseCommand({ type: "play", index: 3 }), { type: "play", index: 3 });
  assert.deepEqual(parseCommand({ type: "select", index: 0 }), { type: "select", index: 0 });

  assert.equal(parseCommand({ type: "rm -rf" }), null);
  assert.equal(parseCommand({ type: "select" }), null);
  assert.equal(parseCommand({ type: "select", index: -1 }), null);
  assert.equal(parseCommand({ type: "select", index: 1.5 }), null);
  assert.equal(parseCommand({ type: "select", index: "1" }), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand("stop"), null);
  assert.equal(parseCommand([]), null);
  // A bad index on play degrades to "play what is selected" rather than failing.
  assert.deepEqual(parseCommand({ type: "play", index: -2 }), { type: "play" });
});

test("byte ranges, including the ones a browser sends when it seeks", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  // Past the end is clamped, not refused.
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 });
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("bytes=-", 1000), null);
  assert.equal(parseRange("bytes=500-100", 1000), null);
  assert.equal(parseRange("bytes=1000-", 1000), null);
  assert.equal(parseRange("items=0-10", 1000), null);
  assert.equal(parseRange("bytes=0-99", 0), null);
});

test("a request path cannot climb out of the web directory", () => {
  const root = "/srv/web";
  assert.equal(safeJoin(root, "/index.html"), "/srv/web/index.html");
  assert.equal(safeJoin(root, "/assets/app.js"), "/srv/web/assets/app.js");
  assert.equal(safeJoin(root, "/"), "/srv/web");

  // Every climb, encoded or not, is either refused or clamped inside the root —
  // never resolved to a path outside it.
  for (const attempt of [
    "/../../etc/passwd",
    "/%2e%2e%2f%2e%2e%2fetc/passwd",
    "/admin/../../../etc/passwd",
    "/../web-other/x",
    "/..%2f..%2f..%2fetc/shadow",
  ]) {
    const out = safeJoin(root, attempt);
    if (out !== null) {
      assert.ok(out === root || out.startsWith(`${root}/`), `${attempt} escaped to ${out}`);
    }
  }

  // Nonsense is refused outright.
  assert.equal(safeJoin(root, "/%00"), null);
  assert.equal(safeJoin(root, "/%zz"), null);
});

test("content types cover what the player actually serves", () => {
  assert.equal(contentType("/x/index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("app.MJS"), "text/javascript; charset=utf-8");
  assert.equal(contentType("manifest.webmanifest"), "application/manifest+json; charset=utf-8");
  assert.equal(contentType("a.flac"), "audio/flac");
  assert.equal(contentType("a.opus"), "audio/ogg");
  assert.equal(contentType("clip.webm"), "video/webm");
  assert.equal(contentType("LICENSE"), "application/octet-stream");
});

test("tracks reach a remote without their filesystem paths", () => {
  const remote = toRemoteTracks([
    { path: "/home/me/Music/secret/a.flac", title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 },
  ]);
  assert.deepEqual(remote, [{ title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 }]);
  assert.equal(JSON.stringify(remote).includes("/home/me"), false);
  assert.equal(remoteName(remote[0]!), "Meshuggah — Bleed");
  assert.equal(remoteName({ title: "Untitled", artist: "", album: "", duration: 0 }), "Untitled");
});

/** A player that records what it was told, so the HTTP layer can be tested alone. */
class FakeEngine implements Engine {
  readonly seen: Command[] = [];
  private listeners = new Set<(s: Snapshot) => void>();
  constructor(private readonly paths: string[] = []) {}
  snapshot(): Snapshot {
    return { ...emptySnapshot(), revision: this.seen.length, note: "fake" };
  }
  command(command: Command): void {
    this.seen.push(command);
    for (const l of this.listeners) l(this.snapshot());
  }
  subscribe(listener: (s: Snapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
  trackPath(index: number): string | undefined {
    return this.paths[index];
  }
  stop(): void {
    this.listeners.clear();
  }
}

async function withServer(
  engine: Engine,
  options: { web?: string | null; media?: boolean },
  body: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(engine, {
    web: options.web ?? null,
    media: options.media ?? true,
    version: "test",
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("the control API answers state, commands and health", async () => {
  const engine = new FakeEngine();
  await withServer(engine, {}, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { name: "nixamp", version: "test", media: true });

    const state = await fetch(`${base}/api/state`);
    assert.equal(state.status, 200);
    // A remote on another device is a different origin, so this has to be open.
    assert.equal(state.headers.get("access-control-allow-origin"), "*");
    assert.equal(((await state.json()) as Snapshot).note, "fake");

    const ok = await fetch(`${base}/api/command`, {
      method: "POST",
      body: JSON.stringify({ type: "next" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(engine.seen, [{ type: "next" }]);

    const bad = await fetch(`${base}/api/command`, { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`${base}/api/command`, {
      method: "POST",
      body: JSON.stringify({ type: "format c:" }),
    });
    assert.equal(unknown.status, 400);
    // Still only the one command got through.
    assert.equal(engine.seen.length, 1);

    assert.equal((await fetch(`${base}/api/command`)).status, 405);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/state`, { method: "OPTIONS" })).status, 204);
  });
});

test("state is pushed over SSE as soon as a remote subscribes", async () => {
  const engine = new FakeEngine();
  await withServer(engine, {}, async (base) => {
    const response = await fetch(`${base}/api/events`);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /^data: /);
    const snapshot = JSON.parse(first.slice("data: ".length)) as Snapshot;
    assert.equal(snapshot.note, "fake");
    await reader.cancel();
  });
});

test("media is streamed with ranges, and only for a track that exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-serve-"));
  const file = join(dir, "a.mp3");
  writeFileSync(file, "0123456789");
  try {
    await withServer(new FakeEngine([file]), {}, async (base) => {
      const whole = await fetch(`${base}/api/media/0`);
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get("content-type"), "audio/mpeg");
      assert.equal(whole.headers.get("accept-ranges"), "bytes");
      assert.equal(await whole.text(), "0123456789");

      const part = await fetch(`${base}/api/media/0`, { headers: { range: "bytes=2-5" } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(await part.text(), "2345");

      assert.equal((await fetch(`${base}/api/media/7`)).status, 404);
      assert.equal((await fetch(`${base}/api/media/x`)).status, 404);
    });

    await withServer(new FakeEngine([file]), { media: false }, async (base) => {
      assert.equal((await fetch(`${base}/api/media/0`)).status, 403);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the built PWA is served, and an unknown path falls back to its shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-web-"));
  writeFileSync(join(dir, "index.html"), "<title>nixamp</title>");
  writeFileSync(join(dir, "app.js"), "export const a = 1;");
  try {
    await withServer(new FakeEngine(), { web: dir }, async (base) => {
      const shell = await fetch(`${base}/`);
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
      // The shell must not be frozen in a cache, or an update never lands.
      assert.equal(shell.headers.get("cache-control"), "no-cache");
      assert.match(await shell.text(), /nixamp/);

      const asset = await fetch(`${base}/app.js`);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);

      const deep = await fetch(`${base}/library/anything`);
      assert.equal(deep.status, 200);
      assert.match(await deep.text(), /nixamp/);

      // A climb is not an error — it is just another unknown path, and an
      // unknown path is the shell. What matters is that /etc/passwd never
      // comes back.
      const escape = await fetch(`${base}/..%2f..%2fetc/passwd`);
      assert.match(await escape.text(), /nixamp/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no library the server still answers, and says so", async () => {
  const engine = new EmptyEngine("nothing here");
  await withServer(engine, {}, async (base) => {
    const snapshot = (await (await fetch(`${base}/api/state`)).json()) as Snapshot;
    assert.deepEqual(snapshot.tracks, []);
    assert.equal(snapshot.note, "nothing here");
    // A command against an empty library is accepted and does nothing.
    assert.equal((await fetch(`${base}/api/command`, {
      method: "POST",
      body: JSON.stringify({ type: "play" }),
    })).status, 200);
  });
});

test("a public address can be given, because a machine behind NAT cannot know it", () => {
  const told = reachableAddresses("0.0.0.0", 8420, "https://nixamp.example.com/");
  // First, so it is the address the listing is published under rather than a
  // guess from an interface, and with no trailing slash to double up on.
  assert.deepEqual(told[0], { label: "on the internet", url: "https://nixamp.example.com" });
  assert.ok(told.some((a) => a.label === "here"));

  // Pinned to one host it is still offered, next to that host.
  const pinned = reachableAddresses("127.0.0.1", 8420, "https://nixamp.example.com");
  assert.equal(pinned[0]?.label, "on the internet");
  assert.deepEqual(pinned[1], { label: "here", url: "http://127.0.0.1:8420" });

  // Unchanged when nobody says: this is what every nixamp on a LAN still sees.
  assert.equal(reachableAddresses("0.0.0.0", 8420)[0]?.label, "here");
});

test("--public-url has to be a URL, since the failure is otherwise a dead listing", () => {
  assert.equal(parseServeArgs(["--public-url", "https://x.example.com/"]).publicUrl, "https://x.example.com");
  assert.equal(parseServeArgs(["--public-url", "http://1.2.3.4:8420"]).publicUrl, "http://1.2.3.4:8420");
  assert.equal(parseServeArgs([]).publicUrl, "");
  assert.throws(() => parseServeArgs(["--public-url", "nixamp.example.com"]), /must be a URL/);
  assert.throws(() => parseServeArgs(["--public-url"]), /needs a value/);
});

test("tags arrive later without stopping what is playing", () => {
  const paths = ["/m/a.flac", "/m/b.mp3"];
  const bare = paths.map((path) => ({ path, title: path, artist: "", album: "", duration: 0 }));
  const engine = new PlayerEngine(bare, "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  try {
    const tagged = [
      { path: "/m/a.flac", title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 },
      { path: "/m/b.mp3", title: "Aerials", artist: "SOAD", album: "Toxicity", duration: 235 },
    ];
    engine.retag(tagged, "/m");
    assert.equal(engine.snapshot().tracks[0]?.title, "Bleed");
    assert.equal(engine.snapshot().tracks[0]?.duration, 447);

    // Tags for tracks that are not here match nothing and change nothing --
    // which is the protection, now that tags are applied by path rather than
    // by the list being exactly the one that was sent away for tagging.
    engine.retag([{ path: "/other/z.mp3", title: "Z", artist: "", album: "", duration: 1 }], "/m");
    assert.equal(engine.snapshot().tracks.length, 2);
    assert.equal(engine.snapshot().tracks[0]?.title, "Bleed");
    engine.retag(tagged, "/somewhere-else");
    assert.equal(engine.snapshot().tracks[0]?.title, "Bleed");
  } finally {
    engine.stop();
  }
});

test("the daemon prints every address it has, not the one nobody can use", () => {
  const state = {
    pid: 42,
    host: "0.0.0.0",
    port: 4321,
    key: "KEY",
    source: "/home/ubuntu/Music",
    startedAt: 0,
    log: "/tmp/daemon.log",
    urls: [
      { label: "here", url: "http://localhost:4321" },
      { label: "on your network", url: "http://192.168.1.5:4321" },
      { label: "on the internet", url: "https://nixamp.example.com" },
    ],
    firewall: "ufw" as const,
  };
  const out = daemonLines(state).join("\n");

  // The complaint this fixes: one loopback link, and nothing you could send
  // to a phone in another room.
  assert.match(out, /on your network\s+http:\/\/192\.168\.1\.5:4321\/admin\/KEY/);
  assert.match(out, /on the internet\s+https:\/\/nixamp\.example\.com\/admin\/KEY/);
  assert.match(out, /source\s+\/home\/ubuntu\/Music/);

  // "did you open the firewall port?" -- it did not, and it says so with the
  // command, rather than writing that into a log nobody reads.
  assert.match(out, /ufw is running/);
  assert.match(out, /sudo ufw allow 4321\/tcp/);
  // There is a public address here, so the tunnel advice would be noise.
  assert.doesNotMatch(out, /--public-url/);
});

test("with nothing public, the daemon says so and how to fix it", () => {
  const out = daemonLines({
    pid: 42, host: "0.0.0.0", port: 4321, key: "KEY", source: "/m", startedAt: 0, log: "/tmp/l",
    urls: [{ label: "here", url: "http://localhost:4321" }],
  }).join("\n");
  assert.match(out, /None of those work from outside/);
  assert.match(out, /--public-url https:\/\/your-tunnel/);
  // No firewall reported means no firewall warning invented.
  assert.doesNotMatch(out, /is running, so nothing else/);
});

test("a state file from an older nixamp still prints something", () => {
  // No urls: host and port stand in rather than printing nothing at all.
  const out = daemonLines({
    pid: 7, host: "0.0.0.0", port: 4321, key: null, source: "/m", startedAt: 0, log: "/tmp/l",
  }).join("\n");
  assert.match(out, /here\s+http:\/\/127\.0\.0\.1:4321/);
  // No key means no /v/ suffix, because there is nothing to put after it.
  assert.doesNotMatch(out, /\/admin\//);
});

test("an address looked up outside is an address, or it is nothing", async () => {
  assert.equal(isIpAddress("67.205.189.229"), true);
  assert.equal(isIpAddress("2600:3c03::f03c:91ff:fe96:1"), true);
  assert.equal(isIpAddress("999.1.1.1"), false, "octets have a ceiling");
  assert.equal(isIpAddress("<!doctype html>"), false);
  assert.equal(isIpAddress("rate limit exceeded"), false);
  assert.equal(isIpAddress(""), false);

  const good = (async () => new Response("67.205.189.229\n")) as unknown as typeof fetch;
  assert.equal(await lookupPublicIp(good), "67.205.189.229");

  // A service having a bad day must not become an address in a share link.
  const prose = (async () => new Response("too many requests")) as unknown as typeof fetch;
  assert.equal(await lookupPublicIp(prose), "");
  const refused = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
  assert.equal(await lookupPublicIp(refused), "");
  const offline = (async () => {
    throw new Error("ENOTFOUND");
  }) as unknown as typeof fetch;
  assert.equal(await lookupPublicIp(offline), "");
});

test("--no-lookup is there for anyone who would rather nixamp asked nobody", () => {
  assert.equal(parseServeArgs([]).lookup, true);
  assert.equal(parseServeArgs(["--no-lookup"]).lookup, false);
});

test("a guessed public address is printed as the claim it is", () => {
  const out = daemonLines({
    pid: 1, host: "0.0.0.0", port: 4321, key: "KEY", source: "/m", startedAt: 0, log: "/tmp/l",
    urls: [
      { label: "on the internet", url: "http://67.205.189.229:4321" },
      { label: "here", url: "http://localhost:4321" },
    ],
    guessedPublic: true,
  }).join("\n");

  assert.match(out, /on the internet\s+http:\/\/67\.205\.189\.229:4321\/admin\/KEY/);
  // The honest part: knowing the router's address says nothing about whether
  // anything reaches this port.
  assert.match(out, /router, not this port/);
  assert.match(out, /until 4321 is forwarded here/);

  // An address that came from an interface or from --public-url is not a guess,
  // and is not hedged.
  const known = daemonLines({
    pid: 1, host: "0.0.0.0", port: 4321, key: "KEY", source: "/m", startedAt: 0, log: "/tmp/l",
    urls: [{ label: "on the internet", url: "https://done.example.com" }],
  }).join("\n");
  assert.doesNotMatch(known, /router, not this port/);
});

test("status says where it is and how long it has been there", () => {
  // The same links start prints: `daemon status` rebuilt the URL from host and
  // port and so printed loopback alone, which is the address that works only
  // on the machine you are already sitting at.
  const out = daemonLines({
    pid: 42, host: "0.0.0.0", port: 4321, key: "KEY", source: "/home/ubuntu/Downloads/done",
    startedAt: 0, log: "/tmp/l",
    urls: [
      { label: "here", url: "http://localhost:4321" },
      { label: "on the internet", url: "http://104.152.209.195:4321" },
    ],
  }, 222_000).join("\n");

  assert.match(out, /on the internet\s+http:\/\/104\.152\.209\.195:4321\/admin\/KEY/);
  assert.match(out, /source\s+\/home\/ubuntu\/Downloads\/done/);
  assert.match(out, /up\s+3m 42s/);

  // Start passes no uptime, and start has none to report.
  const starting = daemonLines({
    pid: 42, host: "0.0.0.0", port: 4321, key: "KEY", source: "/m", startedAt: 0, log: "/tmp/l",
    urls: [{ label: "here", url: "http://localhost:4321" }],
  }).join("\n");
  assert.doesNotMatch(starting, /\bup\b/);
});

test("a certificate makes it https, and half a pair is refused early", () => {
  assert.equal(parseServeArgs([]).tlsCert, "");
  const secure = parseServeArgs(["--tls-cert", "/etc/cert.pem", "--tls-key", "/etc/key.pem"]);
  assert.equal(secure.tlsCert, "/etc/cert.pem");
  assert.equal(secure.tlsKey, "/etc/key.pem");

  // Half a pair cannot serve anything, and finding that out at listen time is
  // finding it out too late.
  assert.throws(() => parseServeArgs(["--tls-cert", "/etc/cert.pem"]), /go together/);
  assert.throws(() => parseServeArgs(["--tls-key", "/etc/key.pem"]), /go together/);

  // The links have to say https, or they are links to a port that will not
  // speak http to them.
  const links = reachableAddresses("0.0.0.0", 4321, "", "https");
  assert.equal(links[0]?.url, "https://localhost:4321");
});

/** A track with nothing filled in, which is all these tests need of one. */
const track = (path: string) => ({ path, title: path, artist: "", album: "", duration: 0 });

test("adding an album keeps the library it was added to", () => {
  const library = ["/m/a.mp3", "/m/b.mp3"].map(track);
  const engine = new PlayerEngine(library, "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  try {
    const album = ["https://x.test/al/1.mp3", "https://x.test/al/2.mp3"].map(track);
    assert.equal(engine.add(album, "https://x.test/al/"), 2);

    const after = engine.snapshot().tracks;
    // The whole bug in one assertion: the library used to be gone here, and
    // clicking your own file played a stranger's.
    assert.equal(after.length, 4);
    assert.equal(engine.trackPath(0), "/m/a.mp3");
    assert.equal(engine.trackPath(2), "https://x.test/al/1.mp3");

    // The library says nothing about a group; what was added says where from.
    assert.equal(after[0]?.group, undefined);
    assert.equal(after[2]?.group, "al");
    assert.deepEqual(engine.groups(), ["al"]);

    // The same album again is not two copies of it.
    assert.equal(engine.add(album, "https://x.test/al/"), 0);
    assert.equal(engine.snapshot().tracks.length, 4);
  } finally {
    engine.stop();
  }
});

test("an added album can be taken back out, and the library cannot", () => {
  const engine = new PlayerEngine(
    ["/m/a.mp3", "/m/b.mp3"].map(track),
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  try {
    engine.add(["https://x.test/al/1.mp3"].map(track), "https://x.test/al/");
    // Sitting on the library's second track while an album hangs off the end.
    engine.command({ type: "select", index: 1 });

    assert.equal(engine.drop("al"), 1);
    assert.equal(engine.snapshot().tracks.length, 2);
    // Followed by path, not by number: dropping from below must not move the
    // listener off the track they were on.
    assert.equal(engine.snapshot().index, 1);
    assert.deepEqual(engine.groups(), []);

    // Nothing in the library carries a group, so no group name reaches it.
    assert.equal(engine.drop("m"), 0);
    assert.equal(engine.drop(""), 0);
    assert.equal(engine.snapshot().tracks.length, 2);
  } finally {
    engine.stop();
  }
});

test("dropping the group the listener is inside stops rather than plays on", () => {
  const engine = new PlayerEngine(
    ["/m/a.mp3"].map(track),
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  try {
    engine.add(["https://x.test/al/1.mp3"].map(track), "https://x.test/al/");
    engine.command({ type: "select", index: 1 });
    engine.drop("al");
    assert.equal(engine.snapshot().playing, false);
    // Still a real index into what is left, rather than one past the end.
    assert.equal(engine.snapshot().index, 0);
    assert.equal(engine.trackPath(engine.snapshot().index), "/m/a.mp3");
  } finally {
    engine.stop();
  }
});

test("tags for the library still land after an album was added underneath", () => {
  const engine = new PlayerEngine(
    ["/m/a.mp3", "/m/b.mp3"].map(track),
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  try {
    // The race this exists for: startup lists filenames and reads tags in the
    // background, and somebody adds an album before the tags come back. A
    // retag that insisted on the same list would have thrown all of them away.
    engine.add(["https://x.test/al/1.mp3"].map(track), "https://x.test/al/");
    engine.retag([{ path: "/m/a.mp3", title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 }], "/m");

    const after = engine.snapshot().tracks;
    assert.equal(after[0]?.title, "Bleed");
    assert.equal(after.length, 3);
    // And the album keeps its heading; the tagger has no opinion about that.
    assert.equal(after[2]?.group, "al");
  } finally {
    engine.stop();
  }
});

test("POST /api/source adds, and only says so when asked to replace", async () => {
  const engine = new PlayerEngine(
    ["/m/a.mp3", "/m/b.mp3"].map(track),
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    load: async (from: string) => [track(`${from}1.mp3`), track(`${from}2.mp3`)],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, path = "/api/source"): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const added = await post({ source: "https://x.test/album/" });
    assert.equal(added.status, 200);
    const first = (await added.json()) as { added: number; trackCount: number; groups: string[] };
    assert.equal(first.added, 2);
    // Four, not two: the default is to add, because losing a library to a
    // pasted URL is not what anybody meant by pasting one.
    assert.equal(first.trackCount, 4);
    assert.deepEqual(first.groups, ["album"]);

    const again = await post({ source: "https://x.test/album/" });
    const second = (await again.json()) as { added: number; trackCount: number };
    assert.equal(second.added, 0);
    assert.equal(second.trackCount, 4);

    const gone = await post({ group: "album" }, "/api/source/remove");
    assert.equal(gone.status, 200);
    assert.equal(((await gone.json()) as { trackCount: number }).trackCount, 2);
    assert.equal((await post({ group: "album" }, "/api/source/remove")).status, 404);

    const replaced = await post({ source: "https://x.test/other/", replace: true });
    const third = (await replaced.json()) as { replaced: boolean; trackCount: number };
    assert.equal(third.replaced, true);
    assert.equal(third.trackCount, 2);
    assert.equal(engine.trackPath(0), "https://x.test/other/1.mp3");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("the owner of a server can open it without hunting for its share link", async () => {
  // A key is how somebody who was invited proves it. It is not the only way to
  // be allowed in: signing in to nixamp.com as the person who owns this
  // machine was refused outright, so the address of your own server was
  // useless without a link you had to go and find.
  const site = (async (_url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ok = headers["authorization"] === "Bearer owners-token";
    return { ok, json: async () => (ok ? { account: { id: "owner-1" } } : {}) } as unknown as Response;
  }) as unknown as typeof fetch;

  const engine = new PlayerEngine(
    [{ path: "/m/a.mp3", title: "a", artist: "", album: "", duration: 0 }],
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    key: "control-key",
    owner: new Owner({ ownerId: "owner-1", site: "https://nixamp.com", fetcher: site }),
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Health answers anybody, which is why it is not proof of anything.
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    // No key, no account: still no.
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    // Somebody else's account: still no.
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { authorization: "Bearer someone-else" } })).status,
      401,
    );

    // The key works, as it always did.
    assert.equal((await fetch(`${base}/api/state?k=control-key`)).status, 200);
    // And so does being the owner, with no key anywhere in the request.
    const asOwner = await fetch(`${base}/api/state`, {
      headers: { authorization: "Bearer owners-token" },
    });
    assert.equal(asOwner.status, 200);
    assert.equal(((await asOwner.json()) as { trackCount: number }).trackCount, 1);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("restarting a daemon replays the flags it was started with", async () => {
  // The daemons worth restarting are the ones with the most flags -- a
  // certificate, a key, a public URL -- and finding them again meant shell
  // history or `ps`. What it was started with is recorded, so restarting it is
  // one word.
  const home = mkdtempSync(join(tmpdir(), "nixamp-daemon-"));
  const before = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = home;
  try {
    const d = await import("../src/daemon.ts");
    const dir = join(home, "nixamp");
    const started: string[][] = [];

    const state = {
      // Not this process, and not anything else: restarting stops what the
      // state file names first, and naming the test runner stops the test run.
      pid: 2_147_483_646,
      host: "127.0.0.1",
      port: 4321,
      key: "k",
      source: "/music",
      startedAt: 0,
      log: join(dir, "daemon.log"),
      argv: ["/music", "--tls-cert", "cert.pem", "--tls-key", "key.pem"],
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(state));

    // Nothing is really spawned: what is being checked is which arguments the
    // restart would hand over.
    const fakeStart = async (argv: string[]) => {
      started.push(argv);
      return { ...state, argv };
    };

    await d.restart([], "entry.js", fakeStart);
    assert.deepEqual(started[0], ["/music", "--tls-cert", "cert.pem", "--tls-key", "key.pem"]);

    // Given arguments of its own it uses those, which is how you change one
    // thing without stopping and starting by hand.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(state));
    await d.restart(["/other"], "entry.js", fakeStart);
    assert.deepEqual(started[1], ["/other"]);

    // A state file from an older nixamp recorded no flags, so restarting it
    // would be starting something else. It says so instead.
    mkdirSync(dir, { recursive: true });
    const { argv: _dropped, ...older } = state;
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(older));
    await assert.rejects(() => d.restart([], "entry.js", fakeStart), /did not record its flags/);
  } finally {
    if (before === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = before;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the admin report carries where OBS should point, one URL per stream", async () => {
  // Printed at startup since RTMP was added, which is no use to somebody
  // looking at the admin panel a day later. And there is deliberately no
  // single link: ffmpeg's RTMP listener takes one connection per process, so
  // three publishers at once is three ports and three URLs.
  const engine = new PlayerEngine(
    [{ path: "/m/a.mp3", title: "a", artist: "", album: "", duration: 0 }],
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const slots = [
    { id: "live", url: "rtmp://box:1935/live/KEY" },
    { id: "live-2", url: "rtmp://box:1936/live/KEY" },
  ];
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    publishUrls: () => slots,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json()) as {
      publish?: { id: string; url: string }[];
    };
    assert.deepEqual(body.publish, slots);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("a server that takes no RTMP reports no publish URLs rather than a wrong one", async () => {
  const engine = new PlayerEngine([], "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  const server = createServer(engine, { web: null, media: false, version: "test" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/connections`)).json()) as {
      publish?: unknown[];
    };
    assert.deepEqual(body.publish, []);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("an https link to a bare IP is offered last, and said to be uncertifiable", () => {
  // A certificate is issued for a name. Handed https://104.152.209.195:4321 a
  // browser has nothing to match it against and refuses before it asks
  // anything -- which from a page looks exactly like a machine that is off.
  // The server was printing those links beside the working one.
  assert.equal(certifiable("https://server1.chovy.nixamp.com:4321"), true);
  assert.equal(certifiable("https://104.152.209.195:4321"), false);
  assert.equal(certifiable("https://[2a0a:4cc0::1]:4321"), false);
  // Plain http never had a certificate to fail, so nothing is claimed.
  assert.equal(certifiable("http://104.152.209.195:4321"), true);

  const listed = reachableAddresses("0.0.0.0", 4321, "https://server1.chovy.nixamp.com:4321", "https");
  const names = listed.filter((entry) => certifiable(entry.url));
  const bare = listed.filter((entry) => !certifiable(entry.url));

  // The name this server actually has a certificate for comes first.
  assert.equal(listed[0]?.url, "https://server1.chovy.nixamp.com:4321");
  // Every address a browser could verify is offered before any it could not.
  assert.deepEqual(listed.slice(0, names.length), names);
  for (const entry of bare) assert.match(entry.label, /no certificate for an IP/);

  // Over http the order is untouched: there is no certificate to fail.
  const plain = reachableAddresses("0.0.0.0", 4321, "", "http");
  assert.ok(plain.every((entry) => !/no certificate/.test(entry.label)));
});

test("going live is something an admin does, not something startup asked once", async () => {
  // A server started with --no-publish had no listing, so no phone code and
  // nothing to hand anybody -- and no way to change its mind short of stopping
  // and starting it. That is why sharing felt like it did not exist.
  let live = false;
  const engine = new PlayerEngine([], "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    live: {
      status: () => ({
        live,
        code: live ? "482917" : "",
        name: "chovy",
        url: "https://server1.chovy.nixamp.com:4321/view/KEY",
        possible: true,
      }),
      start: async () => {
        live = true;
        return { live: true, code: "482917", name: "chovy", url: "https://server1.chovy.nixamp.com:4321/view/KEY" };
      },
      stop: async () => {
        live = false;
      },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const before = (await (await fetch(`${base}/api/live/state`)).json()) as { live: boolean; code: string };
    assert.equal(before.live, false);
    assert.equal(before.code, "");

    const started = (await (await fetch(`${base}/api/live/start`, { method: "POST" })).json()) as {
      live: boolean; code: string;
    };
    assert.equal(started.live, true);
    // The code is the point: it is what somebody keys on the phone.
    assert.equal(started.code, "482917");
    assert.equal(((await (await fetch(`${base}/api/live/state`)).json()) as { live: boolean }).live, true);

    await fetch(`${base}/api/live/stop`, { method: "POST" });
    assert.equal(((await (await fetch(`${base}/api/live/state`)).json()) as { live: boolean }).live, false);

    // GET is not how you change something.
    assert.equal((await fetch(`${base}/api/live/start`)).status, 405);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("a server that cannot be reached from outside says so rather than offering a button", async () => {
  const engine = new PlayerEngine([], "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  // No `live` at all: an older server, or one built without it.
  const server = createServer(engine, { web: null, media: false, version: "test" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const state = (await (await fetch(`http://127.0.0.1:${port}/api/live/state`)).json()) as {
      live: boolean; possible: boolean;
    };
    assert.equal(state.live, false);
    assert.equal(state.possible, false);
    // And asking it to go live is refused with a reason, not a crash.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/live/start`, { method: "POST" })).status, 409);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("a source ffmpeg cannot read is a 502, not the end of the server", async () => {
  // The crash this exists for. A live .ts URL that answered with something
  // ffmpeg could not parse made ffmpeg exit instantly without writing a byte.
  // Piping stdout to the response ends the response when stdout ends, which
  // commits the headers -- and the close handler then tried to send a 502 over
  // them and threw ERR_HTTP_HEADERS_SENT from a child-process callback, where
  // nothing can catch it. The process died and took every listener with it.
  const engine = new PlayerEngine(
    // Remote and named as a film, so the request reaches the video pipeline.
    [{ path: "http://x.test/live/28441.mkv", title: "28441", artist: "", album: "", duration: 0 }],
    "http://x.test/live/",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const server = createServer(engine, {
    web: null,
    media: true,
    version: "test",
    // Says there is a picture, so the video path is taken rather than audio.
    // `sh -c` rather than `echo`: ffprobe's own arguments are appended to
    // whatever is spawned, and echo would print them after the JSON, so
    // nothing parsed and the video path was never reached. Here they arrive
    // as positional parameters the script ignores.
    ffprobe: ["sh", "-c", 'echo \'{"streams":[{"codec_type":"video","codec_name":"h264"}]}\''],
    // Exits non-zero at once, having written nothing: exactly what ffmpeg did.
    ffmpeg: ["false"],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const answer = await fetch(`${base}/api/media/0`);
    // Either an honest failure or an empty body -- but never a dead server.
    assert.ok(answer.status === 502 || answer.status === 200, `unexpected ${answer.status}`);
    await answer.arrayBuffer();

    // The point of the whole test: it is still here afterwards.
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const state = await fetch(`${base}/api/state`);
    assert.equal(state.status, 200);

    // And it survives being asked twice, because a person retries.
    await (await fetch(`${base}/api/media/0`)).arrayBuffer();
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("a link cannot claim to be one thing and carry the other", async () => {
  // `/a/` administers and `/v/` only views, and the point of naming them is
  // that somebody can tell which they were sent. A path that accepted either
  // key would make that a label rather than a fact -- and the dangerous
  // direction is real: a `/v/` link built around the control key reads as
  // view-only to whoever you send it to and hands them the controls.
  const engine = new PlayerEngine([], "/m", { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null });
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    key: "control-key",
    listenKey: "listen-key",
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const open = (path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: "manual" });

  try {
    // Each key at its own door.
    assert.equal((await open("/admin/control-key")).status, 302);
    assert.equal((await open("/view/listen-key")).status, 302);

    // And at the other one, refused -- the view link may not carry the
    // controls, and the admin link is not what a viewer was given.
    assert.equal((await open("/view/control-key")).status, 404);
    assert.equal((await open("/admin/listen-key")).status, 404);

    // Answered exactly as a key that is simply wrong, so the difference
    // between "wrong key" and "wrong door" tells an attacker nothing.
    assert.equal((await open("/admin/nonsense")).status, 404);
    assert.equal((await open("/view/nonsense")).status, 404);

    // The shape that said neither is gone. It is an ordinary path now, and an
    // ordinary path without a key is a 401.
    assert.equal((await open("/s/control-key")).status, 401);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("what is live on a server is one list, readable by anybody it let in", async () => {
  // Two different things are live on a server -- its own playlist, which is
  // what the directory lists it as, and anybody publishing into it from OBS or
  // a phone -- and they were only ever visible in two different places. Asked
  // "what is on here?", a person connected to a server had nowhere to look.
  const engine = new PlayerEngine(
    ["/m/a.mp3", "/m/b.mp3"].map((path) => ({ path, title: path, artist: "", album: "", duration: 0 })),
    "/m",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    serverName: "chovy's box",
    live: {
      status: () => ({
        live: true, code: "482917", name: "chovy's box",
        url: "https://server1.chovy.nixamp.com:4321/view/VIEW", possible: true,
      }),
      start: async () => ({ live: true, code: "482917", name: "", url: "" }),
      stop: async () => {},
    },
    channels: {
      list: () => [
        { id: "live", name: "an RTMP publisher", format: "flv", via: "rtmp" as const,
          startedAt: 1, bytes: 10, listeners: 2 },
      ],
      listeners: 2,
    } as unknown as Parameters<typeof createServer>[1]["channels"],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;

  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/streams`)).json()) as {
      server: { name: string; nowPlaying: string; tracks: number; live: boolean; code: string; url: string };
      channels: { id: string; name: string; via: string; listeners: number }[];
    };

    // The server's own stream, named, with the code somebody dials and the
    // link they can be sent -- the viewing one, never the one that drives.
    assert.equal(body.server.name, "chovy's box");
    assert.equal(body.server.tracks, 2);
    assert.equal(body.server.live, true);
    assert.equal(body.server.code, "482917");
    assert.match(body.server.url, /\/view\//);
    assert.ok(!body.server.url.includes("/admin/"), "the list must not hand out the controls");

    // And whoever is publishing into it.
    assert.equal(body.channels.length, 1);
    assert.equal(body.channels[0]?.name, "an RTMP publisher");
    assert.equal(body.channels[0]?.via, "rtmp");
    assert.equal(body.channels[0]?.listeners, 2);

    // Nothing here says how to change anything, which is why it is readable by
    // somebody holding the viewing link rather than only by an administrator.
    assert.equal(JSON.stringify(body).includes("rtmp://"), false, "no publish address leaks to a viewer");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("a track that turns out to have a picture stops claiming to be a song", async () => {
  // Whether a track is a film is worked out when it is added, and for an
  // address with no extension that means asking ffprobe. A track added before
  // that could be asked -- by an older nixamp, or on a machine that could not
  // find ffprobe -- kept the wrong answer for ever, so every remote went on
  // putting a television channel into an audio element and the only cure was
  // noticing and adding it again. Streaming it is when the truth is certain.
  const engine = new PlayerEngine(
    // No extension, so nothing about the name says either way -- an IPTV
    // channel, which is exactly the case this is about.
    [{ path: "http://x.test/live/932", title: "932", artist: "", album: "", duration: 0 }],
    "http://x.test/live/",
    { ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null },
  );
  const server = createServer(engine, {
    web: null,
    media: true,
    version: "test",
    // Says there is a picture, which is what the real ffprobe says about it.
    // `sh -c` rather than `echo`: ffprobe's own arguments are appended to
    // whatever is spawned, and echo would print them after the JSON, so
    // nothing parsed and the video path was never reached. Here they arrive
    // as positional parameters the script ignores.
    ffprobe: ["sh", "-c", 'echo \'{"streams":[{"codec_type":"video","codec_name":"h264"}]}\''],
    ffmpeg: ["true"],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // As the playlist starts: a film, described as a song.
    const before = (await (await fetch(`${base}/api/state`)).json()) as { tracks: { video?: boolean }[] };
    assert.equal(before.tracks[0]?.video, undefined);

    // Somebody plays it. The server has to look inside to serve it, and that
    // is the moment it learns what it is.
    await (await fetch(`${base}/api/media/0`)).arrayBuffer();

    const after = (await (await fetch(`${base}/api/state`)).json()) as { tracks: { video?: boolean }[] };
    assert.equal(after.tracks[0]?.video, true, "the playlist did not learn from streaming it");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

test("only the account that published a stream can take it off the list", async () => {
  // A listing id is in every copy of the directory, and delisting asked
  // nobody anything -- so anyone who could read the list could empty it of
  // other people's streams. The publisher was already sending its token; it
  // was simply never looked at.
  const directory = new Directory({ now: () => 1_000 });
  const accounts = {
    whoIs: async (token: string) =>
      token === "mine" ? { id: "owner-1", email: "me@example.com" }
        : token === "theirs" ? { id: "owner-2", email: "them@example.com" }
          : null,
  } as unknown as Parameters<typeof createServer>[1]["accounts"];

  const server = createServer(new EmptyEngine(), {
    web: null,
    media: false,
    version: "test",
    directory,
    accounts,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const mine = directory.announce(
    { name: "chovy", url: "https://a.example/view/k", tracks: 1, nowPlaying: "x" },
    "owner-1",
  );
  const ownerless = directory.announce(
    { name: "nobody", url: "https://b.example/view/k", tracks: 1, nowPlaying: "x" },
    "",
  );

  const remove = (id: string, token?: string): Promise<Response> =>
    fetch(`${base}/api/directory?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  try {
    // A stranger, and somebody else's account: neither may.
    assert.equal((await remove(mine.id)).status, 403);
    assert.equal((await remove(mine.id, "theirs")).status, 403);
    assert.equal(directory.list().length, 2, "a refused delete must not delete");

    // A listing nobody can prove they own is nobody's to remove either; it
    // leaves on its own when it stops renewing.
    assert.equal((await remove(ownerless.id, "mine")).status, 403);

    // The account that published it may.
    assert.equal((await remove(mine.id, "mine")).status, 200);
    assert.equal(directory.list().find((one) => one.id === mine.id), undefined);

    // And asking again says so rather than pretending.
    assert.equal((await remove(mine.id, "mine")).status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an administrator is told where a server's own files are, and a viewer is not", async () => {
  // Replacing the playlist with a stream leaves nothing pointing at the
  // library the server was started on, and its address is a path on a machine
  // you may never have logged into -- so there was no way back to it short of
  // restarting the daemon. It is reported, so there can be a button.
  const engine = new PlayerEngine([], "http://x.test/live/932", {
    ffmpeg: ["ffmpeg"], ffprobe: ["ffprobe"], play: null,
  });
  const server = createServer(engine, {
    web: null,
    media: false,
    version: "test",
    serverName: "chovy's box",
    homeSource: "/home/ubuntu/Downloads/done",
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const report = (await (await fetch(`${base}/api/connections`)).json()) as {
      home?: string; root?: string;
    };
    assert.equal(report.home, "/home/ubuntu/Downloads/done");
    // And what is loaded right now, so the page can tell whether the library
    // is in the playlist or has been replaced by something else.
    assert.equal(report.root, "http://x.test/live/932");

    // A filesystem path is an administrator's business. What a viewer is shown
    // names streams and how to reach them, and nothing about the disk.
    const streams = await (await fetch(`${base}/api/streams`)).text();
    assert.equal(streams.includes("/home/ubuntu"), false, "a path leaked to the viewing side");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    engine.stop();
  }
});

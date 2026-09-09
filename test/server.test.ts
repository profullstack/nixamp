import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  contentType, createServer, DEFAULT_PORT, EmptyEngine, PlayerEngine,
  parseRange, parseServeArgs, safeJoin, toRemoteTracks,
  type Engine,
} from "../src/server.ts";
import { emptySnapshot, parseCommand, remoteName, type Command, type Snapshot } from "../src/protocol.ts";
import { reachableAddresses } from "../src/share.ts";

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
    "/a/../../../etc/passwd",
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

    // A list that is not this list belongs to somebody else: a re-stream landed
    // while the tagging was still running, and these tags describe nothing here.
    engine.retag([{ path: "/other/z.mp3", title: "Z", artist: "", album: "", duration: 1 }], "/m");
    assert.equal(engine.snapshot().tracks.length, 2);
    engine.retag(tagged, "/somewhere-else");
    assert.equal(engine.snapshot().tracks[0]?.title, "Bleed");
  } finally {
    engine.stop();
  }
});

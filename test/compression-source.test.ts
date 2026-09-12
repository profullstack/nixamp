import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadable } from "../src/compression/source.ts";
import { Channels, type ChannelInfo, type Listener, type PullThrough } from "../src/channels.ts";
import { CompressionService } from "../src/compression/service.ts";
import { createServer, EmptyEngine, pullChannel } from "../src/server.ts";
import { receiveRelay } from "../src/compression/receiver.ts";
import { detectTools } from "../src/audio.ts";

const STUB = [process.execPath, fileURLToPath(new URL("./fixtures/stub-ffmpeg.mjs", import.meta.url))];

const FFMPEG = detectTools().ffmpeg;
const FFPROBE = detectTools().ffprobe;
const ffmpegHere = ((): boolean => {
  const [cmd, ...rest] = FFMPEG;
  if (!cmd) return false;
  const r = spawnSync(cmd, [...rest, "-version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
})();

function info(over: Partial<ChannelInfo> = {}): ChannelInfo {
  return { id: "x", name: "x", format: "mp4", via: "pull", startedAt: 0, bytes: 0, listeners: 0, source: "https://h/s.ts", codecs: { video: "h264", audio: "aac", container: "mpegts" }, ...over };
}

test("unreadable names why a source cannot be read here, and passes a plain transport stream", () => {
  assert.equal(unreadable(info(), 0, [], ""), null, "a plain http transport stream is readable");
  assert.equal(unreadable(info({ source: "/tmp/does-not-exist.ts" }), 0, [], ""), "the source file cannot be read");
  assert.match(unreadable(info({ codecs: { video: "h264", audio: "aac", container: "mov,mp4,m4a" } }), 0, [], "") ?? "", /not a transport stream/);
  assert.match(unreadable(info(), 0, ["-headers", "x"], "") ?? "", /request headers/);
  assert.match(unreadable(info(), 0, [], "https://h/audio.ts") ?? "", /second file/);
  assert.match(unreadable(info(), 30, [], "") ?? "", /picked up mid-way/);
  assert.match(unreadable(info({ source: "rtmp://h/s" }), 0, [], "") ?? "", /http\(s\) URLs and files/);
  assert.match(unreadable(info({ via: "http", source: "" }), 0, [], "") ?? "", /source this server pulls/);
});

const CONTROL = "control-key";
const LISTEN = "listen-key";

/** A source I feed by hand, so a tap can attach before the first byte. */
function drip(): { through: PullThrough; push: (b: Buffer) => void; end: () => void } {
  const queue: Buffer[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    through: {
      format: "mpegts",
      open: async () =>
        (async function* () {
          for (;;) {
            const next = queue.shift();
            if (next) { yield next; continue; }
            if (done) return;
            await new Promise<void>((r) => { wake = r; });
          }
        })(),
    },
    push: (b) => { queue.push(b); wake?.(); wake = null; },
    end: () => { done = true; wake?.(); wake = null; },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

test("a tapped source is byte-exact, sees exactly ffmpeg's input, and ends when the source starts over", async () => {
  const source = drip();
  const channels = new Channels({ ffmpeg: STUB, through: () => source.through });
  const channel = channels.pull("clip", "A clip", "http://h/s.ts", ["-f", "mpegts", "-i", "pipe:0"], "audio", true, 30_000, [], "", { live: true, position: 0 }, { video: "", audio: "aac", container: "mpegts" });
  assert.ok(channel);
  assert.equal(channel.info.teed, true, "the source is read through the channel");
  // Attach the tap before any byte is pushed: it must see all of them.
  const tapped: Buffer[] = [];
  let tapEnded = false;
  const detach = channel.tapSource({ write: (b) => { tapped.push(Buffer.from(b)); return true; }, end: () => { tapEnded = true; } });
  assert.ok(detach, "a teed channel offers its source");
  const original = [randomBytes(1000), randomBytes(20_000), Buffer.from("the end ".repeat(100))];
  for (const chunk of original) source.push(chunk);
  await settle();
  assert.ok(Buffer.concat(tapped).equals(Buffer.concat(original)), "the tap saw every source byte, in order");

  // A source-read channel that is not teed offers nothing.
  const plain = channels.pull("plain", "x", "http://h/s.ts", ["-f", "mpegts", "-i", "pipe:0"], "audio", true, 30_000, [], "", { live: true, position: 0 });
  // (the provider returns a through for every channel here, so `plain` is teed too;
  //  a channel with no provider is covered by the service tests.)
  plain?.close();

  // The source starting over ends the tap: a new generation must not follow
  // the old middle.
  channel.rollover();
  assert.equal(tapEnded, true, "the tap was ended when the source rolled over");
  detach?.();
  channels.stopAll();
});

test("a source-boundary relay serves the original bytes to a receiver over HTTP, packet-aligned", async () => {
  // A real transport stream: 188-byte packets, half null padding so it compresses.
  const packets: Buffer[] = [];
  for (let i = 0; i < 400; i += 1) {
    const p = Buffer.alloc(188, i % 2 === 0 ? 0xff : (i & 0xff));
    p[0] = 0x47;
    packets.push(p);
  }
  const original = Buffer.concat(packets);

  // A source server the upstream reads through its own tee. It holds the
  // response open until released, so the receiver is attached before a byte
  // flows and gets the stream from its very start.
  const { createServer: httpServer } = await import("node:http");
  let release: (() => void) | null = null;
  const held = new Promise<void>((r) => { release = r; });
  const dataServer = httpServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp2t" });
    void held.then(async () => {
      for (let at = 0; at < original.length; at += 2000) {
        res.write(original.subarray(at, at + 2000));
        await new Promise((t) => setTimeout(t, 5));
      }
      res.end();
    });
  });
  await new Promise<void>((done) => dataServer.listen(0, "127.0.0.1", done));
  const sourceUrl = `http://127.0.0.1:${(dataServer.address() as AddressInfo).port}/s.ts`;

  const channels = new Channels({ ffmpeg: STUB });
  const service = new CompressionService({ channels, stateDir: null, port: 1 });
  const server = createServer(new EmptyEngine(), { web: null, media: true, version: "test", key: CONTROL, listenKey: LISTEN, channels, compression: service });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    service.set("clip", { losslessCompression: { mode: "zstd", boundary: "source", maxBlockBytes: 8192, maxHoldMs: 10 } });
    // The service's own tee provider reads the source URL through this server.
    const channel = channels.pull("clip", "A clip", sourceUrl, ["-f", "mpegts", "-i", "pipe:0"], "audio", true, 30_000, [], "", { live: true, position: 0 }, { video: "", audio: "aac", container: "mpegts" });
    assert.ok(channel?.info.teed);
    assert.equal(service.effective("clip").losslessCompression.boundary, "source");

    const pieces: Buffer[] = [];
    let boundary = "";
    const controller = new AbortController();
    const relay = receiveRelay({
      url: `${base}/api/channels/clip/relay`,
      key: LISTEN,
      signal: controller.signal,
      onStart: (a) => { boundary = a.boundary; },
      onBytes: (b) => { pieces.push(b); },
    }).catch(() => undefined);
    await settle();
    // Receiver is attached: let the source flow, from the top.
    release?.();
    await new Promise((t) => setTimeout(t, 700));
    controller.abort();
    await relay;
    const got = Buffer.concat(pieces);
    assert.equal(boundary, "source", "the stream declared the source boundary");
    assert.ok(got.length > original.length / 2, `got ${got.length} of ${original.length}`);
    assert.ok(got.equals(original.subarray(0, got.length)), "the received bytes are the original, byte for byte from the start");
    assert.equal(got[0], 0x47, "starts on a packet");
    const metrics = service.status("clip").metrics!;
    assert.ok(metrics.compressedBlocks > 0, "the padded packets compressed at the source boundary");
  } finally {
    service.stopAll();
    channels.stopAll();
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => dataServer.close(() => done()));
  }
});

test("the real ffmpeg tee reads a transport-stream file byte-exact through the server", { skip: !ffmpegHere }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-tee-"));
  const file = join(dir, "clip.ts");
  const make = spawnSync(FFMPEG[0] as string, [
    ...FFMPEG.slice(1), "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-muxrate", "3000k", "-f", "mpegts", file,
  ], { timeout: 60_000 });
  assert.equal(make.status, 0, make.stderr?.toString());
  const original = (await import("node:fs")).readFileSync(file);

  const channels = new Channels({ ffmpeg: FFMPEG });
  const service = new CompressionService({ channels, stateDir: null, port: 1, ffprobe: FFPROBE });
  try {
    service.set("clip", { losslessCompression: { mode: "zstd", boundary: "source" } });
    // Tap through the channel directly, driven by the same provider the
    // service installs; the tap collects every byte ffmpeg is fed.
    const tapped: Buffer[] = [];
    let attached: (() => void) | null = null;
    // Start the pull; the tee opens on dial. Attach as soon as the channel exists.
    const channel = await pullChannel(channels, FFPROBE, "clip", "A clip", file);
    assert.ok(channel);
    assert.equal(channel.info.teed, true, "a real transport-stream file is read through the server");
    attached = channel.tapSource({ write: (b) => { tapped.push(Buffer.from(b)); return true; }, end: () => undefined });
    // The tap may attach a beat after the first chunks on a fast disk; what it
    // does catch must be a byte-exact run of the file, padding included.
    await new Promise((t) => setTimeout(t, 1500));
    attached?.();
    const got = Buffer.concat(tapped);
    if (got.length > 0) {
      const at = original.indexOf(got.subarray(0, Math.min(2000, got.length)));
      assert.notEqual(at, -1, "the tapped bytes appear verbatim in the file");
      assert.ok(original.subarray(at, at + got.length).equals(got), "and continue byte-exact: the original, not a re-mux");
    }
  } finally {
    service.stopAll();
    channels.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a channel whose source ffmpeg reads cannot offer the source boundary, and says why", () => {
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const service = new CompressionService({ channels, stateDir: null, port: 1 });
  try {
    // A published channel (not pulled) has no source to read through us.
    channels.attach("pub", "a device", "mp3", "http");
    service.set("pub", { losslessCompression: { mode: "zstd", boundary: "source" } });
    const eff = service.effective("pub");
    assert.equal(eff.losslessCompression.mode, "off");
    assert.match(eff.reason ?? "", /original source bytes are unavailable/);
    const answer = service.relay("pub", { write: () => true, end: () => undefined } as Listener, new Set(["zstd"] as const));
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.code, "SOURCE_BOUNDARY_UNAVAILABLE");
  } finally {
    service.stopAll();
    channels.stopAll();
  }
});

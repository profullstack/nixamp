import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, EmptyEngine } from "../src/server.ts";
import { Channels } from "../src/channels.ts";
import { CompressionService, STATIC_CHANNEL } from "../src/compression/service.ts";
import { MEDIA_TYPE } from "../src/compression/envelope.ts";
import { receiveRelay, RelayRefused } from "../src/compression/receiver.ts";
import { RelayDecoder } from "../src/compression/relay.ts";
import type { ChannelStatus } from "../src/compression/service.ts";

const CONTROL = "control-key";
const LISTEN = "listen-key";

interface Started {
  base: string;
  channels: Channels;
  compression: CompressionService;
  stop: () => Promise<void>;
}

async function start(cacheDir: string | null = null): Promise<Started> {
  const channels = new Channels({ ffmpeg: ["ffmpeg"] });
  const compression = new CompressionService({ channels, stateDir: null, port: 1, cacheDir });
  const server = createServer(new EmptyEngine(), { web: null, media: true, version: "test", key: CONTROL, listenKey: LISTEN, channels, compression });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    channels,
    compression,
    stop: async () => {
      compression.stopAll();
      channels.stopAll();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const withKey = (key: string, more: Record<string, string> = {}): Record<string, string> => ({ "x-nixamp-key": key, ...more });

test("the policy routes: read with the listen key, change with the controls and the version you saw", async () => {
  const s = await start();
  try {
    const seen = await fetch(`${s.base}/api/channels/main/compression`, { headers: withKey(LISTEN) });
    assert.equal(seen.status, 200);
    const status = (await seen.json()) as ChannelStatus;
    assert.equal(status.configured.losslessCompression.mode, "off");
    assert.equal(status.live, false);

    const refused = await fetch(`${s.base}/api/channels/main/compression`, {
      method: "PATCH", headers: withKey(LISTEN, { "content-type": "application/json" }), body: JSON.stringify({ losslessCompression: { mode: "auto" } }),
    });
    assert.equal(refused.status, 403, "the listen key cannot change a policy");

    const changed = await fetch(`${s.base}/api/channels/main/compression`, {
      method: "PATCH", headers: withKey(CONTROL, { "content-type": "application/json", "if-match": '"0"' }), body: JSON.stringify({ losslessCompression: { mode: "auto" }, hlsPackaging: "fmp4" }),
    });
    assert.equal(changed.status, 200);
    const after = (await changed.json()) as ChannelStatus;
    assert.equal(after.configured.losslessCompression.mode, "auto");
    assert.equal(after.configured.hlsPackaging, "fmp4");
    assert.equal(after.configured.version, 1);
    assert.equal(after.configured.qualityProfile, "source", "turning compression on did not touch the quality");

    const stale = await fetch(`${s.base}/api/channels/main/compression`, {
      method: "PATCH", headers: withKey(CONTROL, { "content-type": "application/json", "if-match": '"0"' }), body: JSON.stringify({ losslessCompression: { mode: "zstd" } }),
    });
    assert.equal(stale.status, 412);
    const bad = await fetch(`${s.base}/api/channels/main/compression`, {
      method: "PATCH", headers: withKey(CONTROL, { "content-type": "application/json" }), body: JSON.stringify({ qualityProfile: "low" }),
    });
    assert.equal(bad.status, 400);
    assert.ok(((await bad.json()) as { error: string }).error.includes("qualityProfile"));

    const overview = await fetch(`${s.base}/api/compression`, { headers: withKey(LISTEN) });
    assert.equal(overview.status, 200);
    const all = (await overview.json()) as { global: { enabled: boolean }; channels: ChannelStatus[] };
    assert.equal(all.global.enabled, true);
    assert.deepEqual(all.channels.map((c) => c.channel), ["main"]);

    const off = await fetch(`${s.base}/api/compression`, { method: "PATCH", headers: withKey(CONTROL, { "content-type": "application/json" }), body: JSON.stringify({ enabled: false }) });
    assert.equal(off.status, 200);
    const now = (await (await fetch(`${s.base}/api/channels/main/compression`, { headers: withKey(LISTEN) })).json()) as ChannelStatus;
    assert.equal(now.effective.losslessCompression.mode, "off");
    assert.ok(now.effective.reason?.includes("whole server"));
  } finally {
    await s.stop();
  }
});

test("a relay is negotiated by media type and codec list, and the ordinary channel URL is untouched", async () => {
  const s = await start();
  try {
    const channel = s.channels.attach("live", "a device", "mp3", "http")!;
    const text = Buffer.from("the same frame again ".repeat(3000));
    channel.feed(text);

    const browser = await fetch(`${s.base}/api/channels/live/relay`, { headers: withKey(LISTEN) });
    assert.equal(browser.status, 406, "a player that followed the link is told where to go");
    assert.equal(((await browser.json()) as { playback: string }).playback, "/api/channels/live");

    const off = await fetch(`${s.base}/api/channels/live/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE, "x-nixamp-stream-codecs": "zstd" }) });
    assert.equal(off.status, 409);
    assert.equal(((await off.json()) as { code: string }).code, "COMPRESSION_OFF");

    s.compression.set("live", { losslessCompression: { mode: "zstd", maxBlockBytes: 8192, maxHoldMs: 10 } });
    const ranged = await fetch(`${s.base}/api/channels/live/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE, "x-nixamp-stream-codecs": "zstd", range: "bytes=0-100" }) });
    assert.equal(ranged.status, 416, "never the wrong range, always a refusal");
    const deaf = await fetch(`${s.base}/api/channels/live/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE, "x-nixamp-stream-codecs": "brotli" }) });
    assert.equal(deaf.status, 406);

    // A real receiver: the backlog it is handed, then the live bytes, then the clean end.
    const pieces: Buffer[] = [];
    let accepted: { codecs: string; kind: string } | null = null;
    const done = receiveRelay({
      url: `${s.base}/api/channels/live/relay`,
      key: LISTEN,
      onStart: (info) => { accepted = info; },
      onBytes: (b) => { pieces.push(b); },
    });
    await new Promise((tick) => setTimeout(tick, 100));
    const live = Buffer.concat([text, randomBytes(20_000)]);
    channel.feed(live);
    await new Promise((tick) => setTimeout(tick, 100));
    assert.equal(s.compression.status("live").relay?.sessions, 1);
    channel.close();
    const result = await done;
    assert.ok(accepted, "told what it would get before any byte");
    assert.equal(accepted!.codecs, "stored,zstd");
    assert.equal(result.bytes, live.length);
    const got = Buffer.concat(pieces);
    // A published channel keeps no backlog (only a pulled one does), so the
    // preface is empty and the receiver gets exactly the live bytes.
    assert.ok(got.equals(live), "the live bytes arrived, whole, and nothing else");
    const metrics = s.compression.status("live").metrics!;
    assert.ok(metrics.compressedBlocks > 0, "the text compressed");
    assert.ok(metrics.storedBlocks > 0, "the noise was stored");
  } finally {
    await s.stop();
  }
});

test("one nixamp pulls another's channel in, and a listener here hears the original bytes", async () => {
  const upstream = await start();
  const downstream = await start();
  try {
    const source = upstream.channels.attach("radio", "a device", "mp3", "http")!;
    upstream.compression.set("radio", { losslessCompression: { mode: "zstd", maxBlockBytes: 8192, maxHoldMs: 10 } });
    source.feed(Buffer.from("intro ".repeat(2000)));

    const refused = await fetch(`${downstream.base}/api/channels/radio/relay`, {
      method: "POST", headers: withKey(LISTEN, { "content-type": "application/json" }), body: JSON.stringify({ from: `${upstream.base}/api/channels/radio/relay`, key: LISTEN }),
    });
    assert.equal(refused.status, 403);
    const started = await fetch(`${downstream.base}/api/channels/radio/relay`, {
      method: "POST", headers: withKey(CONTROL, { "content-type": "application/json" }), body: JSON.stringify({ from: `${upstream.base}/api/channels/radio/relay`, key: LISTEN, name: "Radio, relayed" }),
    });
    assert.equal(started.status, 202);
    await new Promise((tick) => setTimeout(tick, 200));
    assert.ok(downstream.channels.has("radio"), "the channel exists here now");
    const listed = (await (await fetch(`${downstream.base}/api/channels`, { headers: withKey(LISTEN) })).json()) as { channels: { id: string; via: string; source?: string }[] };
    assert.equal(listed.channels[0]?.via, "relay");
    assert.equal(listed.channels[0]?.source, undefined, "where it comes from is not for listeners");

    // Somebody listening here, the ordinary way.
    const heard: Buffer[] = [];
    const listening = fetch(`${downstream.base}/api/channels/radio`, { headers: withKey(LISTEN) }).then(async (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      const reader = response.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        heard.push(Buffer.from(value));
      }
    });
    await new Promise((tick) => setTimeout(tick, 100));
    const live = randomBytes(30_000);
    source.feed(live);
    await new Promise((tick) => setTimeout(tick, 200));
    const status = downstream.compression.status("radio");
    assert.equal(status.incoming?.from, `${upstream.base}/api/channels/radio/relay`);
    assert.equal(status.incoming?.error, null);

    const stopped = await fetch(`${downstream.base}/api/channels/radio`, { method: "DELETE", headers: withKey(CONTROL) });
    assert.equal(stopped.status, 200);
    await listening;
    const all = Buffer.concat(heard);
    assert.ok(all.subarray(all.length - live.length).equals(live), "the listener here got the live bytes byte for byte");
    assert.equal(downstream.channels.has("radio"), false);
    assert.equal(downstream.compression.status("radio").incoming, null, "and the relay stopped dialling");
  } finally {
    await downstream.stop();
    await upstream.stop();
  }
});

test("a library file's relay representation is built in the background, then served whole and exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-static-route-"));
  const s = await start(join(dir, "cache"));
  try {
    const file = join(dir, "song.mp3");
    const content = Buffer.concat([Buffer.from("ID3"), Buffer.from("verse ".repeat(20_000)), randomBytes(30_000)]);
    writeFileSync(file, content);
    // The engine is empty; a track path comes from the library. Stand one in.
    const engine = new EmptyEngine();
    engine.trackPath = (index: number) => (index === 0 ? file : undefined);
    const channels = new Channels({ ffmpeg: ["ffmpeg"] });
    const compression = new CompressionService({ channels, stateDir: null, port: 2, cacheDir: join(dir, "cache2") });
    const server = createServer(engine, { web: null, media: true, version: "test", key: CONTROL, listenKey: LISTEN, channels, compression });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const off = await fetch(`${base}/api/media/0/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE }) });
      assert.equal(off.status, 409, "off until the static policy says otherwise");
      compression.set(STATIC_CHANNEL, { losslessCompression: { mode: "zstd" } });
      const first = await fetch(`${base}/api/media/0/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE }) });
      assert.equal(first.status, 202, "building; come back");
      let ready: Response | null = null;
      for (let i = 0; i < 50 && !ready; i += 1) {
        await new Promise((tick) => setTimeout(tick, 50));
        const poll = await fetch(`${base}/api/media/0/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE }) });
        if (poll.status === 200) ready = poll;
      }
      assert.ok(ready, "built");
      assert.ok(ready!.headers.get("content-type")?.startsWith(MEDIA_TYPE));
      assert.equal(ready!.headers.get("x-nixamp-original-length"), String(content.length));
      const body = Buffer.from(await ready!.arrayBuffer());
      assert.equal(body.length, Number(ready!.headers.get("content-length")));
      assert.ok(body.length < content.length, "the verse compressed");
      const pieces: Buffer[] = [];
      const decoder = new RelayDecoder({ modes: new Set(["stored", "zstd", "ts-zstd"] as const), onBytes: (b) => { pieces.push(b); } });
      await decoder.feed(body);
      await decoder.end();
      assert.ok(Buffer.concat(pieces).equals(content));
      const ranged = await fetch(`${base}/api/media/0/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE, range: "bytes=0-10" }) });
      assert.equal(ranged.status, 416);
      const player = await fetch(`${base}/api/media/0/relay`, { headers: withKey(LISTEN) });
      assert.equal(player.status, 406);
      const missing = await fetch(`${base}/api/media/7/relay`, { headers: withKey(LISTEN, { accept: MEDIA_TYPE }) });
      assert.equal(missing.status, 404);
      await assert.rejects(receiveRelay({ url: `${base}/api/media/7/relay`, key: LISTEN, onBytes: () => undefined }), (e: RelayRefused) => e.status === 404);
    } finally {
      compression.stopAll();
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

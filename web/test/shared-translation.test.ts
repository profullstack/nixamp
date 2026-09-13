import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedAudio } from "../src/shared-translation.ts";
import type { SharedEvent } from "../../src/shared-translation.ts";
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const line = (id: number) => ({ channel: "dub-test", language: "de", at: Date.now() + id, until: Date.now() + id, text: `Satz ${id}.` });
const send = (sink: ReadableStreamDefaultController<Uint8Array>, event: SharedEvent) => sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));

test("skipped live clips stay bounded without killing playback after 24 phrases", async () => {
  let sink!: ReadableStreamDefaultController<Uint8Array>, last = "", count = 0;
  const audio = new SharedAudio({ line: (_line, url) => { last = url; count++; }, status() {}, failed: error => assert.fail(error),
    fetcher: (async () => new Response(new ReadableStream({ start: controller => { sink = controller; } }))) as typeof fetch });
  try {
    await audio.start("https://example.com/api/channels/nfl", "de");
    for (let id = 0; id < 200; id++) {
      send(sink, { type: "line", id: String(id), line: line(id) });
      send(sink, { type: "audio", id: String(id), data: "AEAAQA==" });
      send(sink, { type: "end", id: String(id) });
    }
    await settle(); assert.equal(count, 200);
    assert.deepEqual(new Uint8Array(await audio.audio(last).arrayBuffer()), new Uint8Array([0, 64, 0, 64]));
  } finally { audio.stop(); }
});

test("network disconnect reconnects the same source and language; stopping cancels retry", async () => {
  const sinks: ReadableStreamDefaultController<Uint8Array>[] = [], asks: unknown[] = [];
  let resets = 0, lines = 0;
  const audio = new SharedAudio({ line: () => { lines++; }, status() {}, failed: error => assert.fail(error), reconnecting: () => { resets++; },
    fetcher: (async (_url, init) => { asks.push(JSON.parse(String(init?.body))); return new Response(new ReadableStream({ start: controller => { sinks.push(controller); } })); }) as typeof fetch });
  try {
    await audio.start("https://example.com/api/channels/nfl", "de");
    sinks[0]!.close(); await settle(550);
    assert.equal(asks.length, 2); assert.deepEqual(asks[0], asks[1]); assert.equal(resets, 1);
    send(sinks[1]!, { type: "line", id: "recovered", line: line(1) }); await settle(); assert.equal(lines, 1);
    sinks[1]!.close(); await settle(); audio.stop(); await settle(1050);
    assert.equal(asks.length, 2, "off must cancel a pending reconnect");
  } finally { audio.stop(); }
});

test("access and usage-limit failures do not retry or open another free session", async () => {
  for (const status of [401, 402, 429]) {
    let sink!: ReadableStreamDefaultController<Uint8Array>, calls = 0;
    const failures: string[] = [];
    const audio = new SharedAudio({ line() {}, status() {}, failed: error => failures.push(error),
      fetcher: (async () => {
        if (++calls > 1) return Response.json({ error: `Limit ${status}` }, { status });
        return new Response(new ReadableStream({ start: controller => { sink = controller; } }));
      }) as typeof fetch });
    try {
      await audio.start("https://example.com/api/channels/nfl", "de"); sink.close(); await settle(550);
      assert.equal(calls, 2); assert.deepEqual(failures, [`Limit ${status}`]);
      await settle(550); assert.equal(calls, 2);
    } finally { audio.stop(); }
  }
});

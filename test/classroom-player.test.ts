import { test } from "node:test";
import assert from "node:assert/strict";
import { classroomSource } from "../backtoschool/src/player-source.ts";
import { classroomBroadcast } from "../src/classroom.ts";
const signal = new AbortController().signal;
const share = (play: string) => `https://nixamp.com/?url=${encodeURIComponent("https://tv.nixamp.com:4321/view/viewer-key")}&play=${encodeURIComponent(play)}`;

test("inline sources retain viewer credentials on the correct server", async () => {
  assert.deepEqual(await classroomSource(share("live"), signal), { src: "https://tv.nixamp.com:4321/api/live?k=viewer-key", live: true });
  assert.deepEqual(await classroomSource(share("track:12"), signal), { src: "https://tv.nixamp.com:4321/api/media/12?k=viewer-key", live: false });
  assert.deepEqual(await classroomSource(share("https://media.example/lesson.mp4"), signal), { src: "https://media.example/lesson.mp4", live: false });
});

test("video channels use HLS, audio stays audio, and names resolve to stable IDs", async () => {
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://tv.nixamp.com:4321/api/streams?k=viewer-key");
    assert.equal(init?.signal, signal);
    return Response.json({ channels: [{ id: "lesson/id", name: "Class", kind: "video" }, { id: "radio", name: "Radio", kind: "audio" }] });
  }) as typeof fetch;
  assert.deepEqual(await classroomSource(share("channel:Class"), signal, request), { src: "https://tv.nixamp.com:4321/api/channels/lesson%2Fid/hls/index.m3u8?k=viewer-key", live: true, kind: "hls" });
  assert.deepEqual(await classroomSource(share("channel:radio"), signal, request), { src: "https://tv.nixamp.com:4321/api/channels/radio?k=viewer-key", live: true, kind: "audio" });
  await assert.rejects(classroomSource(share("channel:missing"), signal, request), /not started/);
  await assert.rejects(classroomSource(share("channel:Class"), signal, (async () => new Response("", { status: 403 })) as typeof fetch), /could not be loaded/);
});

test("direct media is HTTPS only and provider pages never become media sources", async () => {
  assert.equal(classroomBroadcast("https://media.example/lesson.m3u8?signature=abc")?.provider, "media");
  assert.deepEqual(await classroomSource("https://media.example/lesson.m3u8?signature=abc", signal), { src: "https://media.example/lesson.m3u8?signature=abc", live: false });
  for (const value of ["http://media.example/lesson.mp4", "https://user:password@media.example/lesson.mp4", "https://media.example/page", "javascript:alert(1)"]) assert.equal(classroomBroadcast(value), null);
  assert.equal(await classroomSource("https://pairux.com/l/ABC123", signal), null);
});

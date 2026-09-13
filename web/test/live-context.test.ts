import { test } from "node:test";
import assert from "node:assert/strict";
import { liveContext, liveTitle } from "../src/live-context.ts";
import { parseSnapshot } from "../src/remote.ts";
import { emptySnapshot, merge, type RemoteTrack } from "../../src/protocol.ts";

const track = (title: string, metadata: Partial<RemoteTrack> = {}): RemoteTrack =>
  ({ title, artist: "", album: "", duration: 0, ...metadata });

test("downloaded lectures become readable without changing tagged titles or years", () => {
  assert.equal(liveTitle("0001_1_Few_Words_Before_We_Begin.mp4"), "Few Words Before We Begin");
  assert.equal(liveTitle("0004_1_Maven.mp4"), "Maven");
  assert.equal(liveTitle("0005_2_IntelliJ.MP4"), "IntelliJ");
  assert.equal(liveTitle("2001_A_Space_Odyssey.mp4"), "2001 A Space Odyssey");
  assert.equal(liveTitle("1984.mp4"), "1984");
  assert.equal(liveTitle("01 Song.mp3"), "Song");
  assert.equal(liveTitle("A_Tagged_Title"), "A_Tagged_Title");
});

test("actual folder hierarchy supplies course, section, lecture and a scoped position", () => {
  const tracks = [
    track("Unrelated.mp4", { folder: "Other course" }),
    track("0001_1_Introduction.mp4", { folder: "Microservices/01_Getting_Started" }),
    track("0002_2_Maven.mp4", { folder: "Microservices/01_Getting_Started" }),
    track("0003_1_Networks.mp4", { folder: "Microservices/02_Networking" }),
  ];
  assert.deepEqual(liveContext(tracks, 2), {
    title: "Maven", context: "Microservices › 01 Getting Started", position: "Playlist · 2 of 2",
    fullTitle: "Microservices › 01 Getting Started › Maven",
  });
});

test("added sources with identically named folders remain separate playlists", () => {
  const tracks = [track("One.mp4", { group: "Course A", folder: "Basics" }),
    track("Two.mp4", { group: "Course B", folder: "Basics" })];
  assert.equal(liveContext(tracks, 1).fullTitle, "Course B › Basics › Two");
  assert.equal(liveContext(tracks, 1).position, "Playlist · 1 of 1");
  assert.equal(liveContext([track("One.mp4", { group: "Course", folder: "Course" })], 0).context, "Course");
});

test("album metadata is a fallback and a raw filename never invents a course", () => {
  const tracks = [track("Lecture.mp4", { album: "Named album" }), track("Another.mp4", { album: "Elsewhere" })];
  assert.equal(liveContext(tracks, 0).context, "Named album");
  assert.equal(liveContext(tracks, 0).position, "Playlist · 1 of 1");
  assert.deepEqual(liveContext([track("0001_1_Introduction.mp4")], 0), {
    title: "Introduction", context: "", position: "Playlist · 1 of 1", fullTitle: "Introduction",
  });
  assert.deepEqual(liveContext([], 0, "0001_1_Introduction.mp4"), {
    title: "Introduction", context: "", position: "", fullTitle: "Introduction",
  });
});

test("relative metadata never reveals an absolute library path", () => {
  for (const folder of ["/home/owner/private/course", "C:\\Users\\owner\\course", "../private/course"]) {
    assert.equal(liveContext([track("Maven.mp4", { folder })], 0).context, "");
  }
});

test("real wire snapshots keep the course when a later SSE frame changes only the index", () => {
  const initial = parseSnapshot({ ...emptySnapshot(), revision: 1, index: 0, trackCount: 2, tracks: [
    track("0001_1_First.mp4", { folder: "Course/Section" }),
    track("0002_2_Second.mp4", { folder: "Course/Section" }),
  ] });
  assert.ok(initial);
  const next = parseSnapshot({ ...emptySnapshot(), tracks: undefined, revision: 2, index: 1, trackCount: 2 });
  assert.ok(next);
  const snapshot = merge(merge(emptySnapshot(), initial), next);
  assert.equal(liveContext(snapshot.tracks, snapshot.index).fullTitle, "Course › Section › Second");
  assert.equal(liveContext(snapshot.tracks, snapshot.index).position, "Playlist · 2 of 2");
});

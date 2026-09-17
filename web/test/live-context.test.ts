import { test } from "node:test";
import assert from "node:assert/strict";
import { classTitle, liveContext, liveTitle } from "../src/live-context.ts";
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

test("a class title walks up from the lecture to the collection and fits the school's limit", () => {
  const lecture = "Coursera - Deep Learning Specialization/1. Neural Networks and Deep Learning/Week 1 - Introduction to Deep Learning/Neural Networks and Deep Learning Basics/03_what-is-a-neural-network-and-how-does-it-learn.mp4";
  assert.ok(lecture.length > 160);
  const fitted = classTitle(lecture);
  assert.ok(fitted.length <= 160, fitted);
  // The collection and the lecture are kept; the nearest folder (the section)
  // fits and stays, the week above it would run over and goes.
  assert.equal(fitted, "Coursera - Deep Learning Specialization › Neural Networks and Deep Learning Basics › what-is-a-neural-network-and-how-does-it-learn");
  assert.equal(classTitle(lecture, 200), "Coursera - Deep Learning Specialization › Week 1 - Introduction to Deep Learning › Neural Networks and Deep Learning Basics › what-is-a-neural-network-and-how-does-it-learn");
  assert.equal(classTitle(lecture, 90), "Coursera - Deep Learning Specialization › what-is-a-neural-network-and-how-does-it-learn");
  // With no room for both, the lecture stays whole and the collection is cut at a word.
  assert.equal(classTitle(lecture, 70), "Coursera - Deep… › what-is-a-neural-network-and-how-does-it-learn");
  assert.equal(classTitle(lecture, 40), "what-is-a-neural-network-and-how-does-i…");
});

test("a class title that already fits, or has no path, is left alone or cut at a word", () => {
  assert.equal(classTitle("Coursera - Deep Learning Specialization/Week 1/03_intro.mp4"), "Coursera - Deep Learning Specialization/Week 1/03_intro.mp4");
  assert.equal(classTitle("  Live class  "), "Live class");
  const long = "word ".repeat(50).trim();
  const cut = classTitle(long, 30);
  assert.ok(cut.length <= 30);
  assert.equal(cut, "word word word word word word…");
  // The player's own live title (context › title) shortens the same way.
  assert.equal(classTitle("Microservices › 01 Getting Started › 02 Building › Maven", 40), "Microservices › 02 Building › Maven");
});

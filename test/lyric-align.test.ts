import { test } from "node:test";
import assert from "node:assert/strict";
import { alignWords, earAligner, heardWords, wordKey } from "../src/lyric-align.ts";

test("a heard phrase shares its time among its words by length", () => {
  const words = heardWords([{ start: 10, end: 14, text: "Cut the clock!" }]);
  assert.deepEqual(words.map((one) => one.word), ["cut", "the", "clock"]);
  assert.equal(words[0]!.start, 10);
  assert.ok(Math.abs(words[2]!.end - 14) < 1e-9);
  assert.ok(words[2]!.end - words[2]!.start > words[0]!.end - words[0]!.start, "a longer word is sung longer");
  assert.equal(wordKey("Couldn’t,"), "couldnt");
});

test("every lyric word gets a time: matched ones as heard, the rest in between", () => {
  const lyrics = "They sold the morning by the minute sold the evening by the week".split(" ");
  // Whisper misheard "Sold" as "So" and dropped "by the week".
  const heard = heardWords([
    { start: 45, end: 47, text: "They sold the morning by the minute" },
    { start: 47, end: 48, text: "So the evening" },
  ]);
  const timed = alignWords(lyrics, heard)!;
  assert.equal(timed.length, lyrics.length);
  assert.deepEqual(timed.map((one) => one.text), lyrics);
  assert.equal(timed[0]!.start, 45);
  for (let i = 1; i < timed.length; i++) assert.ok(timed[i]!.start >= timed[i - 1]!.start, `in order at ${i}`);
  assert.ok(timed[8]!.start >= 47 && timed[8]!.start < 48, "evening as heard");
  assert.ok(timed[11]!.start > timed[8]!.start, "the unheard tail carries on after the last match");
});

test("a song where too little was heard is refused, not given a karaoke that drifts", () => {
  const lyrics = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen".split(" ");
  assert.equal(alignWords(lyrics, heardWords([{ start: 0, end: 5, text: "one banana" }])), null);
  assert.equal(alignWords(lyrics, []), null);
});

test("the ear aligner hears a song a minute at a time and waits out the ear's 429", async () => {
  const pcm = Buffer.alloc(16_000 * 2 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i);
  let asks = 0;
  const fetcher = (async () => {
    asks += 1;
    if (asks === 1) return new Response(JSON.stringify({ error: "busy" }), { status: 429 });
    const second = asks === 2 ? 0 : 60;
    return new Response(JSON.stringify({ text: "x", seconds: 2, segments: second === 0
      ? [{ start: 0, end: 2, text: "Your time was never theirs" }]
      : [{ start: 0.5, end: 1.5, text: "to own" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  async function* windows() {
    yield { offset: 0, pcm };
    yield { offset: 60, pcm };
  }
  const align = earAligner(() => ({ site: "https://nixamp.com", token: "t" }), "en", { fetcher, windows, sleep: async () => undefined });
  const timed = await align("song.mp3", "Your time was never\ntheirs to own");
  assert.equal(asks, 3);
  assert.deepEqual(timed.map((one) => one.text), ["Your", "time", "was", "never", "theirs", "to", "own"]);
  assert.equal(timed[0]!.start, 0);
  assert.ok(timed[5]!.start >= 60.5, "the second window's words are offset by where it starts");
  await assert.rejects(earAligner(() => null)("song.mp3", "words"), /not signed in/);
});

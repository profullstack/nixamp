import { test } from "node:test";
import assert from "node:assert/strict";
import { Fragments, firstBox, isOpening } from "../src/fragments.ts";

/** An MP4 box: four bytes of length, four of name, then whatever it holds. */
function box(type: string, body = ""): Buffer {
  const inside = Buffer.from(body, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + inside.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, inside]);
}

test("a box is read only once all of it has arrived", () => {
  const whole = box("ftyp", "isom");
  // Everything short of the last byte is "not yet", not "no".
  for (let cut = 0; cut < whole.length; cut += 1) {
    assert.equal(firstBox(whole.subarray(0, cut)), null, `${cut} bytes should not parse`);
  }
  const read = firstBox(whole);
  assert.equal(read?.box.type, "ftyp");
  assert.equal(read?.rest.length, 0);
});

test("nonsense is refused rather than believed", () => {
  // A length read out of the middle of a video frame can say four gigabytes.
  // Trusting it walks off the end of the stream and waits for ever.
  const rubbish = Buffer.alloc(16);
  rubbish.writeUInt32BE(0xffffffff, 0);
  rubbish.write("", 4, "latin1");
  assert.equal(firstBox(rubbish), null);

  // A length smaller than the header it sits in describes nothing.
  const tiny = Buffer.alloc(12);
  tiny.writeUInt32BE(4, 0);
  tiny.write("moof", 4, "latin1");
  assert.equal(firstBox(tiny), null);
});

test("what describes the stream is kept for whoever turns up late", () => {
  // The whole reason this exists. MP3 can be joined halfway through because
  // every frame says what it is; fragmented MP4 opens with an ftyp and a moov
  // that name the tracks, and a listener handed the middle of it has no idea
  // what they are holding -- a blank panel and no error.
  const fragments = new Fragments();
  fragments.push(Buffer.concat([box("ftyp", "isom"), box("moov", "tracks")]));
  assert.ok(fragments.ready);

  const opening = fragments.header;
  assert.deepEqual(firstBox(opening)?.box.type, "ftyp");
  assert.deepEqual(firstBox(firstBox(opening)!.rest)?.box.type, "moov");

  // And it stays the opening: an hour of fragments does not change it.
  fragments.push(box("moof", "one"));
  fragments.push(box("mdat", "picture"));
  assert.equal(fragments.header.length, opening.length);
});

test("listeners are only ever handed whole boxes", () => {
  // A pipe ends a chunk wherever it feels like ending it, and half a moof is
  // not something to send anybody.
  const fragments = new Fragments();
  const stream = Buffer.concat([
    box("ftyp", "isom"), box("moov", "tracks"), box("moof", "one"), box("mdat", "aaaa"),
  ]);

  const out: Buffer[] = [];
  for (let at = 0; at < stream.length; at += 3) {
    out.push(...fragments.push(stream.subarray(at, at + 3)));
  }
  assert.deepEqual(out.map((b) => b.toString("latin1", 4, 8)), ["ftyp", "moov", "moof", "mdat"]);
  // Nothing invented and nothing lost.
  assert.equal(Buffer.concat(out).length, stream.length);
});

test("bytes that are not an MP4 are passed through rather than swallowed", () => {
  // A source that failed, or a format nobody expected. Holding it for ever
  // waiting for a box that is never coming is a leak and a silent stream; a
  // stream somebody might be able to play beats one nobody can.
  const fragments = new Fragments();
  const noise = Buffer.alloc(1024 * 1024, 0);
  let out: Buffer[] = [];
  for (let i = 0; i < 5; i += 1) out = fragments.push(noise);
  assert.ok(out.length > 0);
  assert.ok(!fragments.ready);
});

test("only the opening boxes are the opening", () => {
  assert.ok(isOpening("ftyp"));
  assert.ok(isOpening("moov"));
  assert.ok(!isOpening("moof"));
  assert.ok(!isOpening("mdat"));
});

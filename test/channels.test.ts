import { test } from "node:test";
import assert from "node:assert/strict";
import { Channels, cleanId, generatedId } from "../src/channels.ts";
import { needsAdmin } from "../src/owner.ts";

/** A listener that keeps what it was sent. */
function collector() {
  const chunks: Buffer[] = [];
  let ended = false;
  return {
    chunks,
    ended: () => ended,
    write(chunk: Buffer) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
  };
}

/** `true` is not ffmpeg, but it starts and exits, which is all these need. */
const channels = () => new Channels({ ffmpeg: ["true"] });

test("a channel id is safe to put in a URL", () => {
  assert.equal(cleanId("Studio B"), "studio-b");
  assert.equal(cleanId("  PHONE  "), "phone");
  assert.equal(cleanId("../../etc/passwd"), "etc-passwd");
  assert.equal(cleanId("a".repeat(100)).length, 40);
  // Nothing usable falls back rather than becoming an empty path segment.
  assert.equal(cleanId(""), "main");
  assert.equal(cleanId("---"), "main");
  assert.equal(cleanId(undefined), "main");
  assert.equal(cleanId(42), "main");
  assert.match(generatedId(), /^s[0-9a-f]{6}$/);
});

test("several channels are live at once, which is the whole point", () => {
  const set = channels();
  assert.notEqual(set.publish("phone", "Phone", "webm", "http"), null);
  assert.notEqual(set.publish("desktop", "Desktop", "webm", "http"), null);
  assert.notEqual(set.publish("window2", "Second window", "webm", "http"), null);

  assert.equal(set.count, 3);
  assert.deepEqual(set.list().map((c) => c.id), ["phone", "desktop", "window2"]);
  set.stopAll();
});

test("two publishers on ONE channel is refused, on two is not", () => {
  const set = channels();
  assert.notEqual(set.publish("phone", "first", "webm", "http"), null);
  // Two sources on one channel would be two songs at once.
  assert.equal(set.publish("phone", "second", "webm", "http"), null);
  // A different channel is exactly what this is for.
  assert.notEqual(set.publish("phone-2", "second", "webm", "http"), null);
  assert.equal(set.count, 2);
  set.stopAll();
});

test("every listener on a channel gets the same bytes", () => {
  const set = channels();
  const channel = set.attach("phone", "Phone", "flv", "rtmp");
  assert.notEqual(channel, null);

  const a = collector();
  const b = collector();
  set.listen("phone", a);
  set.listen("phone", b);
  assert.equal(set.listeners, 2);

  channel?.feed(Buffer.from("one"));
  channel?.feed(Buffer.from("two"));

  assert.equal(Buffer.concat(a.chunks).toString(), "onetwo");
  assert.equal(Buffer.concat(b.chunks).toString(), "onetwo");
  set.stopAll();
});

test("a listener who joins late gets what comes next, not what it missed", () => {
  const set = channels();
  const channel = set.attach("phone", "Phone", "flv", "rtmp");

  const early = collector();
  set.listen("phone", early);
  channel?.feed(Buffer.from("before"));

  const late = collector();
  set.listen("phone", late);
  channel?.feed(Buffer.from("after"));

  // Live means from now. There is nothing to catch up on.
  assert.equal(Buffer.concat(early.chunks).toString(), "beforeafter");
  assert.equal(Buffer.concat(late.chunks).toString(), "after");
  set.stopAll();
});

test("listeners on different channels do not hear each other", () => {
  const set = channels();
  const one = set.attach("phone", "Phone", "flv", "rtmp");
  const two = set.attach("desktop", "Desktop", "flv", "rtmp");

  const a = collector();
  const b = collector();
  set.listen("phone", a);
  set.listen("desktop", b);

  one?.feed(Buffer.from("from-phone"));
  two?.feed(Buffer.from("from-desktop"));

  assert.equal(Buffer.concat(a.chunks).toString(), "from-phone");
  assert.equal(Buffer.concat(b.chunks).toString(), "from-desktop");
  set.stopAll();
});

test("leaving stops the counting, and a broken socket is dropped", () => {
  const set = channels();
  const channel = set.attach("phone", "Phone", "flv", "rtmp");

  const staying = collector();
  const leaving = collector();
  const leave = set.listen("phone", leaving);
  set.listen("phone", staying);
  assert.equal(set.listeners, 2);

  leave?.();
  assert.equal(set.listeners, 1);

  // One listener's broken socket is not the channel's problem.
  set.listen("phone", {
    write() {
      throw new Error("EPIPE");
    },
    end() {},
  });
  assert.equal(set.listeners, 2);
  channel?.feed(Buffer.from("x"));
  assert.equal(set.listeners, 1);
  assert.equal(Buffer.concat(staying.chunks).toString(), "x");
  set.stopAll();
});

test("stopping a channel ends its listeners rather than leaving them hanging", () => {
  const set = channels();
  set.attach("phone", "Phone", "flv", "rtmp");
  const listener = collector();
  set.listen("phone", listener);

  assert.equal(set.stop("phone"), true);
  assert.equal(listener.ended(), true);
  assert.equal(set.count, 0);
  // A channel that is gone is gone: stopping it again is not an error.
  assert.equal(set.stop("phone"), false);
  assert.equal(set.listen("phone", collector()), null);
});

test("listening to nothing is nothing, not a crash", () => {
  const set = channels();
  assert.equal(set.listen("nobody-here", collector()), null);
  assert.equal(set.writeTo("nobody-here", Buffer.from("x")), false);
  assert.equal(set.has("nobody-here"), false);
});

test("publishing needs an administrator; listening does not", () => {
  // Anyone with the share link may hear a channel. Putting one on air is
  // administering the server.
  assert.equal(needsAdmin("/api/channels/phone", "GET"), false);
  assert.equal(needsAdmin("/api/channels/phone", "POST"), true);
  assert.equal(needsAdmin("/api/channels/phone", "DELETE"), true);
  assert.equal(needsAdmin("/api/channels/phone/chunk", "POST"), true);
  assert.equal(needsAdmin("/api/channels", "GET"), false);
});

/** An MP4 box, for the pulled-channel tests below. */
function box(type: string, body = ""): Buffer {
  const inside = Buffer.from(body, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + inside.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, inside]);
}

/** A fake ffmpeg that prints an opening and one fragment, then stays up. */
function fakeVideoFfmpeg(): string[] {
  const bytes = Buffer.concat([
    box("ftyp", "isom"), box("moov", "tracks"), box("moof", "one"), box("mdat", "picture"),
  ]).toString("base64");
  return ["sh", "-c", `printf %s ${bytes} | base64 -d; sleep 30`, "--"];
}

test("two pulled channels run at once, each with its own audience", async () => {
  // The thing this exists for. A re-stream used to become a playlist track,
  // and a server plays one track at a time -- so the second channel you added
  // sat there saying "stopped" and two tabs could not have one each.
  const set = new Channels({ ffmpeg: fakeVideoFfmpeg() });
  const news = set.pull("news", "CNN", "http://x.test/301", [], "video");
  const ball = set.pull("ball", "MLB Network", "http://x.test/932", [], "video");
  assert.ok(news && ball);
  assert.equal(set.count, 2);

  const watching = collector();
  const alsoWatching = collector();
  news?.listen(watching);
  ball?.listen(alsoWatching);

  await new Promise((done) => setTimeout(done, 400));

  // Each got its own stream, not a share of one.
  assert.ok(watching.chunks.length > 0);
  assert.ok(alsoWatching.chunks.length > 0);
  assert.deepEqual(set.list().map((c) => c.name).sort(), ["CNN", "MLB Network"]);
  assert.equal(set.contentType("news"), "video/mp4");

  // Ending one leaves the other on the air.
  assert.equal(set.stop("news"), true);
  assert.equal(set.count, 1);
  assert.equal(set.list()[0]?.name, "MLB Network");
  set.stopAll();
});

test("somebody who arrives late is told what the stream is", async () => {
  // Fragmented MP4 cannot be joined blind: the fragments reference tracks
  // described in an ftyp and a moov that went past before this listener
  // existed. Without them a browser shows a blank panel and no error.
  const set = new Channels({ ffmpeg: fakeVideoFfmpeg() });
  const channel = set.pull("late", "MLB Network", "http://x.test/932", [], "video");
  await new Promise((done) => setTimeout(done, 400));

  const latecomer = collector();
  channel?.listen(latecomer);
  const first = Buffer.concat(latecomer.chunks);
  assert.equal(first.toString("latin1", 4, 8), "ftyp");
  assert.ok(first.includes("moov"));
  set.stopAll();
});

test("a channel carrying only sound says so", () => {
  const set = new Channels({ ffmpeg: ["true"] });
  set.pull("radio", "A Station", "http://x.test/stream.mp3", [], "audio");
  assert.equal(set.contentType("radio"), "audio/mpeg");
  // And a channel nobody has heard of is not called video on a guess.
  assert.equal(set.contentType("nothing"), "audio/mpeg");
  set.stopAll();
});

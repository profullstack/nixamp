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

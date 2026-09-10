import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKLOG_VIDEO, Channels, REDIAL, cleanId, generatedId, rememberChannels, rememberedChannels,
} from "../src/channels.ts";
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

/** The opening and one fragment, as one base64 blob a shell can print. */
function fakeStream(): string {
  return Buffer.concat([
    box("ftyp", "isom"), box("moov", "tracks"), box("moof", "one"), box("mdat", "picture"),
  ]).toString("base64");
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a source that floods stderr does not stall the channel", async () => {
  // What took CNN off the air after twelve hours. ffmpeg logs a line for
  // every corrupt packet an IPTV stream sends, and a stderr pipe nobody reads
  // fills at 64 KiB -- after which the next complaint blocks, every thread
  // waits on it, and the channel produces nothing more without ever exiting.
  // 300 KiB of complaints before the first byte of picture: read, or stuck.
  const noisy = [
    "sh", "-c",
    `head -c 300000 /dev/zero | tr '\\0' x >&2; printf %s ${fakeStream()} | base64 -d; sleep 30`,
    "--",
  ];
  const set = new Channels({ ffmpeg: noisy });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  const viewer = collector();
  channel?.listen(viewer);
  await wait(800);

  const got = Buffer.concat(viewer.chunks);
  assert.equal(got.toString("latin1", 4, 8), "ftyp", "the picture never came: ffmpeg is blocked on stderr");
  assert.ok(got.includes("mdat"));
  set.stopAll();
});

test("restarting a pulled channel starts the stream over, once", async () => {
  const set = new Channels({ ffmpeg: fakeVideoFfmpeg() });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  const before = collector();
  channel?.listen(before);
  await wait(300);
  assert.ok(before.chunks.length > 0);

  assert.equal(set.restart("cnn"), true);
  // Still on the air, and still the same channel.
  assert.equal(set.count, 1);
  assert.equal(set.list()[0]?.redials, 1);
  // The old audience was on a stream that no longer exists: ended, so their
  // player rejoins, rather than sent a second beginning mid-picture.
  assert.equal(before.ended(), true);

  await wait(300);
  const after = collector();
  channel?.listen(after);
  const header = Buffer.concat(after.chunks).toString("latin1");
  // One beginning, not two: the header was reset with the stream.
  assert.equal(header.split("ftyp").length - 1, 1);
  assert.equal(header.split("moov").length - 1, 1);

  // A publisher's stream is not ours to dial.
  set.attach("phone", "A phone", "flv", "rtmp");
  assert.equal(set.pulled("phone"), false);
  assert.equal(set.restart("phone"), false);
  assert.equal(set.restart("nothing"), false);
  set.stopAll();
});

test("a source that drops is dialled again, with one header, not two", async () => {
  // Prints its opening and a fragment and exits at once: a source that
  // worked and then went away. It is dialled again after REDIAL, and the
  // second time it stays up, as a CDN that came back does.
  const marker = join(mkdtempSync(join(tmpdir(), "nixamp-redial-")), "dialled-once");
  const brief = [
    "sh", "-c",
    `printf %s ${fakeStream()} | base64 -d; if [ -e "${marker}" ]; then exec sleep 30; fi; touch "${marker}"`,
    "--",
  ];
  const set = new Channels({ ffmpeg: brief });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  await wait(REDIAL + 500);

  assert.equal(set.count, 1, "still on the air");
  assert.ok((set.list()[0]?.redials ?? 0) >= 1);
  const late = collector();
  channel?.listen(late);
  const header = Buffer.concat(late.chunks).toString("latin1");
  // The second ffmpeg's opening replaced the first's rather than joining it.
  assert.equal(header.split("ftyp").length - 1, 1);
  set.stopAll();
});

test("a source that goes quiet is hung up on and dialled again", async () => {
  // Says its piece and then nothing, for ever. ffmpeg's reconnect never
  // fires for a socket that simply stops; the watchdog is what notices.
  // `exec`, so that killing the fake kills the thing holding its pipe open,
  // as killing ffmpeg does.
  const quiet = ["sh", "-c", `printf %s ${fakeStream()} | base64 -d; exec sleep 30`, "--"];
  const set = new Channels({ ffmpeg: quiet });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video", true, 300);
  const viewer = collector();
  channel?.listen(viewer);
  await wait(700);

  assert.match(set.list()[0]?.error ?? "", /no data from the source/);
  assert.equal(viewer.ended(), true, "hung up on, to rejoin the fresh stream");
  await wait(REDIAL + 300);
  assert.equal(set.count, 1, "dialled again rather than given up");
  assert.ok((set.list()[0]?.redials ?? 0) >= 1);
  set.stopAll();
});

test("the channels a server pulls are remembered, per port, and forgotten on purpose", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-remember-"));
  assert.deepEqual(rememberedChannels(dir, 4321), []);

  rememberChannels(dir, 4321, [{ id: "cnn", name: "CNN", source: "http://x.test/301" }]);
  rememberChannels(dir, 5000, [{ id: "mlb", name: "MLB Network", source: "http://x.test/932" }]);
  assert.deepEqual(rememberedChannels(dir, 4321), [{ id: "cnn", name: "CNN", source: "http://x.test/301" }]);
  // Two servers on one machine are two line-ups.
  assert.deepEqual(rememberedChannels(dir, 5000).map((c) => c.id), ["mlb"]);

  // Taken off the air is taken off the list, and the other port is untouched.
  rememberChannels(dir, 4321, []);
  assert.deepEqual(rememberedChannels(dir, 4321), []);
  assert.equal(rememberedChannels(dir, 5000).length, 1);

  // Somebody's hand-edited file with junk in it is not a crash.
  writeFileSync(join(dir, "channels.json"), '{"4321": [1, {"id": "x"}, {"id":"ok","name":"Ok","source":"s"}]}');
  assert.deepEqual(rememberedChannels(dir, 4321).map((c) => c.id), ["ok"]);
  writeFileSync(join(dir, "channels.json"), "not json");
  assert.deepEqual(rememberedChannels(dir, 4321), []);
});

test("somebody who joins a picture late gets the last few seconds, from a fragment boundary", async () => {
  // Handed only what comes next, a viewer starts on the live edge with nothing
  // buffered, and every hiccup is a stall: CNN in a browser was play, wait,
  // play, wait. So the recent fragments go out first, beginning at a moof.
  const stream = Buffer.concat([
    box("ftyp", "isom"), box("moov", "tracks"),
    box("moof", "one"), box("mdat", "first picture"),
    box("moof", "two"), box("mdat", "second picture"),
    box("moof", "three"), box("mdat", "third picture"),
  ]).toString("base64");
  const fake = ["sh", "-c", `printf %s ${stream} | base64 -d; exec sleep 30`, "--"];
  const set = new Channels({ ffmpeg: fake });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  await wait(400);

  const late = collector();
  channel?.listen(late);
  const got = boxNames(Buffer.concat(late.chunks));
  // The description of the stream, then everything recent, in order.
  assert.deepEqual(got, ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
  assert.ok(Buffer.concat(late.chunks).includes("third picture"));
  set.stopAll();
});

/** The names of the boxes in a buffer, in order. */
function boxNames(bytes: Buffer): string[] {
  const names: string[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(at);
    names.push(bytes.toString("latin1", at + 4, at + 8));
    if (size < 8) break;
    at += size;
  }
  return names;
}

test("the backlog is bounded, and never begins with an mdat", async () => {
  // Fragments much bigger than the cap, so only whole recent ones survive.
  const big = "x".repeat(BACKLOG_VIDEO / 2);
  const stream = Buffer.concat([
    box("ftyp", "isom"), box("moov", "tracks"),
    box("moof", "one"), box("mdat", `a${big}`),
    box("moof", "two"), box("mdat", `b${big}`),
    box("moof", "three"), box("mdat", `c${big}`),
  ]);
  // Too big for a command line, so it goes through a file.
  const file = join(mkdtempSync(join(tmpdir(), "nixamp-backlog-")), "stream.mp4");
  writeFileSync(file, stream);
  const fake = ["sh", "-c", `cat "${file}"; exec sleep 30`, "--"];
  const set = new Channels({ ffmpeg: fake });
  const channel = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  await wait(1200);

  const late = collector();
  channel?.listen(late);
  const all = Buffer.concat(late.chunks);
  const got = boxNames(all);
  assert.deepEqual(got.slice(0, 3), ["ftyp", "moov", "moof"], "after the header comes a moof, never an mdat");
  // Everything after the header is the backlog, and it fits under the cap.
  const header = 8 + "isom".length + 8 + "tracks".length;
  const total = all.byteLength - header;
  assert.ok(total <= BACKLOG_VIDEO, `backlog of ${total} is over the cap`);
  assert.ok(total > 0);
  set.stopAll();
});

test("an on-demand channel stops itself a minute after its last viewer leaves", async () => {
  const set = new Channels({ ffmpeg: fakeVideoFfmpeg(), idleMs: 300 });
  const channel = set.pull("cat-abc", "CNN", "http://x.test/301", [], "video");
  assert.ok(channel);
  assert.equal(set.ephemeralCount, 0);
  // Marked on demand with nobody watching yet: the clock starts now.
  set.ephemeral("cat-abc");
  assert.equal(set.ephemeralCount, 1);

  // A viewer arriving stops the clock; leaving starts it again.
  const viewer = collector();
  const leave = channel?.listen(viewer);
  await wait(400);
  assert.equal(set.has("cat-abc"), true, "still on while somebody watches");
  leave?.();
  await wait(200);
  assert.equal(set.has("cat-abc"), true, "not gone the instant they leave");
  await wait(300);
  assert.equal(set.has("cat-abc"), false, "gone once nobody came back");

  // An ordinary channel is not touched by any of this.
  const kept = set.pull("cnn", "CNN", "http://x.test/301", [], "video");
  const leaveKept = kept?.listen(collector());
  leaveKept?.();
  await wait(500);
  assert.equal(set.has("cnn"), true);
  set.stopAll();
});

test("going live with an on-demand channel keeps it up with nobody watching", async () => {
  // Watching something from a catalog starts a channel that stops a minute
  // after you leave. Going live with it is asking it to stay: listed,
  // shareable, and still there when the tab that started it is closed.
  const set = new Channels({ ffmpeg: fakeVideoFfmpeg(), idleMs: 200 });
  const channel = set.pull("cat-abc", "CNN", "http://x.test/301", [], "video");
  set.ephemeral("cat-abc");
  assert.equal(set.isEphemeral("cat-abc"), true);

  const viewer = collector();
  const leave = channel?.listen(viewer);
  leave?.();
  // The clock is running; keeping it stops the clock.
  assert.equal(set.keep("cat-abc"), true);
  assert.equal(set.isEphemeral("cat-abc"), false);
  assert.equal(set.ephemeralCount, 0);
  await wait(500);
  assert.equal(set.has("cat-abc"), true, "kept, so still on with nobody watching");

  // A channel that is not there is not kept.
  assert.equal(set.keep("nothing"), false);
  set.stopAll();
});

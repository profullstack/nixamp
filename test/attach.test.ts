import { test } from "node:test";
import assert from "node:assert/strict";
import { applySnapshot, commandFor, follow } from "../src/attach.ts";
import { BAND_COUNT, createState, helpFor, isHelp, wantsHelp } from "../src/main.ts";
import { emptySnapshot, type Snapshot } from "../src/protocol.ts";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ...emptySnapshot(),
    tracks: [{ title: "Bleed", artist: "Meshuggah", album: "obZen", duration: 447 }],
    index: 0,
    playing: true,
    position: 12,
    bars: new Array(BAND_COUNT).fill(0.5),
    levels: [0.4, 0.6],
    root: "/music",
    ...over,
  };
}

test("an attached player draws the daemon's state, and holds its own peaks", () => {
  const state = createState([], "http://localhost:8420", false);
  applySnapshot(state, snapshot());

  assert.equal(state.tracks.length, 1);
  assert.equal(state.tracks[0]?.title, "Bleed");
  assert.equal(state.tracks[0]?.path, "", "no filesystem path leaves the machine");
  assert.equal(state.playing, true);
  assert.equal(state.position, 12);
  assert.equal(state.root, "/music");
  assert.deepEqual(state.levels, [0.4, 0.6]);

  // Peaks are a local decoration: they rise with the bars and sink on their
  // own, exactly as they do in the local player.
  assert.equal(state.peakHold[0], 0.5);
  applySnapshot(state, snapshot({ bars: new Array(BAND_COUNT).fill(0) }));
  assert.equal(state.bars[0], 0);
  assert.equal(state.peakHold[0], 0.48);
});

test("a short bars array still fills the analyser", () => {
  const state = createState([], "http://localhost:8420", false);
  applySnapshot(state, snapshot({ bars: [1] }));
  assert.equal(state.bars.length, BAND_COUNT);
  assert.equal(state.bars[BAND_COUNT - 1], 0);
});

test("the player's keys are the daemon's commands", () => {
  assert.deepEqual(commandFor("space"), { type: "toggle" });
  assert.deepEqual(commandFor("enter"), { type: "play" });
  assert.deepEqual(commandFor("s"), { type: "stop" });
  assert.deepEqual(commandFor("n"), { type: "next" });
  assert.deepEqual(commandFor("right"), { type: "next" });
  assert.deepEqual(commandFor("p"), { type: "prev" });
  assert.deepEqual(commandFor("left"), { type: "prev" });
  // q and d are handled by the attached player itself, and stop nothing.
  assert.equal(commandFor("q"), null);
  assert.equal(commandFor("d"), null);
});

test("event frames are read however the network chops them up", async () => {
  const first = JSON.stringify(snapshot({ position: 1 }));
  const second = JSON.stringify(snapshot({ position: 2 }));
  const chunks = [
    `data: ${first.slice(0, 20)}`,
    `${first.slice(20)}\n\n: beat\n\ndata: ${second}`,
    "\n\n",
  ];

  const send = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    )) as unknown as typeof fetch;

  const seen: number[] = [];
  const stop = new AbortController();
  await follow(
    "http://localhost:8420",
    {},
    (frame) => {
      seen.push(frame.position);
      if (seen.length === 2) stop.abort();
    },
    () => {},
    stop.signal,
    send,
  );

  // Both frames, in order, and the keep-alive comment ignored.
  assert.deepEqual(seen, [1, 2]);
});

test("a daemon that is not answering is said once, not thrown", async () => {
  const stop = new AbortController();
  const troubles: string[] = [];
  const send = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  await follow(
    "http://localhost:8420",
    {},
    () => {},
    (why) => {
      troubles.push(why);
      // It would otherwise keep trying, which is what it is meant to do.
      stop.abort();
    },
    stop.signal,
    send,
  );
  assert.deepEqual(troubles, ["cannot reach http://localhost:8420"]);
});

test("help is asked for in every spelling", () => {
  assert.equal(isHelp("-h"), true);
  assert.equal(isHelp("--help"), true);
  assert.equal(isHelp("help"), true);
  assert.equal(isHelp("halp"), false);
  assert.equal(isHelp(undefined), false);

  assert.equal(wantsHelp("help", []), true);
  assert.equal(wantsHelp("login", ["--help"]), true);
  assert.equal(wantsHelp("login", ["-h"]), true);
  assert.equal(wantsHelp(undefined, []), false);
  assert.equal(wantsHelp("~/Music", []), false);

  // serve has had `-h HOST` since the beginning, and daemon passes serve's
  // flags through: -h there is an address, not a question.
  assert.equal(wantsHelp("serve", ["-h", "0.0.0.0"]), false);
  assert.equal(wantsHelp("daemon", ["start", "-h", "0.0.0.0"]), false);
  assert.equal(wantsHelp("serve", ["--help"]), true);
});

test("help for a command is about that command", () => {
  assert.match(helpFor("login"), /nixamp login --with github/);
  assert.match(helpFor("token"), /only time it is shown|shown once/);
  assert.match(helpFor("daemon"), /outlives the terminal/);
  assert.match(helpFor("attach"), /q or d leaves/);
  // Anything else is the summary, which is the right answer to a vague ask.
  assert.match(helpFor(undefined), /it really whips the terminal's ass/);
  assert.match(helpFor("nonsense"), /it really whips the terminal's ass/);
  // The summary says how to detach and how to come back.
  assert.match(helpFor(undefined), /nixamp attach/);
  assert.match(helpFor(undefined), /d {5}detach/);
});

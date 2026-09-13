import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPlayer } from "../src/player.ts";

class MediaElement extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 0;
  src = "";
  refusal: Error | null = new DOMException("User interaction is required", "NotAllowedError");
  attempts = 0;

  async play(): Promise<void> {
    this.attempts += 1;
    if (this.refusal) throw this.refusal;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }

  pause(): void { this.paused = true; }
  load(): void {}
  removeAttribute(): void { this.src = ""; }
}

function fixture() {
  const audio = new MediaElement();
  const errors: string[] = [];
  const busy: boolean[] = [];
  const states: boolean[] = [];
  const player = new BrowserPlayer({
    audio: audio as unknown as HTMLAudioElement,
    video: new MediaElement() as unknown as HTMLVideoElement,
  }, {
    onTime: () => {},
    onEnded: () => {},
    onState: (playing) => states.push(playing),
    onError: (message) => errors.push(message),
    onBusy: (waiting) => busy.push(waiting),
  });
  return { player, audio, errors, busy, states };
}

test("blocked autoplay waits for a click without reporting a broken stream", async () => {
  const { player, audio, errors, busy, states } = fixture();
  await player.load({
    title: "News", artist: "", album: "", duration: 0,
    url: "https://server.example/api/channels/news", video: false,
    objectUrl: false, kind: "audio",
  }, true);
  assert.equal(player.needsInteraction, true);
  assert.equal(player.source, "https://server.example/api/channels/news");
  assert.equal(audio.attempts, 1);
  assert.deepEqual(errors, [], "the app must not reconnect and abandon the chat room");
  assert.deepEqual(busy, [false]);
  assert.deepEqual(states, [false]);

  // A second denial still leaves the source ready; a permitted click plays it.
  await player.play();
  assert.equal(player.needsInteraction, true);
  audio.refusal = null;
  await player.play();
  assert.equal(player.needsInteraction, false);
  assert.equal(player.playing, true);
  assert.equal(player.source, "https://server.example/api/channels/news");
  assert.deepEqual(errors, []);
  assert.equal(states.at(-1), true);
});

test("a real playback failure still reaches the stream error handler", async () => {
  const { player, audio, errors } = fixture();
  audio.refusal = new DOMException("Unsupported media", "NotSupportedError");
  await player.play();
  assert.equal(player.needsInteraction, false);
  assert.deepEqual(errors, ["Unsupported media"]);
});

test("stopping or replacing a source clears its autoplay prompt", async () => {
  const { player, errors } = fixture();
  await player.play();
  player.stop();
  assert.equal(player.needsInteraction, false);

  await player.play();
  assert.equal(player.needsInteraction, true);
  await player.load({
    title: "Another station", artist: "", album: "", duration: 0,
    url: "https://server.example/other.mp3", video: false, objectUrl: false,
  }, false);
  assert.equal(player.needsInteraction, false);
  assert.deepEqual(errors, []);
});

test('a permitted interaction resumes a shared stream, but never reverses an explicit pause or stop', async () => {
  const { player, audio } = fixture();
  await player.play();
  audio.refusal = null;
  await player.resumeAfterInteraction();
  assert.equal(player.playing, true);
  assert.equal(audio.attempts, 2);
  player.pause();
  await player.resumeAfterInteraction();
  assert.equal(player.playing, false);
  assert.equal(audio.attempts, 2);
  audio.refusal = new DOMException('Click first', 'NotAllowedError');
  await player.play();
  player.stop(); audio.refusal = null;
  await player.resumeAfterInteraction();
  assert.equal(player.playing, false);
  assert.equal(audio.attempts, 3);
});

test('a translation session mutes even an audio graph created after the session starts', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const gains: { value: number }[] = [];
  class Context {
    destination = {};
    createAnalyser() { return { connect() {}, frequencyBinCount: 1024 }; }
    createGain() { const gain = { value: 1 }; gains.push(gain); return { gain, connect() {} }; }
    createMediaElementSource() { return { connect() {} }; }
    async resume() {}
  }
  Object.defineProperty(globalThis, 'AudioContext', { value: Context, configurable: true });
  try {
    const { player, audio } = fixture();
    player.translatedAudio(true); audio.refusal = null;
    await player.play();
    assert.equal(gains[0]?.value, 0);
    player.translatedAudio(false);
    assert.equal(gains[0]?.value, 1);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'AudioContext', saved);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});

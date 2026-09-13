import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTRO_ENCODE, OUTRO_SECONDS, Outro, drawOutro, drawText, encodePng, textWidth, Bitmap } from "../src/outro.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

test("the outro is drawn: the plate, the mark, the words, as a PNG", () => {
  const picture = drawOutro();
  assert.equal(picture.width, 1280);
  assert.equal(picture.height, 720);
  // The plate is the app's dark green, and something green was drawn on it.
  const at = (x: number, y: number) => [...picture.pixels.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4)];
  assert.deepEqual(at(2, 2), [8, 12, 9, 255]);
  let lit = 0;
  for (let i = 1; i < picture.pixels.length; i += 4) if ((picture.pixels[i] as number) > 200) lit += 1;
  assert.ok(lit > 5000, `${lit} bright pixels`);
  const png = encodePng(picture);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  // The face knows its letters and skips what it does not.
  const small = new Bitmap(40, 10);
  drawText(small, "A?", 0, 0, 1, { r: 1, g: 2, b: 3, a: 255 });
  assert.equal(textWidth("ENDED", 2), 5 * 12 - 2);
  assert.equal(OUTRO_ENCODE.video[0], "-c");
  assert.ok(OUTRO_ENCODE.video.includes("frag_keyframe+empty_moov+default_base_moof"));
});

test("with ffmpeg the clips are made once and kept: five seconds of H.264 and AAC, and an MP3", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-outro-"));
  const events: string[] = [];
  const outro = new Outro({ ffmpeg: ["ffmpeg"], dir, onEvent: (message) => events.push(message) });
  const video = await outro.clip("video");
  assert.ok(video && video.endsWith(".mp4"));
  assert.ok(statSync(video).size > 1000);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "csv=p=0", video], { encoding: "utf8" });
  assert.match(probe.stdout, /h264/);
  assert.match(probe.stdout, /aac/);
  const seconds = Number(probe.stdout.trim().split("\n").pop());
  assert.ok(Math.abs(seconds - OUTRO_SECONDS) < 0.6, `${seconds} s`);
  const audio = await outro.clip("audio");
  assert.ok(audio && audio.endsWith(".mp3"));
  assert.ok(statSync(audio).size > 1000);
  assert.equal(readFileSync(audio).length, statSync(audio).size);
  // Asked again, nothing is drawn again.
  const drawn = events.filter((one) => one.includes("outro drawn")).length;
  assert.equal(await outro.clip("video"), video);
  assert.equal(events.filter((one) => one.includes("outro drawn")).length, drawn);
  const again = new Outro({ ffmpeg: ["ffmpeg"], dir, onEvent: (message) => events.push(message) });
  assert.equal(await again.clip("video"), video);
  assert.equal(events.filter((one) => one.includes("outro drawn")).length, drawn);
});

test("without an ffmpeg there is no clip, and that is an answer, not a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-outro-none-"));
  const outro = new Outro({ ffmpeg: ["definitely-not-ffmpeg-here"], dir });
  assert.equal(await outro.clip("video"), null);
  assert.equal(await outro.clip("audio"), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queryable } from "../src/follows.ts";
import {
  MAX_LINES,
  Transcripts,
  covered,
  fileFingerprint,
  formatOf,
  idFrom,
  kindOf,
  languageCode,
  linesFrom,
  mediaOfLive,
  mediaOfUrl,
  mergeLines,
  reach,
  stamp,
  toSrt,
  toText,
  toVtt,
  transcriptId,
  transcriptIdOf,
  wire,
} from "../src/transcripts.ts";

function db(answers: Record<string, Record<string, unknown>[]> = {}) {
  const asked: { text: string; values: unknown[] }[] = [];
  const queryable: Queryable = {
    async query(text, values = []) {
      asked.push({ text, values });
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows };
      }
      // An insert echoes what it was given back, as RETURNING * would.
      if (text.includes("INSERT INTO transcripts")) {
        return {
          rows: [{
            id: values[0], language: values[1], media: values[2], kind: values[3], translated_from: values[4], model: values[5],
            complete: values[6], title: values[7], by_account: values[8], seconds: values[9], lines: JSON.parse(values[10] as string),
            updated_at: new Date("2026-09-13T12:00:00.000Z"),
          }],
        };
      }
      return { rows: [] };
    },
  };
  return { asked, queryable };
}

test("media identities: a file is its fingerprint, a link its address without the fragment, a live the one broadcast", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-fp-"));
  const small = join(dir, "small.bin");
  writeFileSync(small, Buffer.from("hello world"));
  const big = join(dir, "big.bin");
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
  writeFileSync(big, bytes);
  const a = fileFingerprint(small);
  assert.match(a, /^file:v1:[0-9a-f]{64}$/);
  assert.equal(fileFingerprint(small), a);
  const b = fileFingerprint(big);
  assert.notEqual(a, b);
  // A byte in the middle is not in the fingerprint; the ends and the size are.
  bytes[1_500_000] = 9;
  writeFileSync(big, bytes);
  assert.equal(fileFingerprint(big), b);
  bytes[10] = 9;
  writeFileSync(big, bytes);
  assert.notEqual(fileFingerprint(big), b);

  assert.equal(mediaOfUrl("https://example.com/a.mp4#t=10 "), "url:https://example.com/a.mp4");
  assert.equal(mediaOfUrl("not a url"), "url:not a url");
  assert.equal(mediaOfLive("https://server1.chovy.nixamp.com:4321/", "main", 1700000000123.9), "live:server1.chovy.nixamp.com:4321/main@1700000000123");
  assert.equal(mediaOfLive("server1.chovy.nixamp.com:4321", "main", 5), "live:server1.chovy.nixamp.com:4321/main@5");
  assert.equal(kindOf("file:v1:ab"), "file");
  assert.equal(kindOf("live:x/y@1"), "live");
  assert.equal(kindOf("url:https://x"), "url");

  const id = transcriptIdOf("url:https://example.com/a.mp4");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(transcriptId(id), id);
  assert.equal(transcriptId("nope"), null);
  assert.equal(idFrom(id), id);
  assert.equal(idFrom("url:https://example.com/a.mp4"), id);
});

test("lines are tidied on the way in and merged without their duplicates", () => {
  const lines = linesFrom([
    { start: 5, end: 10, text: "  the second   line " },
    { start: 0, end: 5, text: "the first line" },
    { start: "x", end: 1, text: "not a line" },
    { start: 2, end: 1, text: "ends before it starts" },
    { start: 10, end: 15, text: "" },
    null,
  ]);
  assert.deepEqual(lines, [
    { start: 5, end: 10, text: "the second line" },
    { start: 0, end: 5, text: "the first line" },
    { start: 2, end: 2, text: "ends before it starts" },
  ]);
  assert.deepEqual(linesFrom('[{"start":1,"end":2,"text":"a"}]'), [{ start: 1, end: 2, text: "a" }]);
  assert.deepEqual(linesFrom("nope"), []);

  const merged = mergeLines([
    { start: 0, end: 5, text: "one" },
    { start: 5, end: 10, text: "two" },
    // The same window heard again by a second server, half a second off.
    { start: 5.4, end: 10.4, text: "two, at more length" },
    { start: 10, end: 15, text: "three" },
    // A different window that only just touches the one before.
    { start: 14, end: 19, text: "four" },
  ]);
  assert.deepEqual(merged.map((line) => line.text), ["one", "two, at more length", "three", "four"]);
  assert.equal(reach(merged), 19);

  const known = [{ start: 0, end: 5, text: "one" }, { start: 5, end: 10, text: "two" }];
  assert.equal(covered(known, 1, 6).length, 2);
  assert.equal(covered(known, 9, 14).length, 0);
  assert.equal(covered(known, 8, 13).length, 0);
  assert.equal(covered(known, 7, 12).length, 1);
});

test("SRT and VTT read as subtitles, with a floor on how short a cue is", () => {
  assert.equal(stamp(3723.4567), "01:02:03,457");
  assert.equal(stamp(0.5, "."), "00:00:00.500");
  const lines = [{ start: 0, end: 4.5, text: "Hello there." }, { start: 4.5, end: 4.5, text: "Hi." }];
  assert.equal(toSrt(lines), "1\n00:00:00,000 --> 00:00:04,500\nHello there.\n\n2\n00:00:04,500 --> 00:00:05,000\nHi.\n");
  assert.equal(toVtt(lines), "WEBVTT\n\n00:00:00.000 --> 00:00:04.500\nHello there.\n\n00:00:04.500 --> 00:00:05.000\nHi.\n");
  assert.equal(toText(lines), "Hello there.\nHi.");
  assert.equal(formatOf(undefined), "json");
  assert.equal(formatOf("srt"), "srt");
  assert.equal(formatOf("doc"), null);
  assert.equal(languageCode(undefined), "");
  assert.equal(languageCode("original"), "");
  assert.equal(languageCode(" DE "), "de");
  assert.equal(languageCode("deu"), null);
  assert.equal(languageCode(3), null);
});

test("saving makes the table once, hashes the media, and appends unless the row or the ask is whole", async () => {
  const world = db();
  const store = new Transcripts(world.queryable);
  const saved = await store.save({
    media: "url:https://example.com/a.mp4",
    language: "",
    by: "acct-1",
    title: "A film",
    model: "whisper-base",
    lines: [{ start: 5, end: 10, text: "two" }, { start: 0, end: 5, text: "one" }],
  });
  await store.save({ media: "url:https://example.com/a.mp4", language: "", by: "acct-1", lines: [] });
  assert.equal(world.asked.filter((q) => q.text.includes("CREATE TABLE")).length, 1);
  const insert = world.asked.find((q) => q.text.includes("INSERT INTO transcripts"));
  assert.ok(insert);
  assert.equal(insert.values[0], transcriptIdOf("url:https://example.com/a.mp4"));
  assert.equal(insert.values[3], "url");
  assert.equal(insert.values[6], false);
  assert.equal(insert.values[9], 10);
  assert.deepEqual(JSON.parse(insert.values[10] as string), [{ start: 0, end: 5, text: "one" }, { start: 5, end: 10, text: "two" }]);
  assert.equal(insert.values[11], MAX_LINES);
  assert.match(insert.text, /WHEN EXCLUDED\.complete THEN EXCLUDED\.lines/);
  assert.match(insert.text, /WHEN transcripts\.complete THEN transcripts\.lines/);
  assert.match(insert.text, /ELSE transcripts\.lines \|\| EXCLUDED\.lines/);
  assert.match(insert.text, /complete = transcripts\.complete OR EXCLUDED\.complete/);
  assert.ok(saved);
  assert.equal(saved.kind, "url");
  assert.equal(saved.seconds, 10);
  assert.equal(saved.lines.length, 2);
  assert.equal(saved.updatedAt, "2026-09-13T12:00:00.000Z");
  const shown = wire(saved, [{ language: "", translatedFrom: null, lines: 2, complete: false }]);
  assert.equal(shown["id"], saved.id);
  assert.deepEqual(shown["languages"], [{ language: "", translatedFrom: null, lines: 2, complete: false }]);

  // The store never raises out of quietly(); the memory copy is what answers.
  const broken: Queryable = { query: async () => { throw new Error("the database is having a moment"); } };
  const said: string[] = [];
  const shaky = new Transcripts(broken, (message) => said.push(message));
  assert.equal(await shaky.quietly("a transcript", () => shaky.save({ media: "url:x", language: "", by: "a", lines: [] })), null);
  assert.match(said[0] ?? "", /a transcript did not persist: the database is having a moment/);
});

test("reading: the original is the heard row, the whole one first; a language is its own row; lists and languages", async () => {
  const row = {
    id: "a".repeat(64), language: "", media: "file:v1:ab", kind: "file", translated_from: null, model: "m", complete: true, title: "T",
    by_account: "acct-1", seconds: "12.5", lines: [{ start: 0, end: 5, text: "one" }, { start: 0.2, end: 5.2, text: "one again" }],
    updated_at: "2026-09-13T12:00:00.000Z",
  };
  const world = db({
    "translated_from IS NULL": [row],
    "AND language = $2": [{ ...row, language: "de", translated_from: "", lines: [{ start: 0, end: 5, text: "eins" }] }],
    "jsonb_array_length(lines) AS lines\n       FROM transcripts WHERE id": [
      { language: "", translated_from: null, complete: true, lines: "2" },
      { language: "de", translated_from: "", complete: true, lines: "1" },
    ],
    "WHERE by_account = $1": [{ ...row, lines: "7" }],
  });
  const store = new Transcripts(world.queryable);
  const original = await store.get("a".repeat(64));
  assert.ok(original);
  assert.equal(original.complete, true);
  assert.equal(original.seconds, 12.5);
  assert.equal(original.kind, "file");
  // Duplicates in a row are merged on the way out too.
  assert.deepEqual(original.lines.map((line) => line.text), ["one again"]);
  assert.match(world.asked[world.asked.length - 1]?.text ?? "", /ORDER BY \(language = ''\) DESC, complete DESC, updated_at DESC LIMIT 1/);

  const german = await store.get("a".repeat(64), "de");
  assert.ok(german);
  assert.equal(german.language, "de");
  assert.equal(german.translatedFrom, "");
  assert.deepEqual(german.lines, [{ start: 0, end: 5, text: "eins" }]);

  assert.deepEqual(await store.languages("a".repeat(64)), [
    { language: "", translatedFrom: null, lines: 2, complete: true },
    { language: "de", translatedFrom: "", lines: 1, complete: true },
  ]);

  const listed = await store.list("acct-1", 5000);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.lines, 7);
  assert.equal(listed[0]?.title, "T");
  const list = world.asked.find((q) => q.text.includes("WHERE by_account = $1"));
  assert.deepEqual(list?.values, ["acct-1", 500]);

  assert.equal(await store.forget("a".repeat(64), "acct-1"), false);
  const gone = world.asked.find((q) => q.text.startsWith("DELETE FROM transcripts"));
  assert.deepEqual(gone?.values, ["a".repeat(64), "acct-1"]);
});

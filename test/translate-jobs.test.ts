import { test } from "node:test";
import assert from "node:assert/strict";
import type { Queryable } from "../src/follows.ts";
import { Translator } from "../src/translate.ts";
import { StoredTranslations } from "../src/translate-jobs.ts";
import { Transcripts, transcriptIdOf, type TranscriptLine } from "../src/transcripts.ts";

/** A store with one film in it, kept in memory the way the table would keep it. */
function world(originalLines: TranscriptLine[], options: { complete?: boolean; language?: string } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const media = "file:v1:" + "cd".repeat(32);
  const id = transcriptIdOf(media);
  rows.set(options.language ?? "en", {
    id, language: options.language ?? "en", media, translated_from: null, model: "whisper", complete: options.complete ?? true, title: "A film",
    by_account: "acct-1", seconds: 100, lines: originalLines, updated_at: new Date(0),
  });
  const saved: { language: string; complete: boolean; lines: number }[] = [];
  const db: Queryable = {
    async query(text, values = []) {
      if (text.includes("INSERT INTO transcripts")) {
        const language = values[1] as string;
        const complete = values[6] as boolean;
        const lines = JSON.parse(values[10] as string) as TranscriptLine[];
        saved.push({ language, complete, lines: lines.length });
        const had = rows.get(language);
        const row = {
          id, language, media, translated_from: values[4], model: values[5], complete: complete || had?.["complete"] === true, title: values[7],
          by_account: values[8], seconds: values[9], updated_at: new Date(0),
          lines: complete ? lines : [...((had?.["lines"] as TranscriptLine[] | undefined) ?? []), ...lines],
        };
        rows.set(language, row);
        return { rows: [row] };
      }
      if (values[0] !== id) return { rows: [] };
      if (text.includes("translated_from IS NULL")) return { rows: [rows.get(options.language ?? "en") as Record<string, unknown>] };
      if (text.includes("AND language = $2")) {
        const row = rows.get(values[1] as string);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
  const asked: string[][] = [];
  const translator = new Translator({
    load: async (model) => ({
      translate: async (texts) => {
        asked.push(texts);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return texts.map((text) => `${model.slice(-5)}:${text}`);
      },
    }),
  });
  const events: string[] = [];
  const store = new Transcripts(db);
  const jobs = new StoredTranslations(store, translator, (message) => events.push(message));
  return { id, media, rows, saved, asked, events, jobs, store };
}

const line = (i: number): TranscriptLine => ({ start: i * 5, end: i * 5 + 5, text: `line ${i}` });

test("a short transcript is translated before the ask is answered, and the original is answered as itself", async () => {
  const w = world([line(0), line(1), line(2)]);
  const original = await w.jobs.get(w.id, "", "acct-2");
  assert.equal(original.status, 200);
  const same = await w.jobs.get(w.id, "en", "acct-2");
  assert.equal(same.status, 200);
  const german = await w.jobs.get(w.id, "de", "acct-2");
  assert.equal(german.status, 200);
  if (german.status !== 200) return;
  assert.equal(german.transcript.language, "de");
  assert.equal(german.transcript.translatedFrom, "en");
  assert.equal(german.transcript.complete, true);
  assert.deepEqual(german.transcript.lines.map((one) => one.text), ["en-de:line 0", "en-de:line 1", "en-de:line 2"]);
  assert.deepEqual(w.asked, [["line 0", "line 1", "line 2"]]);
  // Kept as it went, then the whole, marked complete like the original.
  assert.deepEqual(w.saved.map((one) => `${one.language}:${one.complete}:${one.lines}`), ["de:false:3", "de:true:3"]);
  // Asking again is the stored one; nothing is translated twice.
  const again = await w.jobs.get(w.id, "de", "acct-2");
  assert.equal(again.status, 200);
  assert.equal(w.asked.length, 1);
  assert.match(w.events[0] ?? "", /translated 3 lines/);
});

test("a long transcript is a job: 202 with progress, joined by a second ask, and 200 once it is as far along as the original", async () => {
  const w = world(Array.from({ length: 20 }, (_, i) => line(i)));
  const first = await w.jobs.get(w.id, "sv", "acct-2");
  assert.equal(first.status, 202);
  if (first.status !== 202) return;
  assert.equal(first.transcript, null);
  assert.deepEqual(first.translating, { done: 0, total: 20 });
  assert.equal(w.jobs.running().length, 1);
  const second = await w.jobs.get(w.id, "sv", "acct-2");
  assert.equal(second.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const done = await w.jobs.get(w.id, "sv", "acct-2");
  assert.equal(done.status, 200);
  if (done.status !== 200) return;
  assert.equal(done.transcript.lines.length, 20);
  assert.equal(done.transcript.complete, true);
  // Eight at a time, and every line once.
  assert.deepEqual(w.asked.map((batch) => batch.length), [8, 8, 4]);
  assert.equal(w.jobs.running().length, 0);
});

test("only the lines the store lacks are translated, a live original is answered as far as it goes, and the refusals have a status", async () => {
  const w = world([line(0), line(1), line(2), line(3)], { complete: false });
  // Two lines already in Swedish, from a captioner that was asked for Swedish while it ran.
  w.rows.set("sv", {
    ...w.rows.get("en"), language: "sv", translated_from: "en", complete: false,
    lines: [{ start: 0, end: 5, text: "rad 0" }, { start: 5, end: 10, text: "rad 1" }],
  });
  const got = await w.jobs.get(w.id, "sv", "acct-2");
  assert.equal(got.status, 200);
  if (got.status !== 200) return;
  assert.deepEqual(got.transcript.lines.map((one) => one.text), ["rad 0", "rad 1", "en-sv:line 2", "en-sv:line 3"]);
  assert.deepEqual(w.asked, [["line 2", "line 3"]]);
  // Not marked complete: the original is a live still going.
  assert.deepEqual(w.saved.map((one) => one.complete), [false]);

  const unknown = await w.jobs.get("0".repeat(64), "de", "acct-2");
  assert.equal(unknown.status, 404);
  const nowhere = await w.jobs.get(w.id, "xx", "acct-2");
  assert.equal(nowhere.status, 409);

  const mute = new StoredTranslations(w.store, undefined);
  const cannot = await mute.get(w.id, "de", "acct-2");
  assert.equal(cannot.status, 503);

  const silent = world([line(0)], { language: "" });
  const unheard = await silent.jobs.get(silent.id, "de", "acct-2");
  assert.equal(unheard.status, 409);
});

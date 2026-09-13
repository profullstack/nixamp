import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechError } from "../src/speech.ts";
import { BATCH, CHARS_PER_MINUTE, KEEP_LOADED, LANGUAGES, PAIRS, QUEUE_LIMIT, Translator, modelFor, route, type Pair } from "../src/translate.ts";

test("a route is the pair model when there is one, English in between when there is not, and nothing when English cannot reach it", () => {
  assert.deepEqual(route("en", "de"), [["en", "de"]]);
  assert.deepEqual(route("sv", "en"), [["sv", "en"]]);
  assert.deepEqual(route("ja", "sv"), [["ja", "en"], ["en", "sv"]]);
  assert.deepEqual(route("de", "de"), []);
  assert.equal(route("xx", "de"), null);
  assert.equal(route("en", "xx"), null);
  const few = new Set(["en-de", "sv-en"]);
  assert.deepEqual(route("sv", "de", few), [["sv", "en"], ["en", "de"]]);
  assert.equal(route("de", "sv", few), null);
  assert.equal(modelFor("en", "sv"), "Xenova/opus-mt-en-sv");
  // German and Swedish, the two that were asked for, are there with names in both languages.
  assert.ok(PAIRS.has("en-de") && PAIRS.has("en-sv") && PAIRS.has("de-en") && PAIRS.has("sv-en"));
  assert.equal(LANGUAGES["sv"]?.native, "Svenska");
  assert.equal(LANGUAGES["de"]?.name, "German");
  assert.ok(BATCH <= 8);
});

test("pairs load once, translate in order through English when they must, and the least used is let go", async () => {
  const loads: string[] = [];
  const disposed: string[] = [];
  const asked: { model: string; texts: string[] }[] = [];
  let now = 0;
  const translator = new Translator({
    cacheDir: "/nowhere",
    keep: 2,
    now: () => now,
    load: async (model) => {
      loads.push(model);
      const tag = model.replace("Xenova/opus-mt-", "");
      const pair: Pair = {
        translate: async (texts) => {
          asked.push({ model, texts });
          return texts.map((text) => `${tag}(${text})`);
        },
        dispose: () => {
          disposed.push(model);
        },
      };
      return pair;
    },
  });
  assert.equal(translator.can("en", "de"), true);
  assert.equal(translator.can("en", "xx"), false);
  assert.ok(translator.targets("sv").includes("de"));
  assert.ok(!translator.targets("sv").includes("sv"));

  const one = await translator.translate(["Hello there.", "", "  Bye.  "], "en", "de", { by: "acct-1" });
  assert.deepEqual(one, { texts: ["en-de(Hello there.)", "", "en-de(Bye.)"], from: "en", to: "de", model: "Xenova/opus-mt-en-de" });
  // Empty lines never reach the model.
  assert.deepEqual(asked[0]?.texts, ["Hello there.", "Bye."]);
  await translator.translate(["Again."], "en", "de");
  assert.deepEqual(loads, ["Xenova/opus-mt-en-de"]);

  // Swedish to German goes through English, and says so.
  now = 1000;
  const two = await translator.translate(["Hej."], "sv", "de");
  assert.equal(two.model, "Xenova/opus-mt-sv-en then Xenova/opus-mt-en-de");
  assert.deepEqual(two.texts, ["en-de(sv-en(Hej.))"]);
  assert.deepEqual(translator.loadedModels().sort(), ["Xenova/opus-mt-en-de", "Xenova/opus-mt-sv-en"]);

  // A third pair pushes out the one not used for longest.
  now = 2000;
  await translator.translate(["Bonjour."], "fr", "en");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(translator.loadedModels().length, 2);
  assert.ok(translator.loadedModels().includes("Xenova/opus-mt-fr-en"));
  assert.equal(disposed.length, 1);

  // The same language is nothing to do; an unknown pair is a 400 with a sentence.
  assert.deepEqual((await translator.translate(["x"], "de", "de")).texts, ["x"]);
  await assert.rejects(() => translator.translate(["x"], "en", "xx"), (error: unknown) => error instanceof SpeechError && error.status === 400);
  await assert.rejects(() => translator.translate(["x"], "ko", "ja"), /no model here from ko to ja/);

  // The throttle is in characters a minute, per account, and starts over each minute.
  translator.allow("acct-2", CHARS_PER_MINUTE);
  assert.throws(() => translator.allow("acct-2", 1), (error: unknown) => error instanceof SpeechError && error.status === 429);
  now += 60_000;
  translator.allow("acct-2", 1);
  assert.ok(KEEP_LOADED >= 2);
});

test("warming loads what it is told and says when it could not; a failed load is tried again; the queue has a ceiling", async () => {
  let attempts = 0;
  const translator = new Translator({
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new SpeechError("cannot", 503);
      return { translate: async (texts) => texts.map((text) => `de(${text})`) };
    },
  });
  assert.equal(await translator.warm(["en-de", "nonsense"]), false);
  assert.match(translator.lastFailure, /cannot/);
  assert.equal((await translator.translate(["a"], "en", "de")).texts[0], "de(a)");
  assert.equal(attempts, 2);

  const slow = new Translator({
    load: async () => ({
      translate: async (texts) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return texts;
      },
    }),
  });
  const pending = Array.from({ length: QUEUE_LIMIT }, () => slow.translate(["x"], "en", "de"));
  await assert.rejects(() => slow.translate(["x"], "en", "de"), /too much is being translated/);
  assert.equal((await Promise.all(pending)).length, QUEUE_LIMIT);
});

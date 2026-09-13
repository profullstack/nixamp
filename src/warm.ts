/**
 * `bun dist/warm.js` -- fetch the models now, so the image carries them.
 *
 * Run at build time by the Dockerfile. nixamp.com's filesystem is thrown
 * away with every deploy, so without this the ear (80 MB) and every
 * translation pair (about 100 MB each) were downloaded again at the first
 * ask after each one, and the first person to speak waited for it. The
 * models land in NIXAMP_STT_CACHE and the image keeps them.
 *
 * NIXAMP_MT_WARM names the pairs: German and Swedish both ways with
 * English, and Spanish both ways with English and German by default.
 * Exits non-zero when anything could not be fetched, so a build does not
 * quietly ship without its ear.
 */
import { Speech } from "./speech.ts";
import { Translator } from "./translate.ts";

const DEFAULT_PAIRS = "en-de,en-sv,de-en,sv-en,es-en,en-es,es-de,de-es";

async function main(): Promise<number> {
  const speech = new Speech();
  console.error(`warming ${speech.model}...`);
  if (!(await speech.warm())) {
    console.error(`could not load the ear: ${speech.lastFailure}`);
    return 1;
  }
  const pairs = (process.env["NIXAMP_MT_WARM"] ?? DEFAULT_PAIRS).split(",").map((one) => one.trim()).filter(Boolean);
  const translator = new Translator({ keep: pairs.length });
  console.error(`warming ${pairs.join(", ")}...`);
  if (!(await translator.warm(pairs))) {
    console.error(`could not load a translation pair: ${translator.lastFailure}`);
    return 1;
  }
  console.error(`ready: ${speech.model} and ${translator.loadedModels().join(", ")}`);
  return 0;
}

main().then((code) => {
  process.exit(code);
}, (error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});

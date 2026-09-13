/**
 * A stored transcript, translated: the job that does it, and its progress.
 *
 * A film's transcript is more than a thousand lines, and a thousand lines
 * through a Marian model is minutes of CPU. No request waits that long.
 * The first ask for a language starts the job and answers 202 with what
 * there is; the job keeps the store up as it goes, so a second ask sees
 * more, and a process that dies mid-way leaves behind what it had done
 * for the next one to carry on from -- only the lines the store has no
 * translation of yet are sent to the model. When the translation is as
 * far along as the original, the ask is answered 200 with it.
 *
 * One job per transcript and language at a time; asking again joins the
 * job that is running rather than starting another.
 */
import { SpeechError } from "./speech.ts";
import { BATCH, type Translator } from "./translate.ts";
import { lineAt, type Transcript, type TranscriptLine, type Transcripts } from "./transcripts.ts";

export interface Progress {
  done: number;
  total: number;
}

interface Job {
  progress: Progress;
  finished: Promise<void>;
  error: string;
}

/** What a request should answer: the status and the body's extra fields. */
export type Answer =
  | { status: 200; transcript: Transcript }
  | { status: 202; transcript: Transcript | null; translating: Progress }
  | { status: 404 | 409 | 503; error: string };

export class StoredTranslations {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly store: Transcripts,
    private readonly translator: Translator | undefined,
    private readonly onEvent: (message: string) => void = () => {},
  ) {}

  /** The lines of the original that the translation does not yet have. */
  static missing(original: Transcript, translation: Transcript | null): TranscriptLine[] {
    if (!translation) return original.lines;
    return original.lines.filter((line) => lineAt(translation.lines, line.start) === null);
  }

  /**
   * The transcript in a language, or the job making it. The original when
   * the language is the one it was heard in.
   */
  async get(id: string, language: string, by: string): Promise<Answer> {
    const original = await this.store.get(id);
    if (!original) return { status: 404, error: "nothing has been written down for that" };
    if (language === "" || language === original.language) return { status: 200, transcript: original };
    const translation = await this.store.get(id, language);
    const missing = StoredTranslations.missing(original, translation);
    if (translation && missing.length === 0) return { status: 200, transcript: translation };
    if (original.language === "") return { status: 409, error: "the language this was heard in is not known, so it cannot be translated" };
    if (!this.translator) return { status: 503, error: "this nixamp cannot translate: no model here. nixamp.com can." };
    if (!this.translator.can(original.language, language)) {
      return { status: 409, error: `there is no model here from ${original.language} to ${language}` };
    }
    const key = `${id}|${language}`;
    let job = this.jobs.get(key);
    if (job?.error) {
      this.jobs.delete(key);
      return { status: 503, error: job.error };
    }
    if (!job) {
      job = this.start(key, original, translation, missing, language, by);
      // A short one is done before the ask is answered.
      if (missing.length <= BATCH) {
        await job.finished;
        if (job.error) {
          this.jobs.delete(key);
          return { status: 503, error: job.error };
        }
        const made = await this.store.get(id, language);
        if (made) return { status: 200, transcript: made };
      }
    }
    return { status: 202, transcript: translation, translating: { ...job.progress } };
  }

  private start(key: string, original: Transcript, translation: Transcript | null, missing: TranscriptLine[], language: string, by: string): Job {
    const job: Job = { progress: { done: original.lines.length - missing.length, total: original.lines.length }, finished: Promise.resolve(), error: "" };
    job.finished = this.run(original, translation, missing, language, by, job)
      .catch((error: unknown) => {
        job.error = error instanceof SpeechError ? error.message : `translating failed: ${(error as Error).message}`;
        this.onEvent(`  translating ${original.title || original.media} to ${language}: ${job.error}`);
      })
      .finally(() => {
        if (!job.error) this.jobs.delete(key);
      });
    this.jobs.set(key, job);
    return job;
  }

  private async run(original: Transcript, translation: Transcript | null, missing: TranscriptLine[], language: string, by: string, job: Job): Promise<void> {
    const translator = this.translator as Translator;
    const made: TranscriptLine[] = translation ? [...translation.lines] : [];
    let model = "";
    for (let at = 0; at < missing.length; at += BATCH) {
      const batch = missing.slice(at, at + BATCH);
      const done = await translator.translate(batch.map((line) => line.text), original.language, language);
      model = done.model;
      const lines = batch.map((line, i) => ({ start: line.start, end: line.end, text: done.texts[i] ?? "" })).filter((line) => line.text !== "");
      made.push(...lines);
      await this.store.save({
        media: original.media, language, translatedFrom: original.language, model, title: original.title, by, lines,
      });
      job.progress.done += batch.length;
    }
    if (original.complete) {
      // Whole, like the original: the pieces are replaced by the lot, and nothing partial touches it again.
      await this.store.save({
        media: original.media, language, translatedFrom: original.language, model, title: original.title, by, lines: made, complete: true,
      });
    }
    if (missing.length > 0) this.onEvent(`  translated ${missing.length} lines of ${original.title || original.media} to ${language}`);
  }

  /** What is being translated right now. */
  running(): { key: string; progress: Progress }[] {
    return [...this.jobs.entries()].filter(([, job]) => !job.error).map(([key, job]) => ({ key, progress: { ...job.progress } }));
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interpreter, SpeakerTracker } from '../src/interpreter.ts';
import type { SpeakerTurn } from '../../src/speaker-turns.ts';
import type { Caption } from '../src/captions.ts';
const voices = [
  { id: 'male-a', name: 'A', gender: 'male', language: 'en' },
  { id: 'male-b', name: 'B', gender: 'male', language: 'en' },
  { id: 'female-a', name: 'C', gender: 'female', language: 'en' },
];
const turn = (speaker: string, start: number, end: number, profile: 'lower' | 'higher' = 'lower'): SpeakerTurn => ({ speaker, start, end, text: 'La pelea sigue.', profile, words: [{ text: 'La pelea sigue.', start, end }] });
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('overlapping speaker turns retain voices when provider labels swap; equal pitches get distinct voices', () => {
  const tracker = new SpeakerTracker();
  const first = tracker.reconcile([turn('speaker_0', 0, 2), turn('speaker_1', 3, 4.8)], 10000, voices);
  assert.notEqual(first.get('speaker_0')!.voice, first.get('speaker_1')!.voice);
  const next = tracker.reconcile([turn('speaker_1', 0, 1), turn('speaker_0', 2, 3.8)], 11000, voices);
  assert.equal(next.get('speaker_1')!.id, first.get('speaker_0')!.id);
  assert.equal(next.get('speaker_0')!.voice, first.get('speaker_1')!.voice);
  const absent = tracker.reconcile([turn('speaker_0', 0, 2)], 40000, voices);
  assert.notEqual(absent.get('speaker_0')!.id, first.get('speaker_0')!.id, 'pitch is not identity');
  tracker.reset(); assert.equal(tracker.speakers.size, 0);
});

test('only fresh words are translated and spoken; overlap is context and source remains Spanish', async () => {
  const emitted: Caption[][] = [], translated: string[][] = [];
  const interpreter = new Interpreter({
    language: () => 'en', speakers: () => true, voices: () => voices, channel: () => 'local',
    lines: lines => emitted.push(lines), status: () => {}, failed: () => assert.fail('unexpected failure'),
    fetcher: (async (url, init) => {
      if (String(url).includes('/speakers')) return Response.json({ language: 'es', seconds: 10, turns: [turn('speaker_0', 1, 3), turn('speaker_1', 6, 8, 'higher')] });
      const ask = JSON.parse(String(init?.body)); assert.equal(ask.from, 'es'); assert.equal(ask.to, 'en'); translated.push(ask.texts);
      return Response.json({ texts: ['The fight continues.'] });
    }) as typeof fetch,
  });
  const now = Date.now(); interpreter.push({ at: now - 10000, until: now, freshAt: now - 5000, samples: new Float32Array(160000) });
  await settle();
  assert.equal(translated[0]!.length, 1); assert.equal(emitted[0]!.length, 1);
  assert.equal(emitted[0]![0]!.sourceLanguage, 'es'); assert.equal(emitted[0]![0]!.speaker, 'speaker-2');
  assert.equal(emitted[0]![0]!.voiceProfile, 'higher');
  interpreter.reset();
});

test('native captions use only fresh five seconds, and playback changes discard late model responses', async () => {
  let finish!: (response: Response) => void, count = 0;
  const emitted: Caption[][] = [];
  const interpreter = new Interpreter({
    language: () => '', speakers: () => false, voices: () => [], channel: () => 'local',
    lines: lines => emitted.push(lines), status: () => {}, failed: () => assert.fail('unexpected failure'),
    fetcher: (async (url, init) => {
      count++; assert.equal(String(url), '/api/v1/speech/transcribe?live=1');
      assert.equal((init?.body as Uint8Array).length, 160044);
      return await new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch,
  });
  const now = Date.now(), window = { at: now - 15000, until: now, freshAt: now - 5000, samples: new Float32Array(240000) };
  interpreter.push(window); interpreter.push(window); interpreter.push(window);
  assert.equal(count, 1); interpreter.reset(); finish(Response.json({ text: 'stale words', language: 'es' })); await settle();
  assert.equal(emitted.length, 0); assert.equal(count, 1);
});


test("voice allocation is unique and ignores pitch, including a noisy opening phrase", () => {
  const low = new SpeakerTracker(() => 0), high = new SpeakerTracker(() => 0);
  const a = low.reconcile([turn("a", 0, 1), turn("b", 2, 3), turn("c", 4, 5)], 1000, voices);
  const b = high.reconcile([turn("a", 0, 1, "higher"), turn("b", 2, 3, "higher"), turn("c", 4, 5, "higher")], 1000, voices);
  assert.deepEqual([...a.values()].map(s=>s.voice), [...b.values()].map(s=>s.voice));
  assert.equal(new Set([...a.values()].map(s=>s.voice)).size, 3);
  a.get("a")!.voice = "manual-choice";
  const next = low.reconcile([turn("changed-label", 0, 1, "higher")], 1000, voices);
  assert.equal(next.get("changed-label")!.voice, "manual-choice", "manual voice survives recognition label changes");
});

test('recovers words from a skipped pending window without repeating the overlap', async () => {
  const now = Date.now(), base = now - 6000, heard: string[] = [];
  let finish!: (response: Response) => void, requests = 0;
  const t = (text: string, start: number, end: number) => ({ ...turn('a', start, end), text, words: [{ text, start, end }] });
  const interpreter = new Interpreter({ language: () => 'es', speakers: () => true, voices: () => voices, channel: () => 'local',
    lines: lines => heard.push(...lines.map(line => line.text)), status: () => {}, failed: () => assert.fail('unexpected failure'),
    fetcher: (async () => {
      if (++requests === 1) return await new Promise<Response>(resolve => { finish = resolve; });
      return Response.json({ language: 'es', turns: [t('Uno.', .2, 1), t('Dos.', 2.2, 3), t('Tres.', 4.2, 5)] });
    }) as typeof fetch });
  const window = (seconds: number) => ({ at: base, until: base + seconds * 1000, freshAt: base + (seconds - 2) * 1000, samples: new Float32Array(seconds * 16000) });
  interpreter.push(window(2)); interpreter.push(window(4)); interpreter.push(window(6));
  finish(Response.json({ language: 'es', turns: [t('Uno.', .2, 1)] }));
  await settle();
  assert.equal(requests, 2);
  assert.deepEqual(heard, ['Uno.', 'Dos.', 'Tres.']);
  interpreter.reset();
});

test('short capture intervals retain unfinished phrases for context instead of translating sentence fragments', async () => {
  const now = Date.now(), base = now - 4000, asks: string[][] = [];
  let requests = 0;
  const interpreter = new Interpreter({ language: () => 'de', speakers: () => true, voices: () => voices, channel: () => 'local',
    lines: () => {}, status: () => {}, failed: () => assert.fail('unexpected failure'),
    fetcher: (async (url, init) => {
      if (String(url).includes('/speakers')) {
        const words = [{ text: 'When Rodgers', start: .2, end: 1.85 }];
        if (++requests > 1) words.push({ text: 'played his best.', start: 2, end: 3.5 });
        return Response.json({ language: 'en', turns: [{ ...turn('a', .2, words.at(-1)!.end), words }] });
      }
      asks.push(JSON.parse(String(init!.body)).texts); return Response.json({ texts: ['Als Rodgers am besten spielte.'] });
    }) as typeof fetch });
  interpreter.push({ at: base, until: base + 2000, freshAt: base, samples: new Float32Array(32000) }); await settle();
  assert.equal(asks.length, 0, 'unfinished opening stays in recognition context');
  interpreter.push({ at: base, until: now, freshAt: now - 2000, samples: new Float32Array(64000) }); await settle();
  assert.deepEqual(asks, [['When Rodgers played his best.']]);
  interpreter.reset();
});

test('recognition proceeds while translation is pending; reset cancels both stages without late captions', async () => {
  const now = Date.now(), emitted: Caption[] = [];
  let heard = 0, translated = 0, finish!: (response: Response) => void;
  const signals: AbortSignal[] = [];
  const interpreter = new Interpreter({ language: () => 'de', speakers: () => true, voices: () => voices, channel: () => 'local',
    lines: lines => emitted.push(...lines), status: () => {}, failed: () => assert.fail('unexpected failure'),
    fetcher: (async (url, init) => {
      signals.push(init!.signal!);
      if (String(url).includes('/speakers')) { heard++; return Response.json({ language: 'es', turns: [turn('a', .2, 1.5)] }); }
      translated++; return await new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch });
  interpreter.push({ at: now - 4000, until: now - 2000, freshAt: now - 4000, samples: new Float32Array(32000) }); await settle();
  interpreter.push({ at: now - 2000, until: now, freshAt: now - 2000, samples: new Float32Array(32000) }); await settle();
  assert.equal(heard, 2, 'the text model cannot hold up incoming audio');
  assert.equal(translated, 1, 'translation remains ordered and bounded to one request');
  interpreter.reset();
  assert.ok(signals.at(-1)!.aborted);
  finish(Response.json({ texts: ['Zu spät.'] })); await settle();
  assert.equal(emitted.length, 0); assert.equal(translated, 1);
});

test('long translations are divided without dropping words or speaker metadata', async () => {
  const { splitCaption } = await import('../src/interpreter.ts');
  const text = Array.from({ length: 250 }, (_, i) => `Wort${i}`).join(' ');
  const lines = splitCaption({ channel: 'ufc', at: 1000, until: 6000, text, language: 'de', speaker: 'speaker-2' });
  assert.equal(lines.map(line => line.text).join(' '), text);
  assert.ok(lines.every(line => line.text.length <= 600 && line.speaker === 'speaker-2'));
  assert.ok(lines.every((line, i) => i === 0 || line.at > lines[i-1]!.at));
});

test('a transient recognition or text failure skips a phrase and recovers without disabling translation', async () => {
  for (const stage of ['recognition', 'translation']) {
    let requests = 0, texts = 0;
    const emitted: Caption[] = [];
    const interpreter = new Interpreter({ language: () => 'de', speakers: () => true, voices: () => voices, channel: () => 'local',
      lines: lines => emitted.push(...lines), status() {}, failed: message => assert.fail(message),
      fetcher: (async url => {
        if (String(url).includes('/speakers')) {
          if (++requests === 1 && stage === 'recognition') return Response.json({ error: 'Temporary outage' }, { status: 503 });
          return Response.json({ language: 'es', turns: [turn('a', .1, 1.5)] });
        }
        if (++texts === 1 && stage === 'translation') return Response.json({ error: 'Temporary outage' }, { status: 502 });
        return Response.json({ texts: ['Die nächste Aussage.'] });
      }) as typeof fetch });
    try {
      const now = Date.now();
      for (let i = 0; i < 2; i++) { interpreter.push({ at: now - 4000 + i * 2000, until: now - 2000 + i * 2000, freshAt: now - 4000 + i * 2000, samples: new Float32Array(32000) }); await settle(); }
      assert.equal(emitted.length, 1); assert.equal(emitted[0]!.text, 'Die nächste Aussage.');
    } finally { interpreter.reset(); }
  }
});

test('recognition recovery stops after three consecutive failures and never retries access or budget errors', async () => {
  for (const status of [503, 401, 402, 429]) {
    const failures: string[] = [];
    let requests = 0;
    const interpreter = new Interpreter({ language: () => 'de', speakers: () => true, voices: () => voices, channel: () => 'local',
      lines() {}, status() {}, failed: message => failures.push(message),
      fetcher: (async () => { requests++; return Response.json({ error: `Failure ${status}` }, { status }); }) as typeof fetch });
    try {
      const attempts = status === 503 ? 3 : 1;
      for (let i = 0; i < attempts; i++) { const now = Date.now(); interpreter.push({ at: now - 2000, until: now, freshAt: now - 2000, samples: new Float32Array(32000) }); await settle(); }
      assert.equal(requests, attempts); assert.deepEqual(failures, [`Failure ${status}`]);
    } finally { interpreter.reset(); }
  }
});

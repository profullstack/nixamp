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

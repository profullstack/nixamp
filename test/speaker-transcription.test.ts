import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoice } from '../src/live-voice.ts';
import { encodeWav, SpeechError } from '../src/speech.ts';
import { EmptyEngine, createServer } from '../src/server.ts';
import type { Accounts } from '../src/accounts.ts';
import type { AddressInfo } from 'node:net';

function audio(seconds = 5) {
  return encodeWav(Float32Array.from({ length: seconds * 16000 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * (i < 40000 ? 120 : 230) * i / 16000)));
}
const result = { language_code: 'spa', words: [
  { type: 'word', text: 'Moreno avanza.', start: 0, end: 2, speaker_id: 'speaker_0' },
  { type: 'audio_event', text: '(crowd)', start: 2, end: 2.3 },
  { type: 'word', text: 'La pelea sigue.', start: 2.5, end: 4.9, speaker_id: 'speaker_1' },
] };

test('a provider rejection refunds once, blocks other accounts during cooldown, then recovers', async () => {
  let now = 0, calls = 0, reserved = 0, refunded = 0, committed = 0;
  const billing = { require: async () => {}, reserve: async () => { reserved++; return 'reservation'; }, refund: async () => { refunded++; }, commit: async () => { committed++; } };
  const voice = new LiveVoice({ apiKey: 'key', now: () => now, billing, fetcher: (async () => {
    calls++;
    return calls === 1 ? Response.json({ detail: { status: 'quota_exceeded' } }, { status: 401 }) : Response.json(result);
  }) as typeof fetch });
  await assert.rejects(voice.hear(audio(), 'alice'), error => error instanceof SpeechError && error.status === 402);
  await assert.rejects(voice.hear(audio(), 'bob'), /credits are exhausted/);
  await assert.rejects(voice.voices(), /credits are exhausted/);
  assert.deepEqual([calls, reserved, refunded, committed], [1, 1, 1, 0]);
  now = 300_001;
  await voice.hear(audio(), 'bob');
  assert.deepEqual([calls, reserved, refunded, committed], [2, 2, 1, 1]);
});

test('Scribe auto-detects native language, separates speakers, and receives canonical bounded WAV only', async () => {
  let calls = 0;
  const voice = new LiveVoice({ apiKey: 'key', fetcher: (async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/speech-to-text');
    const form = init!.body as FormData;
    assert.equal(form.get('model_id'), 'scribe_v2');
    assert.equal(form.get('diarize'), 'true');
    assert.equal(form.has('language_code'), false);
    assert.equal((form.get('file') as Blob).size, 160044);
    return Response.json(result);
  }) as typeof fetch });
  const heard = await voice.hear(audio(), 'alice');
  assert.equal(heard.language, 'es');
  assert.deepEqual(heard.turns.map(t => [t.speaker, t.profile]), [['speaker_0', 'lower'], ['speaker_1', 'higher']]);
  assert.deepEqual(heard.turns.map(t => t.text), ['Moreno avanza.', 'La pelea sigue.']);
  assert.equal((await voice.hear(encodeWav(new Float32Array(80000)), 'alice')).turns.length, 0);
  await assert.rejects(voice.hear(audio(16), 'alice'), /15 seconds/);
  assert.equal(calls, 1);
});

test('speaker analysis refuses concurrent work from one account and enforces a global audio budget', async () => {
  let finish!: () => void, calls = 0;
  const voice = new LiveVoice({ apiKey: 'key', dailyAudioSeconds: 5, fetcher: (async () => {
    calls++; await new Promise<void>(resolve => { finish = resolve; }); return Response.json(result);
  }) as typeof fetch });
  const first = voice.hear(audio(), 'alice');
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(voice.hear(audio(), 'alice'), /busy/);
  finish(); await first;
  await assert.rejects(voice.hear(audio(), 'bob'), error => error instanceof SpeechError && error.status === 429);
  assert.equal(calls, 1);
});

test('the speaker endpoint needs account authentication before accepting any paid audio', async () => {
  let calls = 0;
  const voice = new LiveVoice({ apiKey: 'key', fetcher: (async () => { calls++; return Response.json(result); }) as typeof fetch });
  const server = createServer(new EmptyEngine(), {
    web: null, media: false, version: 'test', liveVoice: voice,
    accounts: { whoIs: async (token: string) => token === 'account' ? { id: 'alice' } : null } as unknown as Accounts,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/speech/speakers`;
  const post = (token: string, type = 'audio/wav') => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: new Uint8Array(audio()) });
  try {
    assert.equal((await post('')).status, 401);
    assert.equal((await post((await voice.grant('alice', 'ufc')).token)).status, 401);
    assert.equal(calls, 0);
    assert.equal((await post('account', 'text/plain')).status, 415);
    assert.equal((await post('account')).status, 200);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('two-second live cadence remains throttled and retains the persistent audio budgets', async () => {
  let calls = 0;
  const voice = new LiveVoice({ apiKey: 'key', now: () => 0, fetcher: (async () => { calls++; return Response.json(result); }) as typeof fetch });
  const bytes = audio(6); // Two new seconds plus four seconds of overlap.
  for (let i = 0; i < 36; i++) await voice.hear(bytes, 'alice');
  await assert.rejects(voice.hear(bytes, 'alice'), error => error instanceof SpeechError && error.status === 429);
  assert.equal(calls, 36);
  const limited = new LiveVoice({ apiKey: 'key', dailyAudioSeconds: 6, fetcher: (async () => Response.json(result)) as typeof fetch });
  await limited.hear(bytes, 'bob');
  await assert.rejects(limited.hear(bytes, 'bob'), /budget/);
});

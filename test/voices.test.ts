import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICES, ELEVENLABS_FEMALE, ELEVENLABS_MALE, KOKORO_FEMALE, KOKORO_MALE, Profiles, Voices,
  poolsFrom, readProfileVoice, spokenLine, spokenVoiceFor, telnyxVoiceFor, voiceKindOf, voicesFromEnv,
} from "../src/voices.ts";
import { cleanProfile, cleanVoice } from "../src/handles.ts";

const ada = `# Ada Lovelace

- **Kind**: person
- **Handle**: @ada
- **Pronouns**: she/her
- **Voice**: female

Writes about machines that do not exist yet.

## Accounts

- [Bluesky](https://bsky.app/profile/ada.example)

## Match

- **Born**: 1990-05-12
- **Gender**: woman
`;

const kokoro = poolsFrom({} as NodeJS.ProcessEnv, null);
const eleven = poolsFrom({} as NodeJS.ProcessEnv, "elevenlabs");

test("the words people use for themselves become a voice, and anything else nothing", () => {
  assert.equal(voiceKindOf("female"), "female");
  assert.equal(voiceKindOf("Woman"), "female");
  assert.equal(voiceKindOf("she/her"), "female");
  assert.equal(voiceKindOf("she/they"), "female");
  assert.equal(voiceKindOf("male"), "male");
  assert.equal(voiceKindOf("he/him"), "male");
  assert.equal(voiceKindOf("Man"), "male");
  assert.equal(voiceKindOf("they/them"), "");
  assert.equal(voiceKindOf("non-binary"), "");
  assert.equal(voiceKindOf(""), "");
  assert.equal(voiceKindOf(42), "");
});

test("an OpenProfile's voice is read from the identity block, and its gender from Match too", () => {
  assert.deepEqual(readProfileVoice(ada), { voice: "female", gender: "woman", pronouns: "she/her" });
  const plain = readProfileVoice("# Bob\n\n- Kind: person\n- Pronouns: he/him\n\n## Topics\n\n- Gender: this is not the identity block\n");
  assert.deepEqual(plain, { voice: "", gender: "", pronouns: "he/him" });
  const match = readProfileVoice("# Cy\n\nA headline.\n\n## Dating\n\n- **Gender**: man\n");
  assert.equal(match.gender, "man");
  assert.deepEqual(readProfileVoice("no heading at all"), { voice: "", gender: "", pronouns: "" });
});

test("a sex picks from that sex's pool by the account id: the same person always, different people differently", () => {
  // Kokoro is the free pool and the default: eleven women, eight men.
  assert.equal(kokoro.provider, "kokoro");
  assert.deepEqual(kokoro.female, KOKORO_FEMALE);
  assert.deepEqual(kokoro.male, KOKORO_MALE);
  assert.equal(kokoro.settings, undefined);
  const men = new Set(Array.from({ length: 200 }, (_, i) => spokenVoiceFor({ userId: `acct-${i}`, voice: "male" }, kokoro).voice));
  assert.ok(men.size >= 6, `${men.size} distinct men's voices across 200 accounts`);
  for (const one of men) assert.ok(KOKORO_MALE.includes(one), one);
  const women = new Set(Array.from({ length: 200 }, (_, i) => spokenVoiceFor({ userId: `acct-${i}`, voice: "female" }, kokoro).voice));
  assert.ok(women.size >= 8);
  for (const one of women) assert.ok(KOKORO_FEMALE.includes(one), one);
  // The same account, the same voice, every time.
  assert.equal(spokenVoiceFor({ userId: "acct-7", voice: "male" }, kokoro).voice, spokenVoiceFor({ userId: "acct-7", voice: "male" }, kokoro).voice);
  // Nothing known: from the whole pool, still stable.
  const any = spokenVoiceFor({ userId: "acct-9" }, kokoro).voice;
  assert.ok([...KOKORO_FEMALE, ...KOKORO_MALE].includes(any));
  assert.equal(spokenVoiceFor({ userId: "acct-9" }, kokoro).voice, any);
  // The profile decides when the account says nothing.
  assert.ok(KOKORO_FEMALE.includes(spokenVoiceFor({ userId: "u1", voice: "", profile: readProfileVoice(ada) }, kokoro).voice));
  assert.ok(KOKORO_MALE.includes(spokenVoiceFor({ userId: "u1", profile: { voice: "", gender: "", pronouns: "he/him" } }, kokoro).voice));
  // A voice named outright is used as written, from either place.
  assert.equal(spokenVoiceFor({ userId: "u1", voice: "Polly.Joanna" }, kokoro).voice, "Polly.Joanna");
  assert.equal(spokenVoiceFor({ userId: "u1", profile: { voice: "Telnyx.KokoroTTS.bm_george", gender: "", pronouns: "" } }, kokoro).voice, "Telnyx.KokoroTTS.bm_george");
});

test("ElevenLabs is used when Telnyx holds the key, by labelled gender, with the secret riding along; Kokoro when told to", () => {
  assert.equal(eleven.provider, "elevenlabs");
  assert.deepEqual(eleven.settings, { api_key_ref: "elevenlabs" });
  const her = spokenVoiceFor({ userId: "acct-1", voice: "female" }, eleven);
  assert.ok(ELEVENLABS_FEMALE.includes(her.voice));
  assert.deepEqual(her.settings, { api_key_ref: "elevenlabs" });
  const him = spokenVoiceFor({ userId: "acct-1", voice: "male" }, eleven);
  assert.ok(ELEVENLABS_MALE.includes(him.voice));
  // A Kokoro voice named outright needs no ElevenLabs settings even when the pools have them.
  assert.deepEqual(spokenVoiceFor({ userId: "acct-1", voice: "Telnyx.KokoroTTS.am_adam" }, eleven), { voice: "Telnyx.KokoroTTS.am_adam" });
  // Told to stay free, it stays free.
  assert.equal(poolsFrom({ NIXAMP_TTS: "kokoro" } as NodeJS.ProcessEnv, "elevenlabs").provider, "kokoro");
  // Lists from the environment replace a pool outright; one voice per sex is a pool of one.
  const custom = poolsFrom({ NIXAMP_VOICES_MALE: "Polly.Matthew, Polly.Joey" } as NodeJS.ProcessEnv, null);
  assert.equal(custom.provider, "custom");
  assert.deepEqual(custom.male, ["Polly.Matthew", "Polly.Joey"]);
  assert.deepEqual(custom.female, KOKORO_FEMALE);
  const one = poolsFrom({ NIXAMP_VOICE_FEMALE: "ElevenLabs.Premade.Rachel" } as NodeJS.ProcessEnv, "elevenlabs");
  assert.deepEqual(one.female, ["ElevenLabs.Premade.Rachel"]);
  assert.deepEqual(spokenVoiceFor({ userId: "u", voice: "female" }, one), { voice: "ElevenLabs.Premade.Rachel", settings: { api_key_ref: "elevenlabs" } });
  // The older one-voice-per-sex callers still get an answer.
  const voices = voicesFromEnv({ NIXAMP_VOICE_FEMALE: "ElevenLabs.Premade.Rachel" } as NodeJS.ProcessEnv);
  assert.equal(voices.male, DEFAULT_VOICES.male);
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "female" }, voices), "ElevenLabs.Premade.Rachel");
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "male" }, voices), DEFAULT_VOICES.male);
  assert.equal(spokenLine("chovy-fu", "  hello   room "), "chovy fu says: hello room");
});

test("the Telnyx account is asked once whether it holds an ElevenLabs secret, and a failed ask is asked again", async () => {
  let asked = 0;
  let answer: { status: number; body: unknown } = { status: 200, body: { data: [{ identifier: "openai" }, { identifier: "elevenlabs" }] } };
  const events: string[] = [];
  const make = () => new Voices({
    telnyxApiKey: "KEY",
    env: {} as NodeJS.ProcessEnv,
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      asked += 1;
      assert.match(String(url), /\/integration_secrets/);
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer KEY");
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    onEvent: (message) => events.push(message),
  });
  const voices = make();
  assert.equal((await voices.pools()).provider, "elevenlabs");
  assert.equal((await voices.pools()).provider, "elevenlabs");
  assert.equal(asked, 1);
  assert.match(events[0] ?? "", /ElevenLabs/);
  // No such secret: Kokoro.
  answer = { status: 200, body: { data: [{ identifier: "openai" }] } };
  const without = make();
  assert.equal((await without.pools()).provider, "kokoro");
  // Telnyx down: Kokoro now, asked again next time.
  answer = { status: 500, body: {} };
  const down = make();
  const before = asked;
  assert.equal((await down.pools()).provider, "kokoro");
  answer = { status: 200, body: { data: [{ identifier: "elevenlabs" }] } };
  assert.equal((await down.pools()).provider, "elevenlabs");
  assert.equal(asked, before + 2);
  // A secret by another name.
  const named = new Voices({
    telnyxApiKey: "KEY",
    env: { NIXAMP_ELEVENLABS_SECRET: "eleven-prod" } as NodeJS.ProcessEnv,
    fetcher: (async () => new Response(JSON.stringify({ data: [{ identifier: "eleven-prod" }] }), { status: 200 })) as typeof fetch,
  });
  assert.deepEqual((await named.pools()).settings, { api_key_ref: "eleven-prod" });
});

test("a voice and a profile are cleaned before they are kept", () => {
  assert.deepEqual(cleanVoice("Female"), { voice: "female", error: "" });
  assert.deepEqual(cleanVoice("any"), { voice: "", error: "" });
  assert.deepEqual(cleanVoice(undefined), { voice: "", error: "" });
  assert.deepEqual(cleanVoice("Telnyx.KokoroTTS.am_adam"), { voice: "Telnyx.KokoroTTS.am_adam", error: "" });
  assert.deepEqual(cleanVoice("ElevenLabs.pNInz6obpgDQGcFmaJgB"), { voice: "ElevenLabs.pNInz6obpgDQGcFmaJgB", error: "" });
  assert.match(cleanVoice("loud").error, /female, male, any/);
  assert.match(cleanVoice(7).error, /a word/);
  assert.deepEqual(cleanProfile(" https://ada.example/.well-known/openprofile.md "), { profile: "https://ada.example/.well-known/openprofile.md", error: "" });
  assert.deepEqual(cleanProfile(""), { profile: "", error: "" });
  assert.match(cleanProfile("ftp://x").error, /http/);
  assert.match(cleanProfile("not a url").error, /URL/);
});

test("a profile is fetched once an hour, and a fetch that fails keeps what was read before", async () => {
  let asked = 0;
  let status = 200;
  let now = 0;
  const profiles = new Profiles((async () => {
    asked += 1;
    return new Response(status === 200 ? ada : "gone", { status });
  }) as typeof fetch, () => now);
  const first = await profiles.voiceOf("https://ada.example/.well-known/openprofile.md");
  assert.equal(first?.gender, "woman");
  assert.equal(asked, 1);
  await profiles.voiceOf("https://ada.example/.well-known/openprofile.md");
  assert.equal(asked, 1);
  now += 61 * 60 * 1000;
  status = 500;
  const again = await profiles.voiceOf("https://ada.example/.well-known/openprofile.md");
  assert.equal(asked, 2);
  assert.equal(again?.gender, "woman");
  assert.equal(await profiles.voiceOf("mailto:ada@example.com"), null);
  assert.equal(await profiles.voiceOf("nonsense"), null);
});

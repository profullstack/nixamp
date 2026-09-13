import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOICES, Profiles, readProfileVoice, spokenLine, telnyxVoiceFor, voiceKindOf, voicesFromEnv } from "../src/voices.ts";
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

test("the Telnyx voice: what was set, then the profile, then one picked by the id and never a coin toss", () => {
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "male" }), DEFAULT_VOICES.male);
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "ElevenLabs.Premade.Adam" }), "ElevenLabs.Premade.Adam");
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "", profile: readProfileVoice(ada) }), DEFAULT_VOICES.female);
  assert.equal(telnyxVoiceFor({ userId: "u1", profile: { voice: "Telnyx.KokoroTTS.bm_george", gender: "", pronouns: "" } }), "Telnyx.KokoroTTS.bm_george");
  assert.equal(telnyxVoiceFor({ userId: "u1", profile: { voice: "", gender: "", pronouns: "he/him" } }), DEFAULT_VOICES.male);
  // Nothing known: the same id is the same voice every time, and different ids differ.
  const picked = telnyxVoiceFor({ userId: "acct-1" });
  assert.equal(telnyxVoiceFor({ userId: "acct-1" }), picked);
  assert.ok(Object.values(DEFAULT_VOICES).includes(picked));
  const both = new Set(Array.from({ length: 40 }, (_, i) => telnyxVoiceFor({ userId: `acct-${i}` })));
  assert.equal(both.size, 2);
  // Configured voices take over per sex.
  const voices = voicesFromEnv({ NIXAMP_VOICE_FEMALE: "ElevenLabs.Premade.Rachel" } as NodeJS.ProcessEnv);
  assert.equal(voices.female, "ElevenLabs.Premade.Rachel");
  assert.equal(voices.male, DEFAULT_VOICES.male);
  assert.equal(telnyxVoiceFor({ userId: "u1", voice: "female" }, voices), "ElevenLabs.Premade.Rachel");
  assert.equal(spokenLine("chovy-fu", "  hello   room "), "chovy fu says: hello room");
});

test("a voice and a profile are cleaned before they are kept", () => {
  assert.deepEqual(cleanVoice("Female"), { voice: "female", error: "" });
  assert.deepEqual(cleanVoice("any"), { voice: "", error: "" });
  assert.deepEqual(cleanVoice(undefined), { voice: "", error: "" });
  assert.deepEqual(cleanVoice("Telnyx.KokoroTTS.am_adam"), { voice: "Telnyx.KokoroTTS.am_adam", error: "" });
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

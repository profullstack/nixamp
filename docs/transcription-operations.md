# Transcription provider controls

Speaker transcription uses ElevenLabs Scribe v2. Ordinary `/speech/transcribe`
uses local Whisper and does not spend ElevenLabs credits.

ElevenLabs may report exhausted credits or permission problems with HTTP 401.
The server reads the provider error code and returns a terminal 402 (provider
billing/quota) or 424 (provider access), rather than a retryable 502. It refunds
the listener's reservation when the provider rejects a request.

After a rejection, the LiveVoice instance pauses provider requests for five
minutes for billing/access failures, 30–300 seconds for rate limits, or ten
seconds for other provider errors. This cooldown is per server process; the
existing spending limits are persisted in PostgreSQL and shared by replicas.

`voice_provider_failure` logs the operation, HTTP status, allowlisted provider
code, and cooldown. `voice_provider_usage` records accepted audio seconds or
characters and a hashed account/source identifier. Neither contains audio,
transcript text, API keys, or raw provider error bodies. Shared streams use a
source identifier here; listener charges remain in `translation_usage`.

Configure daily spending ceilings with `NIXAMP_DUB_DAILY_CHARS`,
`NIXAMP_DUB_DAILY_AUDIO_SECONDS`, `NIXAMP_DUB_USER_DAILY_CHARS`, and
`NIXAMP_DUB_USER_DAILY_AUDIO_SECONDS`. Audio includes overlapping context sent
to Scribe. These are unit limits, not currency limits, and do not cover use of
the provider key outside LiveVoice (including telephone voices).


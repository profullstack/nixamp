# AI radio and listener shares

Two ways music reaches a server's stations without the owner choosing every file, both shown on
the public guide (`/guide`, or `/` on a guide host such as the Moshpit name `live.streaming`).

## AI radio: stations whose music is composed for them

An AI station is a style in words. On its schedule a language model writes the next track's title
and brief from that style and the titles the station already has (so it does not repeat itself), a
music model composes it, ffmpeg writes its tags (title, artist "<station> (AI)", album, genre AI,
and a comment saying what made it), and the file lands in `$XDG_STATE_HOME/nixamp/ai-music/<key>/`,
a managed library source. The station is an ordinary station: same link, rotation, breaks and
metering. It is made with its first track; each new one joins on the next track.

    nixamp station ai key ELEVENLABS_API_KEY < key.txt     # once; or set it in the environment
    nixamp station ai key GEMINI_API_KEY < key.txt         # the brief writer (or OPENAI_ / ANTHROPIC_)
    nixamp station ai create --preset lofi                 # lofi, synthwave, ambient, chiptune, punk, jazz
    nixamp station ai create --name "Harbor FM" --style "sea shanty folk, accordion, fiddle, stomping" --vocals
    nixamp station ai                                      # what is composing, this month's seconds
    nixamp station ai generate KEY                         # one now
    nixamp station ai budget 1800                          # seconds of music a month, all AI stations

- **Schedule.** The first 3 tracks as soon as possible, then `perDay` (2) spread over the day,
  each `trackSeconds` long (120; 30-300). One track at a time across the server; checked every 5 min.
- **Budget.** Composition is metered in seconds of music per calendar month across every AI
  station (`monthlySeconds`, 900 by default, 0 for no cap), and stops for the month at the cap.
  ElevenLabs Music costs about 30 credits a second (300 for a 10 s test, 2026-10), so 900 s is
  about 27,000 credits. A provider that says the key or the plan is out of credit pauses
  everything until `nixamp station ai resume`.
- **Composers.** ElevenLabs Music (`ELEVENLABS_API_KEY`; a paid plan's music may be used
  commercially), or a model of your own: `NIXAMP_AI_MUSIC_COMMAND` is run with `{prompt}`,
  `{seconds}`, `{vocals}` and `{out}` replaced (each one argument) and must leave an MP3 at `{out}`,
  e.g. a MusicGen or ACE-Step script on a GPU box.
- **Briefs.** Gemini (`GEMINI_API_KEY`, `NIXAMP_GEMINI_MODEL`, default gemini-flash-latest), else
  OpenAI (`OPENAI_API_KEY`, `NIXAMP_OPENAI_MODEL`, gpt-4.1-mini), else Anthropic. Without any, the
  station's own style with a drawn mood and title. Briefs never name an artist or quote a lyric;
  a brief ElevenLabs will not make comes back with one it will, which is used once.
- **Rights.** Unless made with `--unlisted`, the station is public, listed, and declared `owned`
  with a note saying it is original music composed by AI. That is the owner's declaration, made by
  creating it; it is not legal clearance.
- **Keys** live in the environment or `$XDG_STATE_HOME/nixamp/ai.json` (0600, `nixamp station ai
  key NAME` from stdin; `--clear` forgets one). The owner view says which are set, never what.

## Listener shares: anybody shares a track

With shares open, the guide has a **Share a track** form: a link to an MP3 (or OGG, FLAC, M4A,
WAV), or the file itself, with the basis on which it may be broadcast (`owned`, `permission`,
`licensed`, `creative-commons`, `public-domain`), an optional note and credit, and a box the sharer
must tick. Then:

1. The file is copied to `$XDG_STATE_HOME/nixamp/shares/<id>/` (a managed source): public addresses
   only, every redirect checked, a web page refused, at most `maxMb` (60), and a file already
   shared (same SHA-256 or link) is refused.
2. ffprobe must find music in it, 20 s to 20 min.
3. A language model reads what the file says about itself (tags, name, where it came from, the
   declaration) and answers a genre and a verdict: **clear** (plausibly the sharer's own, independent,
   CC or public domain), **doubt** (looks like a commercial release or a rip), or **refuse** (not
   music, spam). With `moderation: ai`, clear goes on the air; doubt waits for the owner; refuse is
   turned away and its copy deleted. With `moderation: owner`, or no model key, everything waits.
4. Approved tracks play on **Shared: <genre>** stations, made and kept in step automatically,
   public and listed (basis `permission`, noting each track was declared by its sharer) unless
   `--unlisted`. A genre with nothing approved stops and leaves the guide.

Anybody listening can press **Report this track** on a shared station: the track playing leaves the
rotation at once, the station skips past it, and it waits for the owner. The sharer gets a status
link (`/api/v1/share/<id>?t=<token>`) that shows how it went, and `DELETE` on it withdraws the track
and deletes the copy.

    nixamp station shares on                     # AI moderation, public stations
    nixamp station shares on --owner-moderation  # everything waits for you
    nixamp station shares                        # what is waiting
    nixamp station shares approve|reject|delete SHARE
    nixamp station shares trust 1.2.3.4          # a proxy (dev2 for live.streaming) whose X-Forwarded-For is believed
    nixamp station shares off

Each sharer may share `perHour` (6) an hour, counted by a salted hash of their address (the
address itself is never kept). Behind a reverse proxy, trust it (`shares trust`, or
`NIXAMP_TRUSTED_PROXIES`) or every visitor counts as one.

## HTTP

Public (no key):

| | |
| --- | --- |
| `GET /api/v1/share` | `{open, bases, genres, maxMb, perHour}` |
| `POST /api/v1/share` | `{url, basis, note?, by?, agree: true}` → `202 {share, token, status}` |
| `PUT /api/v1/share/upload?name=&basis=&note=&by=&agree=1` | the file as the body, `content-type: audio/*` → `202` |
| `GET` / `DELETE /api/v1/share/:id?t=TOKEN` | how it went / withdraw it |
| `POST /api/v1/share/report` | `{station, reason?}` (what is playing) or `{share, reason?}` |

Owner (control key or owner session):

| | |
| --- | --- |
| `GET /api/v1/stations/ai` | composer, writer, month's seconds, cap, pause, keys set, stations |
| `POST /api/v1/stations/ai` | `{monthlySeconds?, resume?}` |
| `POST /api/v1/stations/ai/keys` | `{name, value}` ("" forgets it) |
| `POST /api/v1/stations/ai/stations` | `{preset? \| name + style, description?, vocals?, trackSeconds?, perDay?, enabled?, publish?}` |
| `GET/PATCH/DELETE /api/v1/stations/ai/stations/:key` | `DELETE ?files=1` also removes its station and music |
| `POST /api/v1/stations/ai/stations/:key/generate` | compose one now; answers when it is on the station |
| `GET /api/v1/stations/shares?state=` | setting and shares (never a sharer's token) |
| `POST /api/v1/stations/shares` | `{open?, moderation?: ai\|owner, publish?, maxMb?, perHour?}` |
| `POST /api/v1/stations/shares/:id/approve` `/reject` | `{reason?}` |
| `DELETE /api/v1/stations/shares/:id` | the share and its copy |

Codes: `shares_closed` (403), `rights_required`, `agreement_required`, `invalid_url`, `not_audio`,
`too_big` (413), `already_shared` (409), `rate_limited` (429), `queue_full` (503), `unknown_preset`,
`style_required`, `invalid_length`, `invalid_rate`, `budget_used` (429), `paused` (409),
`no_composer` (409), `busy` (409), `compose_failed` (502).

## MCP

`station_ai` (status, create, generate, update, remove, budget, resume) and `station_shares`
(status, list, configure, approve, reject, delete).

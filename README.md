<p align="center">
  <a href="https://nixamp.com"><img src="web/public/hero.png" alt="nixamp" width="800" /></a>
</p>

# nixamp

It really whips the terminal's ass.

```
curl -fsSL https://nixamp.com/install.sh | sh
```

```
nixamp ~/Music
nixamp track.flac
```

```
 ⣿ NIXAMP  ▶ PLAYING                                                              1 tracks  ~/Music
╭─ Now Playing ────────────────────────────────────────────────────────────────────────────────────╮
│ Meshuggah — Bleed                                                                                │
│ obZen                                                                                            │
│ 00:41  █████████████████████████───────────────────────────────────────────────────── 32%  07:27 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Spectrum Analyser ─────────────────────────────────╮ ╭─ Playlist (12) ──────────────────────────╮
│ ⠉⠁⠉⠁⠤⠄⣀⡀                                            │ │  1  Meshuggah — Bleed         07:27      │
│ ⣶⡆⣶⡆⣀⡀  ⠒⠂⠉⠁                                        │ │  2  SOAD — Aerials            03:55      │
│ ⣿⡇⣿⡇⣿⡇⣿⡇⣤⡄⣶⡆⣀⡀⠒⠂⠉⠁  ⠤⠄⣀⡀                            │ │                                          │
│ ⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣀⡀⣿⡇⣿⡇⣤⡄⣤⡄⣀⡀    ⠉⠁⠤⠄⠒⠂    ⣀⡀      │ │                                          │
│ ⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇⣿⡇    │ │                                          │
│ ▆▆▅▅▅▅▄▄▅▄▄▄▄▄▄▃▃▃▃▃▃▃▃▂            L▮▮▮▮·· R▮▮▮▮·· │ │                                          │
╰─────────────────────────────────────────────────────╯ ╰──────────────────────────────────────────╯
 Space Stop  ↑↓ Select  n/p Next/Prev  Enter Play  q Quit
```

## Installing

```
curl -fsSL https://nixamp.com/install.sh | sh
```

Everything lands under `~/.local`. No root, no package manager, no system files
touched. On a machine with a desktop session it installs the app and the CLI
together, and the CLI then runs on the Node inside the app, so there is no
system Node to keep in step. Over SSH it detects that there is no desktop and
installs the CLI alone.

```
curl -fsSL https://nixamp.com/install.sh | sh -s -- --cli-only
curl -fsSL https://nixamp.com/install.sh | sh -s -- --desktop
curl -fsSL https://nixamp.com/install.sh | sh -s -- --version 0.1.0
curl -fsSL https://nixamp.com/install.sh | sh -s -- --prefix ~/opt
```

On Windows, in PowerShell:

```
irm https://nixamp.com/install.ps1 | iex
```

That lands under `%LOCALAPPDATA%\nixamp`, adds itself to your user PATH, and
needs no administrator rights. Nothing is code signed, so SmartScreen will warn
the first time.

Builds are published for Linux, macOS and Windows, on both x64 and arm64.

Then:

```
nixamp update            re-runs the installer, keeping the choices you made
nixamp update 0.2.0      or pins a version
nixamp uninstall         says what would go
nixamp uninstall --yes   removes exactly what the installer created
```

Removal reads a manifest the installer wrote, so it is exact and works with no
network. Your music is never touched.

If you would rather not pipe a script into a shell, `npm i -g nixamp` and
`bunx nixamp ~/Music` both work; that route needs Node 24 or newer.

## Signing in

An account on nixamp.com is what lets you publish, be paid, and administer a
server you own. Three ways in, because a terminal is a bad place to be asked
for a password:

```
nixamp login                 # choose: a provider in a browser, or a password
nixamp login --with github   # straight to GitHub (or google)
nixamp login --password      # an address and a password, here
nixamp whoami
nixamp logout
```

`--with github` is OAuth 2.0 through the device grant (RFC 8628), which is how
a television has signed you in for years: the terminal shows a short code, you
approve it in a browser on whatever device has a keyboard, and the terminal ends
up holding the session. It never sees your password or the provider's token, and
it works over ssh.

The PWA and the desktop app offer the same providers, since an account made by
signing in with GitHub has no password to type anywhere. The CLI keeps its token
beside the daemon's state, mode 600, so signing in there and in the desktop app
are the same thing on disk. A password, where one is used, is read with the echo
off and is never written down.

No magic link. A link in an inbox is no use on a television, or on a phone that
is not the one you read mail on.

### Tokens, for a machine that cannot sign in

```
nixamp token create --name ci   # printed once, and only once
nixamp token list
nixamp token revoke <id>
```

`NIXAMP_TOKEN` in the environment is a signed-in nixamp with no login at all,
which is the only thing that works in CI. Tokens are stored as hashes and can be
withdrawn from anywhere; signing out does not touch them, which is the point of
them. Sessions are the same kind of thing with an expiry, so `nixamp logout`
really does end one.

Providers are configured per deployment, and only a provider with both halves is
offered:

```
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… nixamp serve --directory
```

The callback to register is `https://your-site/api/v1/<provider>/oauth/callback`.

Running the account side of nixamp.com needs Postgres:

```
DATABASE_URL=postgres://user:pass@host/nixamp NIXAMP_JWT_SECRET=… nixamp serve --directory
```

Accounts live where the directory lives and nowhere else: a nixamp on a laptop
has nobody to be an account of.

## Parties, and signing in with nixamp

The web app uses **Join party** for joining a stream or a party on a connected
site. In the **Parties** panel, enter an **Invite code** and select **Join party**
to open its room. A listed party's **Join party** link opens the film on the
site hosting it; **Open room** opens its nixamp room.

A live party also shows the current file's source and folder path, so a course
can read **Course › Section › Lecture**, with its position in that folder's
playlist. Numbered download filenames become readable lecture titles. Share
sheets, browser tabs and device media information follow the current lecture;
course names come from the server's metadata, never a guess from the filename.

A watch party lives on the site that has the film. bittorrented.com has them:
a six-character code, a host, and everybody at the same second. nixamp has
rooms, chat, invitations, a directory, and five clients that can already open
one. A bridged party is both.

The identity link is **OAuth 2.1**, with nixamp.com as the authorization
server. The site sends somebody here, they approve it once, and the site holds
a token that acts on their nixamp account. It is 2.1 and not 2.0, so:

- authorization code only, with PKCE (S256) required of every client, public
  or confidential. No implicit grant, no password grant.
- redirect URIs match the registered string exactly; only a loopback port may
  vary, because a CLI cannot know its port before it listens.
- a code is spent once; presenting it twice withdraws everything it produced.
- refresh tokens rotate, and a retired one presented again withdraws the whole
  family.

The endpoints are where RFC 8414 says to look for them:

```
GET  /.well-known/oauth-authorization-server
GET  /api/v1/oauth/authorize      the consent page
POST /api/v1/oauth/token          authorization_code, refresh_token
POST /api/v1/oauth/revoke
GET  /api/v1/oauth/userinfo
```

Scopes are `profile`, `email`, `parties` and `offline_access`. The Account
panel on nixamp.com lists what is connected and takes it away again.

bittorrented.com is registered out of the box. Another client is added with
`NIXAMP_OAUTH_CLIENTS`, a JSON list:

```
NIXAMP_OAUTH_CLIENTS='[{"id":"example","name":"Example","redirectUris":["https://example.com/cb"]}]'
```

Once a party is bridged it is an ordinary live event with a room, so every
surface already knows what to do with it. Its room is a page,
`nixamp.com/live/<slug>`: the host, where the film is (a clock that keeps
counting), **Join party** to the site that plays it, and the chat, which is
the same chat on the party's own page, in the terminal, in the desktop app
and on a television. Reading one party needs no account, because the code or
the link is the invitation; saying something does.

```
nixamp party list                    the ones you could join right now
nixamp party join ABC123 --open      the room here, the film where it lives
nixamp party host ABC123 --url URL   put one on the air as a nixamp room
nixamp party sync ABC123 --at 930    where playback is (hosts only)
```

and an agent reaches the same five actions over the Model Context Protocol:

```
nixamp mcp     a stdio MCP server: the parties, the rooms, the transcripts
```

It acts as whoever the machine is signed in as, so `nixamp login` comes first.
The film never crosses over: what nixamp carries is the room. The same tools
are at `https://nixamp.com/mcp` over HTTP, with a nixamp token
(`nixamp token create`) as the bearer, for an agent with no nixamp installed;
`/.well-known/oauth-protected-resource` says where the authorization server
is.

## BackToSchool.help

BackToSchool.help is a branded, mobile-first client for NixAmp live events. It
uses the same NixAmp accounts, PostgreSQL data, rooms, invitations, layouts, and
channel transport as the main app; it has no separate backend or user store.

The production Docker image builds both clients and serves the BackToSchool
client for `backtoschool.help` and `www.backtoschool.help`. Attach both domains
to the existing NixAmp service and point their DNS at the hosting provider's
targets. Accounts, event APIs, and live audio stay in that same process. FFmpeg
is installed in the image so hosts can broadcast from their browser.

`NIXAMP_WEB_SITES` maps public origins to built client directories, for example
`{"https://backtoschool.help":"/app/backtoschool/dist"}`. The configured origin
also supplies event metadata and invitation links. Other hosts use `--web`.
An invalid mapping or missing build stops startup rather than serving the wrong
client. `NIXAMP_SITE` continues to identify the shared NixAmp account service.

Build the server and both web clients from the repository root:

```
bun install --frozen-lockfile
bun run build
bun run web:build
bun run backtoschool:build
```

A directory deployment can serve the BackToSchool client instead of the default
NixAmp PWA by pointing `--web` at its build output:

```
DATABASE_URL=postgres://user:pass@host/nixamp \
NIXAMP_JWT_SECRET=replace-with-a-long-random-secret \
NIXAMP_SITE=https://backtoschool.help \
bun src/main.ts serve /srv/nixamp/media \
  --directory --web "$PWD/backtoschool/dist" --host 127.0.0.1 --port 4321 --no-publish
```

Put an HTTPS reverse proxy for `backtoschool.help` in front of that port and
forward the whole origin, including `/api` and `/live`. Do not buffer responses
under `/api/channels/`; those responses carry live audio. Keeping the client and
API on one origin lets the HttpOnly NixAmp session cookie authenticate hosting,
chat, invitations, and moderation. HTTPS is also required for browser microphone
access outside localhost. Event, room, layout, and invitation tables are created
on first use in the configured PostgreSQL database. `RESEND_API_KEY` and
`NIXAMP_MAIL_FROM` are optional if invitation email should be sent rather than
only returning a shareable link.

For a shared deployment, set `BACKTOSCHOOL_MAIL_FROM` to a sender on the verified
`backtoschool.help` Resend domain. School password resets and invitations use
that sender; `BACKTOSCHOOL_RESEND_API_KEY` optionally selects its own key, otherwise
it uses `RESEND_API_KEY`. Verify the domain's SPF and DKIM records in Resend before
enabling the sender. Invitation mail identifies the invitation rather than a follow.

The event form's optional **Write with AI** button uses its current title,
description, and topic as the prompt, with host and schedule context. It previews
a title, description, and topic for explicit application before saving. Configure
server-only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`: OpenAI runs first, with Claude
as fallback for provider failures or invalid output. Defaults are `gpt-5-mini`
and `claude-haiku-4-5`; override them with `NIXAMP_WRITER_OPENAI_MODEL` and
`NIXAMP_WRITER_CLAUDE_MODEL`. Signed-in accounts may request six drafts per ten
minutes, with one active request per account and four across the server. Requests
time out after 25 seconds per provider and can be cancelled. Drafting never saves
an event or changes the schedule, visibility, or broadcast links.

## Live shows, and tickets

A live event carries a **kind**: `talk`, `class`, or `concert`. The kind is
what a branded client reads to pick a layout, and what `/api/v1/events?kind=`
filters the directory by, so one NixAmp serves a school and a venue without
either knowing about the other. `concert` brings its own presets
(`concert-viewer`, `concert-ticketholder`, `concert-artist`) with a stage,
a setlist, a tip jar, a merch shelf and a till.

A concert also has doors and an encore. `POST /api/v1/events/:id/doors` opens
the room before the music, `.../start` begins it, `.../encore` says the band
came back, and `.../end` closes it. Opening, playing and coming back on are
allowed to everyone on the stage; cancelling and archiving stay with the host.
An **artist** is an invitation role beside moderator: they perform without
being handed the guest list.

**A ticket is a paid pass to one room**, over x402 and settled by CoinPay,
exactly like the crawler paywall but scoped to a single event:

```
POST /api/v1/events/:id/tickets          # X-PAYMENT proof in, ticket out
GET  /api/v1/events/:id/tickets          # what it costs and whether you hold one
POST /api/v1/events/:id/tickets/comp     # the guest list, hosts only
```

Set `ticketPriceCents` and a `payTo` address on the event and the room answers
402 to anyone without a ticket, quoting the price; the money goes to the
event's own address, never to the platform. The ticket rides in
`x-nixamp-ticket`, or in `?ticket=` for an `<audio>` or `<video>` element that
cannot set a header. `COINPAY_X402_KEY` switches sales on; without it every
event is simply a free one. `NIXAMP_TICKET_SECRET` signs the passes (it
defaults to the CoinPay key), and each event's tickets are signed with a
secret derived from it and the event id, so a ticket to Friday is not a ticket
to Saturday.

## The directory

Servers start with an **IPTV-org** catalog using its public
[main playlist](https://github.com/iptv-org/iptv#playlists). It is added once
alongside existing catalogs and fetched in the background. Removing it stays
removed on restart; add `https://iptv-org.github.io/iptv/index.m3u` to restore it.
Catalog browsing and file navigation apply immediately after a click. Group
lists are cached until the provider refreshes, and playback updates reuse the
existing file list without moving focus, scrolling, or the browsing page.

[nixamp.com/directory](https://nixamp.com/directory) lists nixamps that agreed
to be listed. In the PWA, **Browse the directory** next to the address field
picks one without typing anything.

`nixamp serve` asks before listing you, and shows the exact link it would
publish:

```
  List this stream at https://nixamp.com/directory so anyone can find it?
  It publishes http://198.51.100.7:4321/view/Lk1EM_mP977e1VT — listen only,
  not the controls. [Y/n]
```

Yes is the default; `--publish` and `--no-publish` skip the question, `--name`
sets what it is called. A terminal that cannot ask never publishes, because
nobody being there to answer is not consent.

What gets published is a **listen-only** link. Every server mints two keys: the
one in your own share link drives the player, and the listen key can hear it
and nothing else. `/api/command` and `/api/source` answer 403 to a listen key,
so a stranger in the directory cannot pause your music or point your machine at
something else.

Entries expire a few minutes after a stream stops renewing, so the list is
always what is actually live.

**A live that ends says so.** A film or a podcast that plays to its end, a
list whose last entry did, or a publisher who stopped, used to start again
from the top for ever. Now the channel plays its outro: five seconds of
"THIS LIVE STREAM HAS ENDED" on the plate with the mark (a soft chime, on a
channel with no picture), looped for an hour, so whoever joins late is told
by the picture and by the page (an ENDED chip and a line in the Log), and
the room's trollbox stays open. Then the channel closes on its own. The
clip is drawn by the server itself with its ffmpeg the first time it is
needed and kept beside the keys; **Start over** on the channel brings the
show back from its beginning. A live feed that drops mid-stream is still
dialled again, as before: only a clean end is an end.

## The trollbox, and saying a line out loud

Every live room has a trollbox: the chat for whoever has joined that stream,
kept at nixamp.com and keyed by the server and the channel, so everybody
watching one stream is in the same box whichever page they came from.
Reading it needs nobody. A line needs a nixamp.com sign-in, and is signed
with the account's public handle, never its address.

A line can be said rather than typed. The microphone button beside the box
is tap, talk, tap: the page records, brings the sound to 16 kHz mono itself,
and sends nixamp.com a small WAV with the room's name on it; the ear posts
the words to the room in the same request, and the line appears. Said is
sent, unless the **Edit before sending** switch under the box is on, in
which case the words wait in the box for Send. A line, once sent, is public
record: there is no taking it down, not by its author and not by the
server's owner.

**On the phone, too.** Every live room has a six-digit code on the party
line (see below), and only when somebody is on the phone in a room, each
trollbox line is read aloud to them: "chovy says: …", in a voice that is
theirs as far as a machine can manage, and different from everybody
else's in the room. The Account panel (or `nixamp profile`, or the
`profile_set` MCP tool) sets it: a woman's voice, a man's, any, or a voice
id; or an OpenProfile URL, whose `Voice`, `Gender` or `Pronouns` decide.
Given a sex, the account picks one voice from that sex's pool and keeps
it; given nothing, one from the whole pool. `nixamp voices` lists them.

Two pools. Telnyx's Kokoro voices are an open-weights model with no bill
beyond the call: eleven women, eight men. ElevenLabs reads better and bills
per character: when the Telnyx account holds an integration secret named
`elevenlabs` with the ElevenLabs key, nixamp.com finds it on its own and
uses ElevenLabs' premade voices by their labelled gender; `NIXAMP_TTS=kokoro`
keeps the free ones regardless. `NIXAMP_VOICES_FEMALE` / `NIXAMP_VOICES_MALE`
(comma lists of Telnyx voice ids) replace either pool outright.
The ear is [Whisper](https://github.com/openai/whisper) run through
[Transformers.js](https://github.com/huggingface/transformers.js), an
Apache-2.0 library carrying MIT-licensed models, on nixamp.com's own CPU.
Nothing is sent to a speech vendor and nothing is billed. It works in the
PWA, the desktop app and on a phone, wherever the browser can record; the
button only appears where a line can be sent from, which is signed in on
nixamp.com.

The same ear is one route, for anything else that has a recording:

```
POST /api/v1/speech/transcribe            a WAV in (16-bit PCM; 16 kHz mono is ideal), {text} out
POST /api/v1/speech/transcribe?server=URL&channel=ID   and the words posted to that room
```

Signed in only, up to a minute at a time, twelve asks a minute per account,
`?language=de` when Whisper should not guess. The CLI and the MCP server
front the same route:

```
nixamp transcribe clip.m4a                        the words in a recording
nixamp transcribe clip.m4a --say https://server1.chovy.nixamp.com:4321
nixamp transcribe clip.m4a --say URL --channel cat-1
```

Anything ffmpeg can read is converted here first; a WAV needs no ffmpeg.
`nixamp mcp` offers `transcribe_audio` (with the same optional room),
`trollbox_say` and `trollbox_read`.

### Subtitles: what a live is saying

Every live channel can be captioned. The server carrying it listens to its
own stream, turns the sound into five-second windows with its ffmpeg, and
has nixamp.com's ear turn each window into a line stamped with the moment
its sound was at the live edge. The lines go out as Server-Sent Events:

```
GET /api/channels/ID/captions      an event stream: `hello` with the recent lines, then a `line` each
GET /api/channels/ID/transcript    the recent lines as JSON (?after=MS for only the new ones)
```

Both are read with the same key as the sound. The page opens the stream as
soon as you join a live and shows a **Transcript** panel, on by default:
each line is held until your own playback has reached the sound it came
from (the backlog you were handed, plus a little buffering) and then shown,
on the picture when there is one and in the panel always. Close to the
voice, not on it: a line is a window, not a word. The switch in the panel
turns captions off for that device; the Panels list hides the panel.

A captioner runs only while somebody is asking, and stops a minute after
the last one leaves; silence between songs is never sent. The server needs
an ffmpeg and a sign-in (`nixamp login`) for the ear to answer it. In the
terminal, `nixamp transcript --channel ID --follow` prints the lines as
they come; an agent reads them with the `transcript_read` tool.

The model is an optional dependency, because it is hundreds of megabytes
with the ONNX runtime under it and the CLI tarball is pure JavaScript. A
`nixamp serve` on a laptop answers 503 to this route and every client asks
nixamp.com instead. `NIXAMP_STT_MODEL` picks another Whisper
(`onnx-community/whisper-base` by default; `whisper-small` hears better and
takes twice as long), `NIXAMP_STT_CACHE` says where its files are kept, and
`NIXAMP_STT=off` leaves the ear out of a deployment altogether.

Captions default to **Original (auto-detect)**. Each audio window detects its
own language and explicitly transcribes it. A language selected in the menu
only affects translation; neither it nor a cached transcript can force the
recognizer into English. Short windows have a decoding limit, and silent
audio and repetitive hallucinations are discarded. Language is stored on
each line, so an interview can switch languages. Legacy live-caption cache
entries are heard again instead of replaying their incorrect words.

At most four channels are captioned per server, with two recognition requests
per channel in flight. Live work expires after twelve seconds. Translation
keeps one active request and the latest pending line per target; joining a
live reads cached translations without starting a whole-transcript job.

### Kept: written down once, for everybody

What the ear hears is kept on nixamp.com under the identity of what was
playing, not of the channel that happened to play it: a file by its
fingerprint (its size and a megabyte at each end), a link by its address, a
live as the one broadcast it was. Lines are seconds into the media. The next
captioner to meet the same film reads the lines out of the store instead of
hearing them, whichever server it is on; what it hears beyond them is added.

```
nixamp transcribe FILE                     the whole film, a minute at a time, kept when it is done
nixamp transcribe FILE --srt > film.srt    as subtitles; --vtt, --txt, --json
nixamp transcribe FILE --out DIR           a subtitle file per language in DIR
nixamp transcript --kept MEDIA_OR_ID       what nixamp.com keeps, for a file, a link or a past live
nixamp transcript --list                   everything this account has had written down
```

```
GET  /api/v1/transcripts                   what you have had written down
GET  /api/v1/transcripts/ID                the transcript; ?format=srt|vtt|txt, ?language=de
POST /api/v1/transcripts/ID/lines          keep lines: {media, language, lines: [{start, end, text}], complete?}
DELETE /api/v1/transcripts/ID              forget it (whoever kept it)
```

ID is the sha256 of the media identity, or the identity itself
(`file:v1:<hash>`, `url:<address>`, `live:<server>/<channel>@<started>`).
Signed in to read and to keep, like the ear. A whole-file pass marks the row
complete and replaces the pieces a captioner left; a live grows as it goes
and a page that asks for it reads what there is so far. An agent has
`transcript_get` and `transcripts_list`, and `transcribe_audio` keeps a film
the same way.

### One address per file: nixamp.com/hash/ID

Every file nixamp meets gets a page at `/hash/<sha256>`, the SHA-256 of its
bytes, the way OpenFile (logicsrc.com/docs/openfile) names a file, so the same
film on two machines is one page. The page, and the OpenFile descriptor beside
it, carry the size, the type, when the file last changed, what ffprobe found
inside, what nichedb.dev says it is, which servers have carried it and as which
channel, and its transcripts in every language, as subtitle files. Whoever
meets the file fills it in: `nixamp hash`, `nixamp transcribe`, and a server
that puts the file on the air.

```
nixamp hash FILE                  the hash, the address, and what is known, kept
nixamp hash FILE --no-keep        the hash and the address only
nixamp hash --get ID              what nixamp.com knows, by hash or fingerprint
```

```
GET /hash/ID                      the page; JSON when Accept says so
GET /hash/ID.json                 the OpenFile file object with nixamp's facts under `nixamp`
GET /hash/ID.openfile.json        the same, as a descriptor
GET /hash/ID.srt                  the transcript as subtitles; .vtt, .txt; ?language=de
GET /api/v1/media/ID              the record; PUT it, signed in, with what you know
GET /.well-known/openfile.json    every file nixamp.com knows, as a publisher's listing
```

ID is the hash with or without `sha256:`, the transcript store's fingerprint,
or a transcript id. Reading is open, since the hash of the bytes is the file;
keeping is signed in.

A file changes. The machine holding it keeps an index of what it has told
nixamp.com and looks at each file again on a schedule set by how recently it
changed: a quarter of the time since its last change, between a quarter of an
hour and a month, so a file being edited is checked often and a film from 2019
once a month. A stat is all it costs until something moved; then the file is
hashed again, the new record says what it was and the old one what it became.
An agent has `media_hash` and `media_get`.

### In another language

Ask for a language and the lines come translated, by an open-source model on
nixamp.com's own CPU (Helsinki-NLP's OPUS-MT pairs, through Transformers.js):
German and Swedish among the languages, and anything with a model from or
into English; a pair with no model of its own goes through English. A
translation is made once and kept beside the original.

```
GET  /api/channels/ID/captions?language=sv   a live's lines in Swedish, each translated as it is heard
GET  /api/v1/transcripts/ID?language=de      a kept transcript in German; 202 with progress while a long one is made
GET  /api/v1/translate                       the languages, and what each can be turned into here
POST /api/v1/translate                       {texts, from, to} -> {texts}
```

```
nixamp transcript --channel ID --language sv    a live, in Swedish, as it speaks
nixamp transcribe FILE --translate de,sv        a film in German and Swedish too
nixamp translate --to sv "Hello there"          a line; or lines on stdin
nixamp translate --languages                    what nixamp.com can do
```

The page has the same choice beside the Captions switch, remembered per
device; a translated line is marked with its language and shows what was
heard under the pointer. An agent has `translate_text`. `NIXAMP_MT_WARM`
names pairs to load at boot (`en-de,en-sv`), `NIXAMP_MT=off` leaves
translation out. The Docker image includes the ear, German/Swedish pairs
with English, and Spanish pairs with English and German. Spanish-to-German
uses its direct model; it does not first translate the audio into English.


### Hear it in your language

Every signed-in account gets **ten free live-use sessions per UTC day**, shared
across Nixamp's paid panels and upgrades. There is no timed cutoff: a session
continues while its listener remains, within the existing API usage limits.
Reconnects to the same session within 90 seconds reuse it. A stopped session
expires after that grace period; starting again then uses another allowance.
The counter resets at midnight UTC without interrupting an ongoing session.
Balance polling, captions and individual voice chunks never consume new sessions.
Free usage has zero customer charge and leaves purchased credit untouched.
The panel shows the remaining allowance alongside any purchased credit.

**Buy translated audio** (`$` in the player or Transcript title bar) offers
prepaid, account-bound passes: **$5 / 24 hours**, **$25 / 7 days**, or **$100 /
30 days**. Each purchase provides that many dollars of usage credit, not
unlimited listening. There is no automatic renewal. Credit expires; buying
before expiry adds the credit and keeps the later expiry. At 1,000 translated
characters/minute with normal recognition overlap, the passes provide about
16, 81, or 327 minutes respectively. Actual speech density changes the allowance.

Paid access is **5× base speech API cost (400% markup)**: $0.25 per 1,000 Flash
characters and $1.10 per submitted Scribe audio hour. Recognition includes
repeated context, normally three submitted hours per listening hour. The price
is the same for every listener, including reused audio; reuse reduces provider
spending. Captions and self-hosted text translation retain their existing free
access and throttles.

CoinPay hosts crypto checkout with the merchant's configured currencies. Network
fees are shown separately at checkout. Nixamp creates fixed-price orders on the
server and verifies the stored payment ID, confirmed status, USD currency, and
exact price before crediting the account. Returning from checkout or sending a
client-side `paid` flag never unlocks access. Pending purchases can be resumed
from the panel on another device signed into the same account.

PostgreSQL atomically reserves usage credit before paid calls, refunds rejected
provider requests, and credits a confirmed payment once across concurrent checks.
Accepted speech is charged even if playback is canceled. Money is stored as
integer micro-USD. The ledger uses base cost rounded up to a micro-dollar, then
multiplied by five. Credentials and balances never travel in checkout URLs.
New checkout creation is capped at five per account and fifty per account server
per UTC day, plus IP and request throttles; retries reuse the original invoice.

After the ten free sessions, new sessions require purchased credit. Configure `COINPAY_X402_KEY`
with `payments:create` permission and at least one business wallet; the scoped
key supplies the merchant identity. Free sessions and existing credit still work during a
checkout outage. A self-hosted operator explicitly sponsoring API usage may set
`NIXAMP_TRANSLATION_BILLING=off`.

Live Nixamp channels share **one recognition, translation, and voice pipeline
per source and target language** on the account server. Each listening account
uses its own free allowance or credit; joining adds no extra recognition or voice generation.
The pipeline persists while anyone remains and closes its source and pending
work when the last listener leaves. Disconnecting one viewer does not stop the
others. Two connections per account, four active source/language pipelines, and
1,000 connections per pipeline bound resource use. A slow or unfunded listener
is disconnected independently. Background sound stays local and independently
switchable. Public source addresses are resolved and pinned before fetching;
redirects and ffmpeg network/file fetches are disabled.

Live pipeline sharing currently runs within one account-server process (as
nixamp.com's deployment does). Multiple replicas need stream affinity before
scaling this path; the payment ledger already works across replicas. Files and
individually timed browser media retain local capture, because viewers can be
at different playback positions. Shared live streams use the same speaker voices
for everyone; individual playback retains voice overrides.


Use **Translate audio** beside the player's language menu to hear whatever
Nixamp is playing in your language. One click starts translation; it selects
your preferred supported language if the menu is still on Original. Turn it off
to restore the original audio. The video and the room's shared playback clock
keep running. **Captions** in the Transcript panel enables text-only recognition.
Ordinary file playback uploads no audio; enabling captions or translated audio
opts into processing short clips from the playing media.

Native captions use local Whisper Base through Transformers.js. Optional
speaker-aware audio uses ElevenLabs **Scribe v2** for native transcription with
speaker turns, local **OPUS-MT** for the selected translation, and ElevenLabs
**Flash v2.5** HTTP streaming for natural stock voices. The application sends
short audio clips and translated text to ElevenLabs only for this optional
feature. This uses the direct API; it does not need an MCP server or clone voices.
Supported translation pairs come from `/api/v1/translate`; voice languages are
also checked before enabling the audio toggle.

For translated audio, a rolling six-second window advances every two seconds.
Native Whisper captions retain their five-second input. Speaker labels are
reconciled using overlapping timestamps, with different voices assigned to
separate speakers. Voices are picked from the available stock catalogue without
inferring a person's gender from pitch; each detected speaker gets an unused
voice until the catalogue is exhausted. **Audio options** folds away optional
individual overrides. A speaker returning after leaving the rolling context may
receive a new label. Simultaneous speech and noisy crowds can still confuse
recognition. Native captions never translate to English as
an intermediate recognition step.

Recognition, text translation, and streaming voice playback run as separate
stages. Each stage has at most one active request per shared pipeline or individual playback session. Overlapping
recognition windows recover unprocessed words; unfinished phrases briefly stay
in context instead of translating every two-second fragment separately. The
voice player preserves pending speaker turns and fetches the next phrase with
up to three seconds of audio still queued. Speech queues and decoded audio are
bounded. Old transcript history
is never spoken. Pause, seek, source changes, and disabling the feature cancel
queued speech. Temporary connection and provider failures recover automatically
without restoring original speech. Stale phrases are discarded so playback can
catch up; three consecutive provider failures or an access/budget error end
the session with a visible message. Network reconnection is limited to five
attempts with backoff, reusing the active free session where available. This is a delayed live
interpreter, not a promise of exact lip sync or word-by-word streaming captions.

OpenStream currently compresses server-to-server relays, not this browser
translation path. Individual playback uploads bounded mono 16 kHz WAV clips. Shared live channels
are decoded on the account server and distribute the generated PCM over one
authenticated event stream per viewer. Ordinary media playback already uses its audio/video
codecs. The short-window overlap ratio and audio-second spending limits remain
unchanged; smaller windows do not increase the steady-state audio submitted.

Translated playback keeps an approximate version of the original background
sound. FastEnhancer Web's Base model estimates speech locally in a dedicated
browser worker. Every audible channel, including rear and side channels, enters
the speech estimate. A complementary spectral mask removes estimated voice
frequencies independently from the left and right source channels, preserving
their stereo phase. One speech model serves both channels to leave processing
capacity for video playback. Background processing adds no API calls or provider
charges. It stops with translation; recognition starts without waiting for it.
Brief processing stalls drop stale frames and recover automatically, with
bounded work and at most about 130 ms of background delay. A model or device
failure silences that branch while translated speech continues. Separation of
mixed dialogue and background remains approximate. Disable **Keep background
sound** under **Audio options** when needed. This uses
[FastEnhancer Web](https://github.com/ryyr-ry/fastenhancer-web) and
[FFT.js](https://github.com/indutny/fft.js), under the MIT license.

**Background level**, in the same collapsed options, balances the separated
sound from 0–200% (100% by default), with a fixed +9.5 dB makeup gain after
separation. There is no automatic gain control, fade, or ducking triggered by
translated voices. It never mixes the original dialogue back
in as a fallback. Increasing it also amplifies any speech the model fails to
remove. This is an approximate local separator, not lossless dialogue removal.

Translated audio stays selected for the entire session, including the initial
wait, gaps between lines, buffering, seeking, and changes of speaker or target
language. With background sound off, gaps are silent; with it on, the separated
background continues. The original audio returns when translation is disabled
(including an announced provider failure), not whenever an utterance finishes.

The account server needs `ELEVENLABS_API_KEY`; `NIXAMP_DUBBING=off` disables
this feature. The key stays on the server. Sign-in is required for speaker
analysis, voice selection, and short-lived playback grants. Grants expire after
90 seconds, authorize at most 2,000 characters, and are scoped to one playback
session or channel. Provider requests also have account/IP throttles, concurrency
limits, and cached duplicate voice generation. Native speech and local
translation retain their existing account and queue limits.

Postgres stores atomic usage reservations and hashed grants, so the feature's
budgets survive restarts and are shared between replicas. Provider failures still consume the abuse budgets conservatively;
the separate paid balance refunds requests rejected before provider acceptance. The configurable daily limits are:

| Setting | Default | Counts |
| --- | ---: | --- |
| `NIXAMP_DUB_DAILY_CHARS` | 200,000 | New voice characters across this server |
| `NIXAMP_DUB_USER_DAILY_CHARS` | 120,000 | New voice characters per account |
| `NIXAMP_DUB_DAILY_AUDIO_SECONDS` | 86,400 | Scribe audio seconds across this server |
| `NIXAMP_DUB_USER_DAILY_AUDIO_SECONDS` | 43,200 | Scribe audio seconds per account |

Audio limits count overlapping context too: a continuous hour of speaker-aware
listening submits about three hours of Scribe audio. At the [published API
rates](https://elevenlabs.io/pricing/api) of $0.05 per 1,000 Flash characters and
$0.22 per Scribe audio hour, a listener producing 1,000 translated characters
per minute costs about $3.66/hour, before plan minimums or discounts. These default
server quotas limit this feature to about $15.28/day at those rates; they do not
cover other applications using the same provider key. Set a daily limit to zero
to block new use of that resource. Limits return 429 and never trigger an
unlimited fallback provider.

```
GET  /api/v1/speech/voices       authenticated stock voices and supported audio languages
POST /api/v1/speech/shared       paid {source: liveChannelUrl, language} -> shared captions and PCM events
GET  /api/v1/translation-passes  plans, balance and pending purchases
POST /api/v1/translation-passes/checkout  authenticated {plan, coin, requestKey} -> hosted checkout
GET  /api/v1/translation-passes/orders/:id  authenticated owner payment verification
POST /api/v1/speech/speakers     paid, bounded mono 16 kHz WAV -> native speaker turns
POST /api/v1/speech/grant        authenticated {channel: playbackScope} -> short-lived grant
POST /api/v1/speech/synthesize   scoped grant + {channel, text, language, voice, profile} -> streaming PCM
```

## Several streams at once

A channel is one publisher and everybody listening to them. Two or three devices
can be live at the same time -- a phone, a desktop, a second window -- each with
its own audience.

```
GET  /api/channels              what is live now
POST /api/channels/<id>         publish to one
GET  /api/channels/<id>         listen to one
GET  /api/channels/<id>/art     a picture of it, as JPEG
```

The picture is what a share link unfurls into on a chat or a timeline, and
what the lock screen shows while it plays. A pasted link's thumbnail is sent
on as it is; a podcast's sleeve is read out of the file; a moving picture
gets one frame of what the channel is sending, taken from the channel's own
backlog rather than by opening the source a second time. The page for a
share link (`/?url=...&play=channel:<id>`) carries it as `og:image` with a
Twitter card, on nixamp.com and on the server itself.

One ffmpeg decodes each publisher once and the result is written to every
listener on that channel. A decode per listener would cost a core each and, for
a live stream, would not even agree with itself about what "now" is.

A listener who joins halfway through gets the stream from that moment, which is
what live means. Two publishers on **one** channel is refused; on two channels it
is the whole point.

Publishing is administering the server, so it needs the control link or the
owner's account. Listening only needs the share link, like any other audio.

### Relaying a channel to another nixamp, compressed

A channel can be carried from one nixamp to another with fewer bytes on the
wire and every byte restored at the far end. It is off until you turn it on,
per channel, and nothing about ordinary playback changes when you do.

```
nixamp compression analyze --channel cnn          what a codec would make of it
nixamp compression set --channel cnn --mode auto  compress when it pays, store when it does not
nixamp compression status --channel cnn           what it is doing, in bytes
nixamp compression off                            the whole server, at once
```

On the receiving nixamp:

```
nixamp compression pull --channel cnn --from https://host:4321/api/channels/cnn/relay --from-key KEY
```

and `cnn` is a channel there, heard at `/api/channels/cnn` like any other.
The relay is `GET /api/channels/<id>/relay` as `application/vnd.nixamp.stream`,
a framed stream of Zstandard blocks each carrying the length and SHA-256 of
what it stands for, ending in a marker; a block that would not shrink is
sent as it is, and the metrics say so rather than claiming a saving. A
library file gets the same treatment at `/api/media/<n>/relay`, built once
and kept. `nixamp compression analyze FILE` measures a file here with no
server at all. The wire format, the policy, the limits and the switch are
in [docs/stream-compression.md](docs/stream-compression.md).

HLS can be packaged as fragmented MP4 instead of MPEG-TS
(`--hls fmp4` on `compression set`, or server-wide): the same boxes the
channel already carries, copied into files, never re-encoded.

## Streaming into it

A nixamp can be the thing you broadcast *to*, not just from.

```
nixamp serve ~/Music --rtmp-in 1935
```

Then point OBS, Larix, or another ffmpeg at the URL it prints. RTMP is what
every native broadcaster already speaks, so there is no nixamp-shaped client to
install. ffmpeg does the listening, so this costs no extra dependency.

A browser cannot speak RTMP at all, so the web app uses HTTP instead: one long
`POST /api/ingest` where the platform allows a streaming request body, and
`POST /api/ingest/chunk` where it does not. All three end up in the same place.

One publisher at a time. A second is refused rather than mixed.

## Broadcasting out

Out to as many places as you like, at once:

```
nixamp serve ~/Music --rtmp youtube=<key> --rtmp x=<key> --rtmp tiktok=<key>
```

`youtube`, `x`, `facebook`, `tiktok`, `twitch` and `kick` are known by name and
need only a key; anything else takes a full `rtmp://host/app/key`.

One ffmpeg, one encode, many outputs, through the `tee` muxer. An ffmpeg per
destination is the obvious shape and it encodes the same frames four times.
Every output carries `onfail=ignore`, so one destination with an expired key
cannot take the others down with it.

The encoder settings come from PairUX, which learned them against the real
platforms: a one-second keyframe interval because YouTube stalls on ffmpeg's
default, a forced constant frame rate because a variable-rate source makes
YouTube report a stream falling behind, and `yuv420p` because that is what RTMP
platforms accept. Music has no picture, so a flat colour is generated: RTMP
wants a video track either way.

Stream keys are read from the command line or the environment and never from a
request. `/api/broadcast/destinations` shows names and URLs with the keys
redacted.

## Paying to listen

A stream serving a handful of friends costs nothing and asks nothing. Past five
people listening at once it is bandwidth somebody is paying for, so the gate
opens: the sixth listener gets a 402 with an
[x402](https://github.com/profullstack/x402-gateway) offer, and a dollar buys a
day.

```
NIXAMP_PAY_TO=0xYourAddress COINPAY_X402_KEY=cp_live_… nixamp serve ~/Music --x402
```

Three things are deliberate. The count is of *live* listeners, so a stream
quietens back to free on its own. Only the audio is gated: a 402 on `/api/state`
would break the page that has to render the offer. And nobody is cut off
mid-track, because the gate is asked once, when a request arrives.

`NIXAMP_PRICE_CENTS` and `NIXAMP_PASS_MINUTES` change the terms; the defaults are
100 and 1440, which is the dollar and the day. A server that has agreed to be in
the directory can also be switched on and off from nixamp.com: the configuration
rides back on the heartbeat it is already sending.

## Leaving it running

`nixamp serve` holds a terminal. `nixamp daemon` does not.

```
nixamp daemon start ~/Music --open-port
nixamp daemon status
nixamp daemon stop
```

Start writes down where it went and the key it minted, waits until the server
is actually answering before saying it started, and prints the share link. It is
one daemon per user, and the state lives in `$XDG_STATE_HOME/nixamp`.

### Somewhere the rest of the world can reach

The addresses nixamp prints are the ones its own interfaces have, so a machine
behind NAT only ever sees `192.168.x` -- no use to anybody else, and nothing it
can publish. Tell it the address it answers on from outside:

```
nixamp serve ~/Music --public-url https://nixamp.example.com   # or NIXAMP_PUBLIC_URL
```

That address is what the share links print and what the directory listing
carries. Getting one is your business, not nixamp's: a forwarded port, a reverse
proxy, or a tunnel, e.g.

```
cloudflared tunnel --url http://localhost:8420
```

Without it, `--publish` is skipped entirely rather than listing a stream nobody
outside the house can open.

### Detaching, and coming back

`d` in the player hands the music to a daemon and gives you your terminal back.
Nothing stops. `nixamp attach` puts the player back in front of it:

```
nixamp attach                      # the daemon on this machine
nixamp attach --url URL --key KEY  # a nixamp somewhere else
```

An attached player is the same view and the same keys; the difference is that
the keys are sent to the daemon and what you see is what the daemon is doing.
Any number of terminals may attach at once. `q` or `d` leaves without stopping
anything, which is what `nixamp daemon stop` is for.

## Who may administer a server

Two ways to be allowed, and they answer different questions.

**You hold its control link.** That is possession: you are at the machine, or
somebody at it sent you the link. It works with no account and no network.

**You own it.** `nixamp login` and then `nixamp serve` claims the server for the
account signed in on that machine, and from then on that account can administer
it from a phone anywhere, by signing in to nixamp.com in the browser.

The server cannot check a nixamp.com token itself, and should not: it holds no
part of that secret. It asks nixamp.com who the token belongs to and compares
the answer to the owner it recorded at startup. Delegating identity while
keeping authorisation local is what lets a nixamp on a laptop trust an account
it has never seen.

Answers are remembered for a minute, so admin requests do not each cost a round
trip, and a revoked session stops working in about a minute rather than at the
next restart. If nixamp.com cannot be reached, nobody becomes the owner — the
control link is the way in until it can.

Listening is never affected: `/api/state`, `/api/stream` and the page itself
stay open to whoever has the share link.

## Watching it

```
nixamp admin
```

Who is connected, from where, to what, for how long and how much has gone out.
It reads the daemon's own state file, so it needs no arguments; point it
anywhere else with `--url` and `--key`.

```
╭─ Server ─────────────────────────╮ ╭─ Now playing ────────────────────╮
│ http://127.0.0.1:4321            │ │ long.flac                        │
│ /home/anthony/Music              │ │ —                                │
│ Uptime                        3s │ │ State                    stopped │
│ Tracks                         1 │ │ Position                      0s │
│ Listeners                      2 │ │                                  │
╰──────────────────────────────────╯ ╰──────────────────────────────────╯
╭─ Connections (2 live) ────────────────────────────────────────────────╮
│ Where        Network   Kind    Client    Track          For      Sent │
│ 10.0.0.42    private   media   VLC 3     long.flac       3s   2.6 MiB │
│ 100.65.1.7   tailscale stream  Safari 17 long.flac      41s    18 MiB │
╰───────────────────────────────────────────────────────────────────────╯
```

Press `a` to add: hand the running server a folder, an album URL or a file and
it joins the playlist under its own heading, with the library still there and
the listeners still connected. Press `r` to replace instead, which is the
bigger thing — this server now serves that, and the library it had is gone
until you restart it.

An added block can be taken back out from the playlist itself: its heading
carries an `×`.

## The noise it makes

nixamp plays a jingle when it starts, once per session, the way Winamp did.
Any mp3 in your home directory with `nixamp` in its name is used instead of the
ones that ship, and with more than one it picks at random -- a rotation you can
predict is one you stop hearing. `--no-jingle`, or `NIXAMP_NO_JINGLE=1`, turns
it off.

On the web it plays on a fresh page if the browser allows it, and otherwise on
your first click -- browsers spent a decade learning to refuse pages that make
noise unasked, and this one does not argue with them.

## How it works

One decode feeds both your speakers and the display. `ffmpeg` writes raw 32-bit float samples to a pipe; nixamp reads every sample on its way past, runs an FFT over it, and hands the same bytes to `ffplay`.

Running a second decoder just for the visualiser would be simpler and wrong: the two would drift apart within seconds and the bars would stop matching what you hear.

The analyser is a radix-2 Cooley-Tukey FFT with a Hann window, about 120 lines and no dependency. Bands are spaced logarithmically because hearing is, and they are scaled in decibels for the same reason — linear bins put almost every bar above 10 kHz where there is nothing to see. Bars rise instantly and fall gradually, with a peak marker that sinks. That decay is what made Winamp's analyser readable rather than merely busy.

Braille gives four vertical pixels per character cell, so a bar moves smoothly instead of stepping through eight block glyphs.

## Three ways to run it

The terminal player is the original and still the point, but the same engine
now drives two more surfaces.

### Server mode, and the browser remote

```
nixamp serve ~/Music --host 0.0.0.0
```

nixamp keeps playing through your speakers and hands out a remote: open the
address it prints on your phone and you get the playlist, the transport and the
same spectrum, pushed as it happens. State goes out over Server-Sent Events
rather than a WebSocket, because SSE is plain HTTP — no dependency, and it
reconnects by itself when the phone goes to sleep.

Tick **Listen on this device** and the browser streams the track's bytes and
plays it there instead, with its own analyser drawing the same picture.

`--host 127.0.0.1` is the default, so nothing is reachable until you say so.
Track paths never leave the machine; the remote sees titles.

| Endpoint | Does |
|---|---|
| `GET /api/state` | one snapshot |
| `GET /api/events` | snapshots, pushed |
| `POST /api/command` | `play` `toggle` `stop` `next` `prev` `select` |
| `GET /api/media/:n` | the track's bytes, with ranges (`--no-media` turns it off) |

### The PWA — [nixamp.com](https://nixamp.com)

```
bun run web:dev      # or: bun run web:build && bun run serve
```

A player in the browser, installable, and the remote client above. It opens
your own files — nothing is uploaded; the browser decodes them where they are —
and it plays video as well as audio. Vanilla TypeScript and Vite, one 16 kB
bundle, and a service worker that precaches the shell so the app opens with no
network at all.

The icons are drawn from source (`web/scripts/icons.ts`) rather than committed
as opaque binaries, which is how the 192 and the 512 stay in step.

### The desktop app

```
bun run desktop:dev
bun run desktop:build      # AppImage + deb into desktop/release
```

Electron around the same PWA, with a real `nixamp serve` running as a child
process — so the window is the browser player, the terminal player's engine and
the remote-control server at once.

The CLI travels inside the bundle and is run by Electron's own Node, which is
the point: installing the app installs a working nixamp with no system Node
anywhere near it. **Copy Bundled CLI Path** in the menu tells you how to call
it.

Building is unsigned on purpose — no code signing, no notarisation.

## Requirements

**ffmpeg** and **ffprobe** to decode, **ffplay** to make sound. All three ship together.

```
sudo apt install ffmpeg      # or: brew install ffmpeg
```

Without `ffplay`, nixamp still runs and still draws the spectrum — it just says so rather than pretending to play.

A bare `ffmpeg` on `PATH` is used when there is one; `mise` shims are detected and invoked through `mise exec`, because the shim itself fails when no version is pinned.

## Keys

| Key | Does |
|---|---|
| `Space` | Play or stop |
| `Enter` | Play the selected track from the start |
| `↑` `↓` | Move through the playlist |
| `n` `p` (or `→` `←`) | Next and previous track |
| `s` | Stop |
| `d` | Detach: hand the music to a daemon and keep the terminal |
| `q` | Quit |

## Formats

Whatever your ffmpeg was built with: mp3, flac, ogg, opus, m4a, aac, wav, wma, aiff, alac, and the audio track of mp4 and webm.

Video too, including raw transport streams — a `.ts`, `.m2ts` or `.mts` off a
capture card, a receiver or an IPTV recorder, at 1080p or 4K. H.264 is copied
into the fragmented MP4 a browser is sent, at whatever size it already is, so
a 4K recording costs no encoding to watch or to put on the air. H.265 is
copied too when the browser asking for it says it can decode one, and
otherwise re-encoded down to 1080p, because a 4K encode does not keep up with
playing it. A channel, which has one encode and a whole audience, re-encodes
H.265 by default; `NIXAMP_HEVC_CHANNELS=1` copies it through instead, for an
audience of phones and televisions.

A `.ts` is opened rather than taken on its name: it is as often a TypeScript
file as a transport stream, and a checkout is not a playlist.

## Status

Early. It plays a directory, shows tags and timings, and draws what it hears —
in a terminal, in a browser and in a window, from one engine. The browser
player seeks and has a volume slider; the terminal one still does not. Not yet,
anywhere: shuffle, repeat, m3u playlists, or the visualiser presets that would
make the name honest.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. Like [r3q](https://github.com/profullstack/r3q) and [g1tz](https://github.com/profullstack/g1tz), nixamp exists partly to keep hqtui honest: a real application finds the gaps a widget gallery does not.

## Licence

MIT

### Accessibility and interaction

Keyboard access, named controls, headings, skip links, visible focus, descriptive
slider values, reduced motion, and concise screen-reader status announcements
are built into the web player. Incoming transcripts, chat, and playback updates
preserve scrolling, focus, caret, and the browsing page. The
[UX and accessibility baseline](docs/ux.md) applies to all interface changes.

When an older broadcaster still provides unversioned English-first captions,
a signed-in listener uses native-language recognition of the playing audio
instead of that stale transcript cache. Update the broadcaster for shared native
captions; translated audio uses the listener's current audio and selected language.

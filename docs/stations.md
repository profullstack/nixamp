# Stations

A station is a collection on this server turned into one continuous program that
listeners join where it is. It is the PRD's RAD-01..05 ([prd-library-radio.md](prd-library-radio.md)).

- **Identity.** A random 10-character id that never changes. The channel that carries it
  (`station-<id>`) is only how it is delivered now; a rename, a restart or a dead renderer
  keeps the id and every link.
- **Defaults.** New stations are `private`, `stopped` and not listed. Starting does not publish.
- **Desired vs observed.** `desired` (`running`/`stopped`) is written to
  `$XDG_STATE_HOME/nixamp/stations-<port>.json`; `state` (`stopped`, `starting`, `live`,
  `recovering`, `offline`) is what is happening now. A station its owner stopped stays stopped
  after a restart; one left running comes back.
- **Rotation.** In order or station-wide shuffle (one order for everyone, redrawn each pass),
  repeating or once. Edits land on the next track. A file that will not play is passed over;
  after 3 failures it is left out until `retry`. A list where nothing plays goes offline once,
  not in a loop.
- **Recovery.** An unexpected end restarts after 2, 4, 8, 16, 32, 60 s, then every 5 minutes
  while still wanted, so a source that comes back brings the station back under the same link.
- **Skip** moves to the entry after the one listeners hear (the decoder reads ahead, so ending
  the entry being decoded would skip the wrong song). Audio listeners stay connected.
- **Now playing** on the page follows `/events`, and each new title waits for the sound the
  player has buffered, so it changes when the song does.
- **Audio.** MP3, 128 kbps by default (`bitrate`: 64-320), 48 kHz stereo; one encoder per
  station whatever the number of listeners.

## Auto stations (a station per genre)

`nixamp station auto` (or `POST /api/v1/stations/auto`, MCP `station_auto`) makes a station for
every genre the library has and keeps them in step: the setting is saved in `config.json`, and
after every library scan the stations are re-synced (new files join, ids and links never change).

- **Radio** from the music's genre tags, folded into genres a listener knows (Punk, Rock, Metal,
  Hip-Hop, Pop, Alternative, Industrial, Electronic, Reggae, Jazz, Blues, Classical, Country &
  Folk, Soul & R&B, Latin). A tag can put a file in several ("Pop, Rock, Metal"). Lectures,
  interviews, podcasts and talk are left out. `--min` files per station (10).
- **TV** from the genres nichedb knows for each film (40 minutes or longer), at most two genres a
  film; `--films` per station (3). A TV station re-encodes video, about a core while it runs, so
  only `--tv` (2) run; the rest are made and wait, stopped.
- Shuffled, repeating, **unlisted**: a link for whoever you give it to. Nothing is declared or
  published on your behalf.
- **Breaks** every `--breaks` seconds (600), between songs or films and never inside one: the ad
  network's spot (this server's `AD_SLOT`, else nixamp.com's), else a house spot you put at
  `$XDG_STATE_HOME/nixamp/ads/spot.mp4` (TV) or `spot.mp3` (radio), else no break.
  `breaksEvery` can be set on any station (120-86400, 0 for none).

## The guide

`/guide` (and `/` on a host listed in `NIXAMP_GUIDE_HOSTS`, such as a Moshpit name) is a public
page of the stations on this server that are **public and listed**, radio and TV, with what is on.
`GET /api/v1/stations/guide` is the same list as JSON. No key is needed; nothing private or
unlisted ever appears.

## Limits and metering

Every byte a station's link delivers and every second somebody listens is counted per station
per calendar month in `$XDG_STATE_HOME/nixamp/usage-<port>.json`, with peak listeners, restarts
and files that would not play. `GET /api/v1/stations/:id/metrics` (owner) answers this month,
the history and the limits; the owner view carries `metrics` and `alerts` (off the air while
wanted, files left out, repeated restarts, allowance nearly or fully used), and so does `/radio`.

The operator sets the limits:

| | default | refusal |
| --- | --- | --- |
| `NIXAMP_STATION_MAX_LISTENERS` | 200 per station | `503 station_full`, `Retry-After: 60` |
| `NIXAMP_MAX_LISTENERS` | 500 across stations | `503 server_full`, so one station cannot take the server |
| `NIXAMP_MAX_RUNNING_STATIONS` | 10 | `409 too_many_running` on start |
| `NIXAMP_STATION_MONTHLY_GB` | 0 (no allowance) | `429 allowance_exhausted` until the month turns; nobody already listening is cut off |

Changes (anything but GET under `/api/v1/stations`) are limited to 30 a minute per caller
(`429 rate_limited`), apart from listening, so neither can starve the other.

## Who may do what

| Caller | May |
| --- | --- |
| Control key, or the owner's nixamp.com session | everything below |
| A station's link (`?t=` token) | `GET /stream`, `/state`, `/listen.m3u` of that station, when it is unlisted or public |
| The server's listen key | nothing under `/api/v1/stations`; station channels are hidden from `/api/channels` |

`private` needs the owner. `unlisted` works for anyone with the link. `public` is unlisted plus
the option of a directory listing (`listed`), and needs a declared rights basis first:
`owned`, `permission`, `licensed` or `public-domain`, with an optional note. The declaration is
recorded with who made it and when; it is not legal clearance.

Going `private` mints a new token: every link handed out before stops working and connected
listeners are disconnected at once. `rotate-link` does the same without changing visibility.

## HTTP

Owner (control key as `?k=` or the `x-nixamp-key` header, or an owner session):

| | |
| --- | --- |
| `GET /api/v1/stations?limit=&offset=` | list |
| `POST /api/v1/stations` | create: `{name, folder \| items: [trackIndex], description?, shuffle?, repeat?, bitrate?}`; `Idempotency-Key` header makes a retry return the same station |
| `GET/PATCH/DELETE /api/v1/stations/:id` | read, edit (same fields), delete (files are never touched) |
| `POST /api/v1/stations/:id/start` `/stop` `/skip` `/retry` `/rotate-link` | |
| `POST /api/v1/stations/:id/access` | `{visibility?, listed?, rights?: {basis, note?}}` |

Listener (`?t=TOKEN`): `GET /api/v1/stations/:id/stream`, `/state`, `/listen.m3u`, `/events` (server-sent
`hello`, `now` when the station's encoder moves to the next file, `state`; closed when the link is
revoked), and the page
`/station/:id?t=TOKEN`. A wrong token and a missing station are the same 404.

Errors are `{error, code}` with stable codes: `name_required`, `empty_station`, `items_required`,
`unknown_items`, `empty_folder`, `invalid_folder`, `invalid_bitrate`, `invalid_visibility`,
`invalid_rights_basis`, `rights_required` (409), `nothing_playable` (409), `not_live` (409),
`not_found` (404), `forbidden` (403), `bad_json`.

## CLI

    nixamp station create --name "Late Night" --folder "Albums/Late Night"
    nixamp station start ID
    nixamp station status ID --json
    nixamp station publish ID --basis owned --note "our own recordings"
    nixamp station publish ID --unlisted          # a link, no directory, no basis needed
    nixamp station unpublish ID --private         # links stop working, listeners dropped
    nixamp station stop ID

Exit codes: 0 done, 1 refused by the server (code printed), 2 usage, 3 unreachable.

## MCP

`nixamp mcp` offers `station_list`, `station_get`, `station_create`, `station_update`,
`station_control` (start, stop, skip, retry), `station_publish` and `station_unpublish`. Without
`server` they use this machine's daemon and its control key; with `server` they send this
machine's nixamp.com session, which that server accepts only from its owner. `station_publish`
with `visibility: "public"` needs `basis`, as everywhere else.

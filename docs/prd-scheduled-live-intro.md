# PRD: scheduled lives, and an intro that plays until the show starts

Status: draft, 2026-09-22. Owner: chovy. Target: nixamp 0.29.x.

## The problem

A live on nixamp starts the moment somebody pastes a link or an RTMP
publisher turns up. There is no way to say "this goes live at seven" and hand
people a room code, a share link or a `/live/<slug>` page before then. The
nixamp.com side already knows how to hold a `scheduled` live event with
`startsAt`, `doorsOpenAt` and a timezone (`src/live-events.ts`), but no
server channel exists for it, so a scheduled event has no picture: the room
code does not resolve, the directory lists nothing, and a follower who arrives
early sees a blank panel or nothing at all.

The end of a show already has an answer. Since 0.23.7 a show that finishes
cleanly plays a server-drawn "THIS LIVE STREAM HAS ENDED" clip, looped for an
hour, with `ended` on the listing and an ENDED chip on the page. The start of
a show should have the same answer, in the same shape.

## What ships

1. **A schedule on a channel.** A channel can be created with a start time.
   From that moment it is on the air, listed, joinable, with its room code,
   share link, chat, follows and `/live/<slug>` page all working.
2. **An intro clip.** Until the show starts the channel plays `intro.mp4`, a
   drawn "THIS LIVE STREAM STARTS SOON" plate, looped, made the way
   `outro.mp4` is made: once per server, by `src/outro.ts`, encoded exactly as
   the channel is sent on the wire. Sound-only channels get `intro.mp3`.
3. **The hand-off.** At the start time the channel dials its real source and
   everybody listening is carried across. For an RTMP slot the hand-off is the
   publisher's first bytes, whenever they come. The owner can start early with
   one click.
4. **The words.** `startsAt` travels on the channel's info, the on-air rows,
   the directory listing and the nixamp.com live event. The page and the TUI
   show a STARTS IN chip and one Log line. The directory gets a "Coming up"
   section beside the lives and the recently ended.

## Non-goals

- Recurring schedules. `live-events.ts` has a `recurringNext` seam; this PRD
  does not use it.
- A countdown burned into the video. The clip is one static plate per server,
  like the outro. The time is text on the page, in the viewer's own zone. A
  per-event drawn plate with the time on it is a possible follow-up, not v1.
- Reminders to followers ahead of time. The existing "went live" notification
  fires at the real start (step 3), not when the intro starts. A "goes live at"
  notice is a follow-up.
- Scheduling on the hosted nixamp.com decoder. nixamp.com has no ffmpeg
  (`Tools.carries`), so a schedule needs a server that can carry the link,
  exactly as going live does today.

## Design

### The intro clip (`src/outro.ts`)

`drawOutro()` becomes `drawPlate(line)` with two callers: the outro line and
the intro line "THIS LIVE STREAM STARTS SOON", both with the mark, the bars and
the `nixamp.com` line underneath. The `Outro` class grows a `kind` argument
(`"intro" | "outro"`) and writes `intro-v1.mp4` / `intro-v1.mp3` beside
`outro-v1.*` under `~/.local/state/nixamp/outro/`, gated by its own
`INTRO_VERSION`. Same ffmpeg recipe: h264+aac, `-g 30`, five seconds,
`anullsrc` for video; the two-note chime for the mp3. The clip is drawn on
first use and a stale or missing one is drawn again. In prose and in the UI it
is "the intro" and `intro.mp4`; the versioned name is a disk detail, as it is
for the outro.

### The channel (`src/channels.ts`)

New fields on `ChannelInfo`:

- `startsAt?: number` wall clock, epoch ms. Present while the channel is
  waiting for its show. Deleted when the show starts, the way `ended` is
  deleted by `restart()`.
- `waiting?: true` while the intro is on the air. Mirrors `outroOn`.

A channel created with `startsAt` in the future does not dial its source. It
calls `beginWait()`: sets `waiting`, dials the intro clip with `-stream_loop
-1` through `OUTRO_ENCODE[kind]` (the same fixed copy encode the outro uses,
never the `through` tee, since a pipe cannot loop), and arms a timer for
`startsAt`. `dialed` holds the real source's args from the start, the way the
outro branch of `restart()` relies on it.

`begin()` is the hand-off, the outro branch of `restart()` in reverse: clear
the timer, kill the intro child, `startOver()`, delete `startsAt` and
`waiting`, dial the saved source at position 0. It is called by:

- the timer, at `startsAt`;
- `rtmp-in.ts` when a publisher's first bytes arrive on a slot whose channel
  is waiting (today it calls `attach`; a waiting channel is attached already,
  so it calls `begin()` instead);
- the owner, over `POST /api/channels/<id>/begin` (control key) and the page's
  "Go live now" button.

`startOver()` already ends every listener so they come back to the stream as
it now is; the page rejoins on its own, as it does after Start over from the
outro. Nobody clicks anything to cross from the intro to the show.

When the clock passes `startsAt` and nothing has started (an RTMP slot with no
publisher), the intro keeps playing for `INTRO_LATE_MS` (one hour, matching
`OUTRO_MS`), then the channel closes with one Log line saying the show never
started. An unreachable source at start time is handled by the existing redial
path, with the intro left up until a dial succeeds.

`RememberedChannel` gains `startsAt`, so a server restart re-arms a waiting
channel rather than dialling its source early. A remembered `startsAt` in the
past is treated as "start now".

### Surfaces (one vocabulary: page, API, CLI, MCP)

- **API.** `POST /api/links/play` and `POST /api/live/start` accept
  `startsAt` (ISO 8601 string or epoch ms; anything not in the future is
  rejected with 400 and a sentence). `POST /api/channels/<id>/begin` starts
  the show now. On-air rows from `/api/state`, `/api/live` and `/api/channels`
  carry `startsAt` and `waiting`.
- **Page.** The Go live form gets a "Start at" `datetime-local` input, empty
  by default. A waiting channel shows a STARTS IN chip with the time formatted
  in the viewer's zone, one Log line ("<name> starts at 19:00. What is playing
  is its intro."), and, for the owner, a "Go live now" button. The TUI shows
  the same chip.
- **Directory (`src/directory.ts`).** `Listing` and `Announcement` carry
  `startsAt`; the directory page lists waiting channels under "Coming up",
  soonest first, with the room code and a Join that plays the intro. A
  waiting channel counts as on the air for TTL and heartbeats.
- **nixamp.com live events.** A server announcing a `startsAt` creates or
  updates its live event as `scheduled` with that `startsAt`; `begin()` moves
  it `scheduled -> live` through the existing `transition()`. The
  `/live/<slug>` page renders for a scheduled event with the time and the
  intro playing.
- **MCP.** `watch_party_host` accepts `startsAt`; `watch_party_get` returns
  it. No new tool.
- **CLI.** There is no go-live command in the CLI today (going live is the
  page and the API), so nothing is added. If one lands, it takes `--at`.

## Acceptance criteria

- Paste a link with a start time ten minutes out: the channel is listed at
  once with a room code, the page shows the intro looping with a STARTS IN
  chip, and at the time the link plays from the top with no click from a
  listener already watching.
- The same with an RTMP slot: the intro plays until the publisher connects,
  then the publisher's picture replaces it. A publisher who connects before
  the time starts the show early.
- "Go live now" on the page starts the show at once.
- The directory shows the channel under "Coming up" with the time, and
  nixamp.com's live event reads `scheduled`, then `live`.
- Restart the server while a channel is waiting: it comes back waiting, with
  the intro, and starts at the right time.
- No ffmpeg on the box: the API answers as it does for going live today.
- A sound-only source plays `intro.mp3` and its page shows the chip.

## Tests

- `channels.test.ts`: the fake ffmpeg that sleeps when its args contain
  `stream_loop` (from the outro tests) plus a fake clock. Cover: waiting
  channel dials the intro not the source; timer fires `begin()`; `begin()`
  from RTMP first bytes; `begin()` by owner; late start closes after
  `INTRO_LATE_MS`; remembered `startsAt` re-arms; past `startsAt` starts now.
- `outro.test.ts`: both plates draw, both kinds encode, `INTRO_VERSION` bump
  redraws only the intro.
- `directory.test.ts`: `startsAt` round-trips through announce and listing,
  "Coming up" sorts soonest first.
- `live-events.test.ts`: announce with `startsAt` yields `scheduled`; begin
  yields `live`.
- Web: a page test that a waiting row renders the chip and the owner button.

## Rollout

Ship as one release with a tag, release, `nixamp update` on server1 and
server2, then verify on server1 with the same `POST /api/links/play` used to
verify the outro, with `startsAt` two minutes out. Then promote through myna
(socials, blog, ads); this is a major feature.

## Open questions

- Should `doorsOpenAt` mean anything on the server, or is the intro on the air
  from the moment the schedule is made? v1 assumes the latter.
- Should the recently-ended list and the coming-up list share one "not live
  right now" section on the directory page, or stay two?

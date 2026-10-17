/** `nixamp station` usage, apart so `nixamp help station` does not load the client. */
export const USAGE = `nixamp station — make a collection into a station

  nixamp station list
  nixamp station create --name NAME (--folder PATH | --playlist ID | --items 0,1,2) [--shuffle] [--no-repeat] [--bitrate 128] [--breaks 600]
  nixamp station show ID
  nixamp station status ID
  nixamp station start ID
  nixamp station stop ID
  nixamp station skip ID
  nixamp station breaks ID SECONDS a spot between entries every SECONDS (120..86400; --off for none)
  nixamp station retry ID          try every left-out file again
  nixamp station publish ID --basis owned|permission|licensed|public-domain [--note TEXT] [--unlisted] [--no-list]
  nixamp station unpublish ID [--private]
  nixamp station link ID [--rotate]
  nixamp station delete ID
  nixamp station guide-host NAME [--remove]
                     NAME's front page is the public station guide (e.g. a Moshpit name)
  nixamp station guide-peer URL [--remove]
                     the guide also lists the public, listed stations of the server at URL
  nixamp station auto [--no-video] [--min 10] [--films 3] [--tv 2] [--breaks 600] [--no-start]
                     a station per genre, kept in step with the library (--off stops it)

  AI radio (music composed for a station, a few tracks a day):
  nixamp station ai                          what is composing, this month's seconds, the stations
  nixamp station ai create (--preset lofi|synthwave|ambient|chiptune|punk|jazz | --name NAME --style TEXT)
                     [--vocals] [--seconds 120] [--per-day 2] [--unlisted]   public on the guide unless --unlisted
  nixamp station ai generate KEY             compose one now
  nixamp station ai set KEY [--style TEXT] [--per-day N] [--seconds N] [--off|--on]
  nixamp station ai remove KEY [--files]
  nixamp station ai budget SECONDS           seconds of music a month across AI stations (0: no cap)
  nixamp station ai resume                   after the provider ran out of credit
  nixamp station ai key NAME                 ELEVENLABS_API_KEY | GEMINI_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY,
                                             NIXAMP_OPENAI_URL | NIXAMP_OPENAI_MODEL (an OpenAI-compatible stand-in), from stdin

  Listener shares (anybody shares an MP3 link or file from the guide; AI files and checks it):
  nixamp station shares                      the setting and what is waiting
  nixamp station shares on [--owner-moderation] [--unlisted] [--max-mb 60] [--per-hour 6]
  nixamp station shares off
  nixamp station shares list [--state held|approved|reported|rejected]
  nixamp station shares approve|reject|delete SHARE
  nixamp station shares trust ADDRESS [--remove]   believe this proxy's X-Forwarded-For

  Lyrics (shown on the station page from each file's own tag, else nichedb.dev; ours published back):
  nixamp station lyrics                      the key, what was published, which stations may publish
  nixamp station lyrics publish ID           publish a station's words now (public, listed, basis owned only)
  nixamp station lyrics key                  nichedb's key (NIXAMP_LYRICS_KEY), from stdin (--clear forgets it)

  Copyright holders (the now-playing card: who holds a track's copyright, and how to support them):
  nixamp station holder list
  nixamp station holder set NAME [--artist ARTIST]... [--station ID]... [--support https://...] [--label Subscribe] [--license TEXT]
  nixamp station holder remove ID

  --json        machine-readable output
  --url, --key  another server, as with \`nixamp admin\`

A new station is private and stopped. Starting it does not publish it.`;

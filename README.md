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

## The directory

[nixamp.com/directory](https://nixamp.com/directory) lists nixamps that agreed
to be listed. In the PWA, **Browse the directory** next to the address field
picks one without typing anything.

`nixamp serve` asks before listing you, and shows the exact link it would
publish:

```
  List this stream at https://nixamp.com/directory so anyone can find it?
  It publishes http://198.51.100.7:4321/s/Lk1EM_mP977e1VT — listen only,
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

## Several streams at once

A channel is one publisher and everybody listening to them. Two or three devices
can be live at the same time -- a phone, a desktop, a second window -- each with
its own audience.

```
GET  /api/channels              what is live now
POST /api/channels/<id>         publish to one
GET  /api/channels/<id>         listen to one
```

One ffmpeg decodes each publisher once and the result is written to every
listener on that channel. A decode per listener would cost a core each and, for
a live stream, would not even agree with itself about what "now" is.

A listener who joins halfway through gets the stream from that moment, which is
what live means. Two publishers on **one** channel is refused; on two channels it
is the whole point.

Publishing is administering the server, so it needs the control link or the
owner's account. Listening only needs the share link, like any other audio.

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

Press `r` to re-stream: hand the running server a different URL or path and the
listeners stay connected while what they are hearing changes under them.

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

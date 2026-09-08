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

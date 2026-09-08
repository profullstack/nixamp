# nixamp

It really whips the terminal's ass.

```
bunx nixamp ~/Music
bunx nixamp track.flac
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

## How it works

One decode feeds both your speakers and the display. `ffmpeg` writes raw 32-bit float samples to a pipe; nixamp reads every sample on its way past, runs an FFT over it, and hands the same bytes to `ffplay`.

Running a second decoder just for the visualiser would be simpler and wrong: the two would drift apart within seconds and the bars would stop matching what you hear.

The analyser is a radix-2 Cooley-Tukey FFT with a Hann window, about 120 lines and no dependency. Bands are spaced logarithmically because hearing is, and they are scaled in decibels for the same reason — linear bins put almost every bar above 10 kHz where there is nothing to see. Bars rise instantly and fall gradually, with a peak marker that sinks. That decay is what made Winamp's analyser readable rather than merely busy.

Braille gives four vertical pixels per character cell, so a bar moves smoothly instead of stepping through eight block glyphs.

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

Early. It plays a directory, shows tags and timings, and draws what it hears. Not yet: seeking, volume, shuffle, repeat, m3u playlists, or the visualiser presets that would make the name honest.

## Built with

[hqtui](https://hqtui.com) — the terminal UI library. Like [r3q](https://github.com/profullstack/r3q) and [g1tz](https://github.com/profullstack/g1tz), nixamp exists partly to keep hqtui honest: a real application finds the gaps a widget gallery does not.

## Licence

MIT

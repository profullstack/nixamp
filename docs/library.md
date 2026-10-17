# Library

The library as an index (LIB-01..03 in [prd-library-radio.md](prd-library-radio.md)), kept in
`$XDG_STATE_HOME/nixamp/library-<port>.json` beside the keys.

- **Sources** are folders on this machine. The folder a server is started on becomes its first
  source automatically. More can be added (`nixamp library add`, `POST /api/v1/library/sources`)
  inside the same approved roots as the library itself: not `/`, not the home directory, nothing
  above it, no hidden folder. Overlapping sources are refused. A symlink is followed only if it
  lands inside its source; a link back to a parent is not followed twice. Removing a source
  forgets its items and never touches a file.
- **Items** have a stable id (source + path inside it) and a state: `pending`, `ready`,
  `unsupported` (nothing to play in it), `failed` (ffprobe could not read it; the reason is kept)
  or `unavailable` (gone; kept with its corrections in case it comes back).
- **Tags**: title, artist, album, album artist, track, disc, genre, year, plus duration, codec,
  bitrate, sample rate, channels, cover art. Owner corrections are stored apart and survive
  rescans; an empty value clears one.
- **Incremental**: a rescan asks ffprobe only about files that are new or whose size or
  modification time changed. On start the player gets every known tag at once, then new tags
  two hundred at a time. Probing runs two files at a time with `-protocol_whitelist file,pipe,fd`.
- **Search**: every word must appear in title, artist, album artist, album, genre or the path
  inside the library; filters by artist, album, genre, folder, source, state; sorted by path,
  title, artist (then album, disc, track), album or recent. Measured p95 61 ms over 10,000 items.

## Who may do what

Reading (summary, sources without their paths, items, browse, an item's stream) is for whoever
passed the server's key: the owner, or someone given the listen link, which is how a library has
always been shared. Only the owner sees absolute paths, corrections and errors, and only the
owner changes anything. A station's link reaches none of it.

## HTTP

| | |
| --- | --- |
| `GET /api/v1/library` | counts by state, sources, last scans |
| `GET/POST /api/v1/library/sources` | list; add `{root}` (starts a scan) |
| `GET/PATCH/DELETE /api/v1/library/sources/:id` | `{enabled}`; delete forgets, `filesTouched: 0` |
| `POST /api/v1/library/sources/:id/scan` | `{force?}` → `202 {job}` |
| `GET /api/v1/library/jobs/:id` | a scan's progress |
| `GET /api/v1/library/items?q=&artist=&album=&genre=&folder=&source=&state=&sort=&limit=&offset=` | search |
| `GET/PATCH /api/v1/library/items/:id` | one item; correct tags |
| `GET /api/v1/library/items/:id/stream` | the file, with ranges, `cache-control: private` |
| `GET /api/v1/library/browse/{artists,albums,genres,folders}?q=` | grouped, with counts |

Errors are `{error, code}`: `forbidden_root`, `overlapping_source`, `not_a_folder`, `root_required`,
`source_disabled`, `invalid_field`, `invalid_value`, `not_ready`, `not_found`, `forbidden`, `bad_json`.

## CLI and MCP

    nixamp library status
    nixamp library add ~/Music/Vinyl rips
    nixamp library scan --wait
    nixamp library search late night --artist "Some Band"
    nixamp library fix ITEM --title "Correct Title" --year 1979

MCP: `library_status`, `library_search`, `library_browse`, `library_scan`, with the same
target rules as the station tools.

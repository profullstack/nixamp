# Library and Radio: Phase 0 capability map

Status: Phase 0 deliverable for [prd-library-radio.md](prd-library-radio.md), 2026-10-17.
Method: read the code at the pinned commits below; nothing here is inferred from
names or READMEs. Line numbers are against the pinned nixamp commit.

## Pinned baseline

| Thing | Value |
| --- | --- |
| nixamp `main` | `92576862b9d5` (2026-10-14), package 0.28.44 |
| media-streamer `master` | `de93056645b6` (2026-10-14), package 0.5.0 |
| nixamp.com | live; `/api/directory` lists 1 server (server1.chovy.nixamp.com, 5,716 tracks) |
| bittorrented.com | live on dev2 behind `SITE_OFFLINE = true` + `LEGAL_MODE = true` (invite-only, legal allowlist) |
| server1 | was 0.28.37, updated to 0.28.45 on 2026-10-17; 5,716 tracks; https on the manual `*.chovy.nixamp.com` cert |
| server2 | not checked |

## Deployment inventory

- **nixamp.com**: hosted nixamp with Postgres (accounts, tokens, OAuth server, directory,
  hash records). No ffmpeg there (`server.carries = false`), so it cannot be an origin.
- **Origins**: self-hosted `nixamp serve` / `nixamp daemon` boxes (server1, server2/vienna)
  with state in JSON under `$XDG_STATE_HOME/nixamp` (`config.json`, `keys.json` 0600,
  `channels.json`, `catalogs.json`, `media.json`). DNS + TLS for `*.chovy.nixamp.com` are manual.
- **Desktop**: Electron wraps the PWA around a child `nixamp serve` (`desktop/main.cjs`).
- **Relay**: NXS1 envelope at `GET /api/channels/:id/relay`, listen-key gated, off by default.
- **Media hosting**: the origin's own disk. There is no managed storage.

## Scorecard

| Area | Verified | Partial | Missing | Incompatible |
| --- | --- | --- | --- | --- |
| LIB-01..04 library | 2 | 7 | 7 | 0 |
| RAD-01..05 stations | 2 | 10 | 4 | 3 |
| Audio delivery + now playing | 5 | 2 | 2 | 0 |
| Auth + permissions | 4 | 2 | 0 | 0 |
| Directory + publication | 1 | 0 | 0 | 1 |
| Security (source safety) | 1 | 0 | 2 | 0 |
| BitTorrented handoff | 1 (OAuth bridge) | 1 | 7 | 1 (legal mode) |

In short, delivery is strong. One ffmpeg per channel fans out to every listener, slow
listeners are bounded, and the engine already does HLS and relay. Accounts, tokens,
OAuth 2.1 and device login exist. The library is weak: one folder per daemon, an
in-memory index, a full rescan on every start, and no playlists. There is no station
model, because a "station" today is a running channel. Publication is the main
conflict: the defaults run against the PRD's privacy model.

## Library

| Req | Status | Evidence | What the code does |
| --- | --- | --- | --- |
| LIB-01 source records (ID, owner, host) | Missing | `src/library.ts:23-56`, `src/server.ts:883-899` | One `library` path in `config.json`; runtime-added folders are only a `group` label on tracks |
| LIB-01 approved roots | Partial | `src/library.ts:66-79`, `src/server.ts:5632-5715` | `forbiddenLibrary` refuses `/`, `~`, above-home, hidden dirs at startup/CLI only; `POST /api/source` takes any path or URL |
| LIB-01 symlinks / traversal | Partial | `src/playlist.ts:304-323` | Walk uses `statSync` (follows symlinks out of root, no loop guard). Media is addressed by integer index, so no path injection over HTTP |
| LIB-01 disable / rescan / remove | Partial | `src/server.ts:5604-5627` | `/api/source/remove` drops a runtime group, never deletes files; no disable, no rescan; startup library cannot be removed |
| LIB-02 formats | Verified | `src/playlist.ts:17-30` | mp3, flac, ogg, oga, opus, m4a, aac, wav (+ video containers) |
| LIB-02 probe / decodability | Partial | `src/audio.ts:125-159` | Duration probed; probe failure falls back to filename and the track stays listed |
| LIB-02 tags | Partial | `src/audio.ts:138,460` | title/artist/album only; no track number or genre; cover detected as `attached_pic` |
| LIB-02 filename labels | Verified | `src/audio.ts:129` | Basename with extension |
| LIB-02 metadata corrections | Missing | none | |
| LIB-02 content hashes | Partial | `src/hash.ts`, `src/media-local.ts`, `src/media-index.ts` | sha256 only via `nixamp hash`/transcribe/captions (OpenFile `/hash/<sha>`); scan never hashes |
| LIB-02 incremental rescan | Missing | `src/server.ts:7266-7276` | Full walk + ffprobe of every file on every start; index in memory |
| LIB-03 item states | Missing | none | |
| LIB-03 bounded, pinned cache | Missing | none | Only relay-cache and enrich cache, unbounded |
| LIB-04 search / browse | Partial | `web/src/app.ts:1714-1766`, `src/protocol.ts:69` | Client-side substring filter and folder walk over the whole track list sent by the server |
| LIB-04 playlists CRUD | Missing | `src/catalogs.ts` | Read-only m3u catalogs only |
| LIB-04 per-user queue / resume | Missing | `src/server.ts:686-693`, `web/src/app.ts:513` | One global `PlayerEngine` index for everyone; browser queue is in-memory |

## Stations

| Req | Status | Evidence | What the code does |
| --- | --- | --- | --- |
| RAD-01 identity separate from process | Partial | `src/server.ts:4797,4831`, `src/channels.ts:1103` | Channel IDs are content hashes (`file-<sha1(path)>`, `folder-<sha1(paths)>`, `url-<sha1>`, `cat-<id>`); the ID *is* the running channel |
| RAD-01 stable URL across restart | Partial | `src/channels.ts:1380-1469`, `src/share.ts:64-98` | `channels.json` re-pulls under the same ID and keys persist per port; `--new-key` breaks every link; directory listing is keyed by URL incl. key |
| RAD-01 rename aliasing | Incompatible | `src/server.ts:5179`, `src/directory.ts:423-430` | Phone codes are keyed by channel *name*, so a rename gets a new code |
| RAD-02 private / unlisted / public | Partial | `src/share.ts:27,341-371` | Per *server* (listen key / control key), not per station |
| RAD-02 directory separate from start | Incompatible | `src/server.ts:7479`, `4477`, `4812` | Any daemon without a TTY publishes by default; channels are announced the moment they go live |
| RAD-02 grants / invitations | Partial | `src/server.ts:4888` | `invitationAllows` exists for live events only |
| RAD-02 revocation | Partial | `src/share.ts:60-62`, `src/owner.ts:41-43` | Only whole-server key rotation; owner session cache 60 s |
| RAD-03 ordered rotation | Verified | `src/playlist-input.ts:40-92` | Entries in order, outro after the last |
| RAD-03 shuffle / repeat | Missing | none | Channels never repeat |
| RAD-03 start / stop / skip | Partial | `src/server.ts:5187-5243` | stop/delete/restart; no per-channel skip |
| RAD-03 edit at next-track boundary | Missing | none | Playlist fixed at start |
| RAD-03 empty start rejected | Verified | `src/server.ts:4781-4792` | 400/404 |
| RAD-03 skip corrupt item | Incompatible | `src/playlist-input.ts:44-47,83`, `src/channels.ts:739-747` | A bad entry throws; channel redials the *same* entry and closes after 5 failures |
| RAD-03 exclude repeat failures | Missing | none | |
| RAD-04 desired vs observed | Incompatible | `src/channels.ts:1435-1453`, `src/server.ts:5201` | Only "what is on now" persisted; explicit stop deletes the row; a channel that dies on its own is not rewritten, so it can come back |
| RAD-05 bounded backoff | Partial | `src/channels.ts:154-156,766-769` | Fixed 2 s redial, give up after 5 |
| RAD-05 fallback | Partial | `src/channels.ts:581-605` | End-of-show outro only |
| RAD-05 offline state | Partial | `src/server.ts:4274` | `error`/`redials` fields; a closed channel just disappears |

## Audio delivery and now playing

| Req | Status | Evidence | What the code does |
| --- | --- | --- | --- |
| One timeline per station | Verified | `src/channels.ts:882-897` | One ffmpeg per channel, fan-out, 64 KB backlog for newcomers |
| No per-listener transcoder | Verified for channels | `src/server.ts:6032-6125` | The legacy `/api/live`, `/api/stream/N`, `/api/media/N` spawn ffmpeg per listener; stations must use channels |
| Continuous HTTP stream | Verified | `src/server.ts:5803-5822`, `1190` | `/api/channels/:id`, audio = MP3 192k (PRD baseline is 128k) |
| Icecast / ICY metadata | Missing | none | |
| M3U export | Missing | none | HLS `index.m3u8` only |
| HLS | Verified | `src/hls.ts:81-98` | On-demand copy into 2 s segments, key on every segment URL |
| Codec / bitrate reporting | Partial | `src/channels.ts:76-85` | Known internally, API reports `kind` only |
| Slow-listener backpressure | Verified | `src/channels.ts:190` | Listener dropped past 16 MB queued |
| Now-playing events | Partial | `src/server.ts:5554-5578` | SSE of the global engine at 12 fps; per-channel now playing only by polling `/api/streams`; `playlistAt` from ffmpeg `-progress` runs ahead of audible by backlog + client buffer |

## Auth and permissions

| Req | Status | Evidence | What the code does |
| --- | --- | --- | --- |
| Accounts | Verified | `src/accounts.ts` | `@profullstack/auth-system` on nixamp.com Postgres |
| Machine tokens | Verified | `src/tokens.ts` | Hashed, revocable `nxa_` tokens |
| CLI device login | Verified | `src/device.ts` | RFC 8628 |
| OAuth 2.1 server | Verified | `src/oauth-server.ts` | PKCE, rotating refresh; BitTorrented is a client |
| Listener / controller / owner | Partial | `src/owner.ts:116-164`, `src/server.ts:4167-4212` | Three tiers exist; any signed-in nixamp.com account is a "member" that may go live on any reachable server. **Bug**: `POST /api/folders/live` is in `needsMember` but not `needsAdmin`, so a listen key alone puts folders on air with no member cap (separate fix PR) |
| CSRF / CORS | Partial | `src/server.ts:1380-1388`, `src/share.ts:139-144` | `ACAO: *` without credentials; key cookie `SameSite=Lax; HttpOnly`, not `Secure`; session can ride `?session=` |

## Surfaces

- **CLI** (`src/main.ts:535-658`): `serve, daemon, admin, login, logout, whoami, library, hash,
  token(s), mcp, party, transcript, transcribe, translate, sync, update, ...`. There is no `station`
  or `library add/scan`, and no go-live command.
- **MCP** (`src/mcp.ts:53-233`): 17 tools (watch party, transcripts, hash, profile, trollbox).
  None cover library or stations.
- **HTTP API** (`src/server.ts`, one 7.6k-line hand-routed handler): `/api/state, /api/command,
  /api/source, /api/channels/*, /api/folders/live, /api/tracks/N/live, /api/catalogs/*,
  /api/links/*, /api/directory, /api/v1/auth/*, /api/v1/servers, /mcp`. Nothing is under
  `/api/v1/library` or `/api/v1/stations` yet.
- **Desktop**: exists and wraps `serve`. It has no "closing the window is not stopping the
  station" affordance.

## Limits, metering, billing

- Member caps: 3 go-live asks/min, 2 on air per member, 8 per server, `MAX_ON_DEMAND` 4
  (`src/server.ts:1045-1088`). Verified.
- Listener counts and per-connection bytes exist (`src/connections.ts`), but there is no time series and no
  listener-seconds. Partial.
- x402 via nixamp's own CoinPay business (`src/paywall.ts`): $1/day past 5 live listeners, off by
  default. There is no station or plan metering. Partial.

## Security (source safety)

| Req | Status | Evidence |
| --- | --- | --- |
| argv-only decoder spawn | Verified | `src/links.ts:246-271`, yt-dlp gets `--` |
| SSRF guard on link play / playlist fetch | Missing | `src/links.ts:164-217` accepts localhost and 169.254.x, and follows redirects; members can reach it |
| ffmpeg `protocol_whitelist` | Missing | not set anywhere (AC-24) |

## BitTorrented handoff (media-streamer @ de93056)

What exists:
- An OAuth 2.1 client to nixamp: `src/lib/nixamp/{config,oauth,accounts,signin,rooms}.ts`,
  scopes `profile email parties offline_access`, tokens in `bt_nixamp_accounts` (plaintext, TODO).
- The watch-party bridge (`POST {nixamp}/api/v1/watch-parties`, idempotent on `partyCode`).
- File identity: `bt_torrent_files.id` plus `bt_audio_metadata` tags, and `collections` /
  `collection_items` (whose FK points at the legacy `torrent_files` table while code joins
  `bt_torrent_files`).

Gaps against PRD section 10:
1. **Legal mode blocks it (decision needed).** `LEGAL_MODE = true` returns 410 on `/api/stream`,
   `/api/library` and `/api/watch-party` for non-admins, and the standing no-piracy rule
   applies. Broadcasting torrent audio needs an explicit product and legal decision before code.
2. No per-file completion or integrity state is persisted. Progress lives only in WebTorrent
   memory, so AC-12 cannot be met yet.
3. No scoped file access. The `?ct=` cast token is HMAC(userId, expiry), 6 h, opens all of
   the user's media and cannot be revoked. A per-file, per-audience, revocable grant is needed.
4. No `stations` OAuth scope, no handoff endpoint on either side, no idempotency key or version,
   no link table (like `bt_watch_party_rooms`) and no status callback.
5. Stations need verified local copies (requirement 5: independent of peer availability). Today
   the only durable copies are seedbox downloads.

## Conflicts that change existing behavior

These must be handled as migrations, never as silent default flips (PRD RAD-02):

1. **Auto-publish.** Daemons publish by default and channels announce on go-live. Fix: new
   stations default private + unlisted, and existing servers keep their current publish choice,
   recorded explicitly in `config.json` on first run of the new version.
2. **A listen link exposes the library.** `/api/state` (titles, folders, absolute `root`),
   `/api/media/N` full download, `/api/stream/N`, and `/api/streams` entry paths are all open to
   the listen key the directory hands out. Fix: per-station listen tokens that open only that
   station's stream, art and now-playing, with library endpoints behind the owner.
3. **Public filenames.** Directory `nowPlaying` falls back to the bare filename, alongside the
   library `tracks` count, and survives 24 h in "recent". Fix: public metadata allowlist.
4. ~~The control link leaves the machine.~~ Checked in P1a: it goes to nixamp.com so the owner
   can administer from the site, and `/api/directory` returns it only to the owning account
   (`src/server.ts:4048-4060`). By design; not a leak.
5. **Index-based IDs** (`/api/media/N`, `/api/tracks/N/live`) shift with the list. Stable
   LibraryItem IDs must be introduced alongside, without breaking existing links.
6. **Content-derived channel IDs.** Moving a file changes its channel. Stations get a random ID
   that maps to the current channel (PlaybackInstance).
7. **No migration framework.** About 19 modules run `CREATE TABLE IF NOT EXISTS`, and schema order is
   prod-only fragile (ADD COLUMN before its index). New hosted tables need ordered migrations.

## Revised estimate (one engineer, after Phase 0)

| Work package | Covers | Estimate |
| --- | --- | --- |
| P1a Access hardening | folders/live gate (done separately), per-station listen tokens, library behind owner, public metadata allowlist, control link stays local, SSRF guard + `protocol_whitelist` | 1.5 wk |
| P1b Station model | Station record + random ID, desired/observed state, explicit publish (+ migration keeping existing choices), visibility per station, rename aliases | 2 wk |
| P1c Rotation + recovery | shuffle/repeat, skip, next-track edits, skip-and-exclude bad entries, exponential backoff, offline state, fallback | 1.5 wk |
| P1d Library | Source records, root/symlink policy, persisted index + incremental rescan, item states, track/genre tags, server-side paginated search, playlists, per-user queue | 3 wk |
| P1e Delivery | 128k profile option, M3U export, codec/bitrate in API, per-station now-playing SSE aligned to audible output | 1 wk |
| P1f Surfaces | `/api/v1/library` + `/api/v1/stations`, `nixamp library` / `nixamp station` CLI with `--json`, MCP tools, web Library/Radio nav + creation flow, desktop origin indicator | 2.5 wk |
| P1g BitTorrented handoff | blocked on the legal-mode decision; then scope, grants, persisted completion + integrity, handoff endpoint, UI | 2-3 wk |
| P1h Observability + limits | listener-seconds, delivered bytes, alerts, per-station limits, operator dashboard | 1 wk |

That comes to roughly 13 weeks without the handoff and 15-16 weeks with it. Calendar time depends on how many agents
run in parallel. P1a should ship first because it fixes behavior that is live today.

## P1a status (0.29.0)

- Done: folders/live admin gate (0.28.45); absolute `root` hidden from listen-key requests
  (`/api/state`, `/api/events`); key cookie `Secure` over https; `-protocol_whitelist` on probe,
  folder/playlist stations, channel inputs and per-listener transcodes (local = file,pipe,fd;
  links = network only, never file); member link plays must resolve to public addresses at
  the link, each playlist redirect hop, and every resolved media URL; directory publication is
  a recorded choice in `config.json` (existing servers stay listed, new daemons are not listed
  until asked).
- Left for P1b (needs the station model): per-station listen tokens so a station link does not
  open the library; public now-playing allowlist; redirects followed inside yt-dlp/ffmpeg and
  DNS rebinding for member links.

## P1b/P1c status (0.30.0)

- Done: station model (`src/stations.ts`, `src/station-runner.ts`, `src/station-routes.ts`,
  [stations.md](stations.md)): random durable id, desired/observed state, private/unlisted/public
  with listing separate, rights basis before public, per-station listen token (opens stream,
  state, m3u only), revocation drops listeners, idempotent create, bounded recovery then
  5-minute offline retries; playlist engine (#249): repeat, station-wide shuffle, skip,
  next-track edits, pass over and exclude broken files; station channels kept out of
  `/api/channels`, `/api/streams`, `channels.json` and the directory lineup unless listed;
  public page `/station/:id`; `nixamp station` CLI with `--json` and exit codes.
- Covers RAD-01..05, AC-04/05/06/07/08/09/13/14/19/21/22 at the unit/integration level.
- Next: library sources + persisted index (P1d), MCP tools and web Library/Radio nav (P1f),
  per-station now-playing SSE aligned to audible output (P1e), BitTorrented handoff (P1g).

## P1d status (0.31.0)

- Done: persisted library index ([library.md](library.md)): sources with approved roots and a
  symlink policy, stable item ids, item states, fuller tags, owner corrections, incremental
  rescans (restart has its tags at once), paginated search and browse, item streaming, CLI and
  MCP. LIB-01, LIB-02, LIB-03 (states; the bounded cache arrives with managed storage) and the
  search half of LIB-04.
- Done in 0.32.0: playlists (per listener, revisioned) and the per-listener queue with resume
  across devices; stations from playlists. P1d complete at the API, CLI and MCP; the PWA's
  Library/Radio screens are P1f.

## P1f/P1e status (0.33.0)

- Done: `/radio` (also `/library`) console in the PWA, linked from the player header: stations
  (state, listeners, start/stop/skip, copy link, who-can-listen dialog with rights basis,
  retry left-out files, delete, new station from a folder or playlist), library (summary,
  search, browse, play in the page, select into playlists), playlists (play, reorder, remove,
  make a station), sources (add, rescan), resume where you left off. Verified end to end in
  headless Chrome against a real server, including phone width (no horizontal scroll).
- Done: station `/events` SSE and audible-aligned titles on the station page; skip now
  moves past what listeners hear and keeps them connected (found while testing: it skipped
  the read-ahead entry and hung up listeners).

## P1g status (nixamp 0.34.0)

- Done on the Nixamp side ([handoff.md](handoff.md)): `stations` OAuth scope; OAuth tokens
  can no longer act as a server's owner without it, and can no longer read servers' control
  keys from `/api/v1/servers` (both were possible before); the handoff endpoint with
  idempotency, per-file grants, copies with size + SHA-256, expiry, retry, private draft.
- BitTorrented side: grant route, scope, handoff call and UI (media-streamer PR).

## P1h status (0.35.0)

- Done: per-station monthly metering (bytes, listener-seconds, peak, restarts, failures),
  operator limits per station / server / running stations / monthly allowance with actionable
  refusals, control rate limit apart from listening, metrics endpoint, alerts in the owner view
  and the console. Phase 1 is complete at the code level; Phase 2 (the seven-day pilot and
  five outside creators) is operational and needs real people.

## Phase 0 items still open

- [x] One external listener: dev2 pulled 12 s of server1 `/api/live` over https with the listen key
      (H.264 + AAC 156 kbps, 2.2 MB) on 2026-10-17. Still to do: the same for an audio-only folder
      station on `/api/channels/:id`, in a browser.
- [ ] **Restart hazard (found 2026-10-17):** nixamp.com's Porkbun key is invalid, so machine naming
      fails and delays `serve` past the 15 s `daemon start` wait (`src/daemon.ts:257`). The daemon is
      killed and, without naming, the stored cert is never loaded (plain http). server1 now runs with
      explicit `--tls-cert/--tls-key/--public-url`. Fix the key, and make `daemon start` wait for
      naming or start listening first.
- [ ] Decide on the BitTorrented handoff under legal mode (owner: Anthony).
- [ ] Confirm the reference test host for section 16 targets.

# Stream compression: the relay envelope and how nixamp uses it

This is the wire specification for `application/vnd.nixamp.stream`, the
representation one nixamp sends another when it relays a channel or a
library file losslessly compressed. It also says how the server decides
what to compress, what the operator can set, and how to turn it all off.

Nothing here changes ordinary playback. A browser, a phone, a TV or a CLI
player asks for `/api/channels/<id>` or `/api/media/<n>` and gets what it
always got. The envelope is a different media type on a different path, and
only a client that asks for it by name receives it.

## Three settings that are never the same thing

| Setting | What it changes | What it promises |
| --- | --- | --- |
| `losslessCompression` | How bytes travel between two nixamps | Decoding restores every byte at the named boundary |
| `hlsPackaging` | The container HLS segments are wrapped in | The media is copied, not re-encoded |
| `qualityProfile` | Whether media is re-encoded | Only `source` ships; anything else is a separate, explicit setting |

Changing one never changes another. The API refuses a `qualityProfile` other
than `source` rather than quietly re-encoding.

## The boundary

Every envelope names where its bytes were captured.

- `channel`: the bytes the channel pipeline emits, after ffmpeg. For a video
  channel that is fragmented MP4; for audio, MP3. This is what a listener on
  `/api/channels/<id>` receives, and it is what every relay today carries.
- `source`: the bytes as they arrived, before ffmpeg. A library file's
  representation (`/api/media/<n>/relay`) is at this boundary. A live channel
  can also be relayed at it, but only when the source is one nixamp can read
  itself and pipe to ffmpeg: a transport stream from a plain http(s) URL or a
  local file, joined from its start, with no per-request headers and no
  separate audio file. For such a channel nixamp reads the source, hands
  ffmpeg the bytes down a pipe, and taps that pipe, so a relay carries the
  exact original bytes, padding and all. For anything else, ffmpeg owns the
  source and the original bytes never pass through the server, so asking for
  the source boundary answers `SOURCE_BOUNDARY_UNAVAILABLE` with the reason,
  never a remux labelled as the original.

  A source-boundary relay is a live join: a receiver gets the stream from the
  moment it connects, not from the beginning, and its demuxer re-syncs on the
  next program table and keyframe. It carries no preface. A channel brought in
  from another nixamp's source-boundary relay is itself read through this
  server, so it plays here and can be relayed on again at either boundary.

## Wire layout

All integers are big-endian. Lengths are unsigned.

### Stream header, 16 bytes, once

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | Magic `NXS1` (`4e 58 53 31`) |
| 4 | 1 | Version, `01` |
| 5 | 1 | Flags, `00` (none defined) |
| 6 | 1 | Boundary: `00` source, `01` channel |
| 7 | 1 | Reserved, `00` |
| 8 | 4 | Generation |
| 12 | 4 | `maxFrameBytes`: the largest decoded size any frame may claim |

The generation changes whenever the source starts over. Frames from two
generations are never on one connection: a new generation is a new
connection with a new stream header.

A receiver refuses a header whose `maxFrameBytes` is larger than its own
ceiling (`BAD_LIMIT`), before it reads a frame.

### Frame header, 48 bytes, per frame

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | Type: `01` data, `02` end |
| 1 | 1 | Mode: `00` stored, `01` zstd, `02` gzip, `03` ts-zstd |
| 2 | 2 | Reserved, `0000` |
| 4 | 4 | Sequence number, from 0, consecutive |
| 8 | 4 | Original length |
| 12 | 4 | Encoded length: how many payload bytes follow |
| 16 | 32 | SHA-256 |

For a data frame the SHA-256 is of the original bytes, and the payload
follows the header. Every data frame is independently decodable: no
dictionary, no window carried between frames.

For the end frame there is no payload; the two length fields together are
the total original bytes of the generation (high word at offset 8, low word
at offset 12), and the SHA-256 is of every original byte in order. A stream
that stops without an end frame was cut off, and a receiver reports
`TRUNCATED`. It never reports a cut-off file as complete.

### Modes

- `stored`: the payload is the original bytes. Encoded length equals original length.
- `zstd`: one Zstandard frame.
- `gzip`: one gzip member. Benchmarked; not selected by any policy.
- `ts-zstd`: the transport-stream transform (below), then Zstandard.

### Validation, in order, before any allocation

A receiver checks, for every frame header:

1. type is data or end (`BAD_FRAME_TYPE`)
2. mode is known (`BAD_MODE`) and was negotiated (`UNSUPPORTED_MODE`)
3. sequence number is the one expected (`BAD_SEQUENCE`)
4. original length is at most `maxFrameBytes` (`FRAME_TOO_LARGE`)
5. encoded length is at most original length + 1024 (`EXPANSION_BUDGET`)
6. a stored frame's lengths are equal (`LENGTH_MISMATCH`)

and after decoding:

7. decoded length equals original length (`LENGTH_MISMATCH`), with the
   decoder capped at that length so a payload cannot grow past it
   (`FRAME_TOO_LARGE`)
8. SHA-256 of the decoded bytes equals the header's (`CHECKSUM_MISMATCH`)

and for the end frame: the total and the stream digest match what was
received; anything after it is `AFTER_END`. A frame that fails is never
forwarded, and the connection is dropped.

The SHA-256 is an integrity check on the media bytes. It is not
authentication: that comes from the TLS connection and the key.

### Test vectors

Stream header, version 1, channel boundary, generation 7, 256 KiB frames:

```
4e585331 01 00 01 00 00000007 00040000
```

Data frame 3, stored, original `hello`:

```
01 00 0000 00000003 00000005 00000005
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
68656c6c6f
```

End frame after one frame of five bytes, the same digest (the stream was
just `hello`):

```
02 00 0000 00000001 00000000 00000005
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

`test/compression-core.test.ts` checks the first two against the encoder;
`test/compression-relay.test.ts` runs a whole stream through the decoder.

## Negotiation over HTTP

A receiver asks for a channel with:

```
GET /api/channels/<id>/relay
Accept: application/vnd.nixamp.stream
X-Nixamp-Stream-Codecs: zstd, ts-zstd
X-Nixamp-Key: <listen or control key>
```

The server answers a stream with:

```
200
Content-Type: application/vnd.nixamp.stream; version=1
Content-Encoding: identity
X-Nixamp-Stream-Codecs: stored,zstd
X-Nixamp-Kind: video
X-Nixamp-Generation: 1757548800
```

`X-Nixamp-Stream-Codecs` on the response lists the modes the stream may use:
the receiver's list intersected with the policy. `ts-zstd` is only offered
when the channel's policy has `tsAware` on. The receiver never sees a mode
it did not offer.

Or it answers JSON and one of:

| Status | `code` | Meaning |
| --- | --- | --- |
| 404 | `NO_SUCH_CHANNEL` | nothing is playing there |
| 406 | (none) | no `Accept` for the envelope: a player followed the link; `playback` says where to go |
| 406 | `RECEIVER_UNSUPPORTED` | the receiver offered nothing the server would compress with |
| 409 | `COMPRESSION_OFF` | the channel's policy, or the server's switch, is off |
| 409 | `SOURCE_BOUNDARY_UNAVAILABLE` | the policy asks for the source boundary, which this server cannot provide |
| 409 | `VARIANT_IN_USE` | another receiver holds the channel's one compressor under a different codec set |
| 416 | (none) | a `Range` header: a relay is never a range |
| 503 | `CHANNEL_GONE` | the channel ended before the relay could start |

Every refusal carries `playback`, the ordinary URL, which is unaffected.

The envelope is not gzipped again by the server, and `Content-Encoding:
identity` asks proxies not to. Do not apply a second layer.

### A library file

```
GET /api/media/<n>/relay
Accept: application/vnd.nixamp.stream
```

answers `202 {"building": true}` with `Retry-After` while the
representation is being made, `200` with `Content-Length`,
`X-Nixamp-Sha256` (of the original file) and `X-Nixamp-Original-Length` once
it is, `409 COMPRESSION_OFF` when the `static` policy is off, `416` for a
`Range`, `503` when the last build failed (the reason is in the body).

The representation is built once, whole, written to a temporary file and
renamed into place, so a request never reads half of one. It is keyed by
the file's path and the policy variant, checked against the file's size and
mtime on every lookup and against its own digest at the end of the build.
A file that changed while it was being read is not published. The cache has
a byte budget; the least recently served representation goes first. The
original file is never touched.

### Bringing a channel in

```
POST /api/channels/<id>/relay          (control key)
{ "from": "https://host:4321/api/channels/<id>/relay", "key": "<their key>", "name": "CNN, relayed" }
```

starts a receiver on this server that dials the address, decodes the
envelope and feeds a channel here named `<id>`, which listeners hear at
`/api/channels/<id>` exactly as if it were decoded here. It probes the
relay first: a channel-boundary relay's decoded bytes are the channel's
output directly, while a source-boundary relay's decoded bytes are the
original transport stream, so they are handed to a channel's own ffmpeg
(read through this server) and the channel can be relayed on again. It
dials again
after a clean end (the upstream started over: listeners here are ended and
rejoin, as they would for a redial) and after a broken one (reported in
`status.incoming.error`), and gives up after five dials without a byte.
`DELETE /api/channels/<id>` stops it. The address is not shown to listeners.

## What gets compressed

A channel's bytes go into blocks of at most `maxBlockBytes`. A block is
flushed when it is full or when its first byte has been held `maxHoldMs`,
whichever comes first; it never waits for a packet boundary. Each block is
compressed once, on the runtime's thread pool, and the result is written to
every receiver: one compressor per channel however many receivers, and no
compressor at all when nobody is receiving.

A compressed block is sent only if it saves at least `minSavingsBytes` **and**
`minSavingsPercent` against the block stored. Both frames carry the same
header, so the comparison of complete representations is the comparison of
payloads. Otherwise the block is sent stored. A stored block costs its bytes
plus 48; the envelope's whole cost on data that does not compress is 16 bytes
plus 48 per block plus 48 at the end, and the metrics say so rather than
claiming a saving.

Under `auto`, eight ineligible blocks in a row stop the compressor trying
for `resampleAfterMs`, after which it tries again. Under `zstd` every block
is tried. Under `off` there is no relay: the endpoint answers
`COMPRESSION_OFF`.

A compressor that falls more than `maxChannelQueueBytes` behind ends its
receivers rather than growing or stalling the channel. A receiver that has
more than `maxListenerQueueBytes` unsent is cut off on its own; the others
carry on. Neither touches the channel or any ordinary listener. A codec that
refuses or times out stores the block and counts a failure.

## The transport-stream transform (`ts-zstd`, experimental)

For a block that is a run of aligned 188-byte packets, the transform writes
every packet's header (the 4 bytes, plus the adaptation field when there is
one) into one region and every payload into another, with any bytes before
the first aligned packet and after the last kept as they are. The headers,
grouped, are a regular sequence that Zstandard squeezes well; interleaved
they are lost among payload bytes that do not compress. It is a reversible
rearrangement in front of an ordinary compressor, and nothing more is
claimed for it. `tsJoin(tsSplit(x))` is `x` for every input, including
malformed adaptation lengths (the packet is kept whole), null packets (kept
whole, never regenerated), and streams that lose sync mid-block.

192- and 204-byte layouts are detected and left to plain Zstandard. The
transform is only used when its complete output is smaller than plain
Zstandard's on the same block, and only when the policy has `tsAware` on
and the receiver offered `ts-zstd`. On a synthetic padded stream it wins;
on a real corpus that has not been measured yet, and `auto` does not
select it until it has.

## Policy

Per channel, at `/api/channels/<id>/compression`:

```json
{
  "losslessCompression": {
    "mode": "off",
    "boundary": "channel",
    "zstdLevel": 1,
    "minSavingsPercent": 3,
    "minSavingsBytes": 512,
    "maxBlockBytes": 262144,
    "maxHoldMs": 100,
    "resampleAfterMs": 60000,
    "maxChannelQueueBytes": 8388608,
    "maxListenerQueueBytes": 1048576,
    "tsAware": false
  },
  "hlsPackaging": "mpegts",
  "qualityProfile": "source",
  "version": 0
}
```

`GET` returns the configured policy, the effective one (after the server's
switch and this server's boundary support) with a plain-language reason
when they differ, the server's settings, and the metrics of the current
generation. `PATCH` takes any subset; unknown fields are refused, not
ignored; ranges are checked; `If-Match: "<version>"` (or `version` in the
body) makes the change conditional on the version you read. Every accepted
change bumps the version. A change that alters what a running relay would
produce ends that relay; its receivers see a cut-off, report it, and dial
again under the new policy.

The pseudo-channel `static` holds the policy for library file
representations.

Server-wide, at `/api/compression`: `GET` for every channel's status, the
pool, the jobs and the cache; `PATCH {"enabled": false}` is the kill switch.
It ends every running relay and refuses new ones; nothing else changes, and
`{"enabled": true}` puts every channel back on its own policy.
`{"hlsPackaging": "fmp4"}` sets the packaging for channels that have no
policy of their own.

Policies are kept in `compression.json` beside `channels.json`, keyed by
port, and written whole then renamed.

## Analysis

`POST /api/channels/<id>/compression/analyses {"seconds": 30}` starts a
job that listens to the channel for up to that long or 25 MiB, whichever
comes first, and runs every codec over the sample. One job runs at a time;
a second request for the same channel and window is handed the running
job; finished jobs are kept ten minutes. `GET
/api/compression/analyses/<jobId>` reports progress and then the result;
`DELETE` cancels. All three need the controls.

The result names the boundary, the sample size and duration, the container
as told by the bytes, the transport-stream report (packet size, packets,
null share, PIDs, the bitrate the PCR clock implies) when it is one, and a
row per codec: complete wire bytes with every header counted, stored and
compressed block counts, encode and decode time, and whether every block
restored exactly. The recommendation is what `auto` would do under the
channel's thresholds, and it says "already efficiently compressed" when
nothing beat stored. The runtime and library versions are in `tools`.

`nixamp compression analyze FILE` runs the same on a file, here, with no
server, at the source boundary.

## Metrics

Per channel and generation: `inputBytes` (from the channel),
`representationBytes` (payloads, once), `wireBytes` (payloads plus headers,
summed over every receiver), block counts by mode, the active mode, whether
`auto` is bypassing and until when, block latency (first byte in to encoded
block ready) as last, p50, p95, max over the last 512 blocks, queue depth,
receivers, receivers dropped, codec failures, and the last fallback reason
in plain words: "already efficiently compressed", "receiver does not support
this format", "processing budget exceeded", "original source bytes are
unavailable", "slow listener", "compression is off". A saving is
`inputBytes - representationBytes`; nothing is reported as saved that was
not.

## HLS packaging

`hlsPackaging: "fmp4"` wraps a channel's HLS segments as fragmented MP4
(`seg00012.m4s`) with an initialisation segment named per packager run
(`init-<8 hex>.mp4`, in `#EXT-X-MAP`), instead of MPEG-TS (`seg00012.ts`).
The media is copied either way; ffmpeg cuts at keyframes, so a segment can
run longer than the two-second target when the source's keyframes are
further apart, and the status reports the longest segment the playlist
actually offers rather than the target. The key travels on the
`#EXT-X-MAP` URI as it does on every segment line, and the init segment is
authorised like any segment. An init from a previous run is a different
name and a 404, so old initialisation cannot be paired with new media.

MPEG-TS remains the default and the fallback. The supported-client matrix
for preferring fMP4 has not been run; do not change the default until it
has.

## Turning it off

- One channel: `nixamp compression set --channel <id> --mode off`, or
  `PATCH` its policy. Its relays end; its receivers report a disconnect
  and, on redial, are answered `COMPRESSION_OFF` and stop.
- The server: `nixamp compression off`, or `PATCH /api/compression
  {"enabled": false}`. Every relay ends, none starts, every policy is kept.
- A receiver: `DELETE /api/channels/<id>` on the receiving server.

None of it touches source media, ordinary listeners, or the original files
behind static representations. The cache directory (`relay-cache` under the
state directory) can be deleted at any time; representations are rebuilt on
demand.

## What is not here yet

- A source-boundary tee for sources ffmpeg alone can reach: sources behind
  per-request headers (a yt-dlp-resolved link), a separate audio track, or a
  container other than transport stream stay channel-boundary only.
- The PWA and desktop controls, and MCP tools: the API is the contract they
  will call.
- A lower-bitrate quality profile: a separate setting, explicitly labelled,
  extending the existing capped encoder.
- Real-feed benchmarks on target hardware, the client matrix for fMP4, and
  the 24-hour soak: the gates for changing any default. Everything here is
  off until they pass.
- birnpack: an offline benchmark adapter only, once it has a streaming form.

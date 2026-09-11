---
openprd: "0.3"
id: "0001"
title: Add lossless stream compression and efficient HLS delivery to NixAmp
status: Draft
authors:
  - anthony@profullstack.com
owner: anthony@profullstack.com
repo: profullstack/nixamp
created: "2026-09-11"
updated: "2026-09-11"
discussion: "https://www.reddit.com/r/compression/comments/1wdc46u/comment/p97uoz0/"
implementation: "https://github.com/profullstack/nixamp/pull/124"
tags: [nixamp, streaming, compression, lossless, mpegts, hls, performance]
supersedes:
superseded-by:
---

## Problem

NixAmp receives MPEG transport streams (`.ts`) from static files and live sources. Operators want to reduce transferred and stored bytes without degrading the picture or sound, increasing buffering, or breaking existing players. The requested capability is an additional lossless compression layer over binary stream data, with a format-aware algorithm investigated where ordinary compression leaves useful redundancy behind.

A `.ts` container is not necessarily uncompressed media. Container redundancy and already-encoded audio/video must be measured separately. Three operations must remain distinct:

| Operation | Preservation contract | Intended outcome |
| --- | --- | --- |
| Lossless transport compression | Decompression reproduces every input byte, including padding and metadata. | Fewer bytes on a controlled connection or in a stored representation. |
| Repackaging / remuxing | Selected encoded media is copied; the container and possibly framing change. | More efficient, compatible delivery without media re-encoding. |
| Lower-bitrate encoding | The media is re-encoded; output is not byte-identical. | Smaller media with explicitly accepted quality and compute tradeoffs. |

The source review for this proposal used NixAmp commit `38c2641354a456919ef1377062202061a1de7891`, not a verified production deployment. At that revision, `src/audio.ts` contains codec-aware fragmented-MP4 output and a capped encoding path; `src/channels.ts` shares channel output with listeners; and `src/hls.ts` copies channel media into MPEG-TS HLS segments. These are integration points, not instructions to replace the server. [S3–S5]

The Reddit discussion led to birnpack, an experimental byte-prediction compressor. Its current file-oriented implementation and published non-video results do not establish suitability for endless live streams. It is a benchmark candidate, not a production dependency. [S6]

The earlier research bundle is exploratory evidence only. Its synthetic results do not predict savings on production sources. The implementation must reproduce relevant experiments and benchmark authorized real feeds before enabling compression by default.

## Goals

Reduce total delivered bytes where measurable redundancy exists, while preserving exact bytes in lossless mode and leaving incompressible data on an efficient passthrough path.

Support static files and indefinite live streams with bounded memory, bounded processing queues, independent recovery points, and shared work across viewers. Preserve NixAmp's existing authentication, channel lifecycle, playback, and compatibility behavior.

Add efficient HLS packaging independently of binary compression. Expose an optional, explicitly labeled lower-bitrate mode by extending the existing encoder rather than conflating transcoding with lossless compression.

Provide one capability through the existing server, CLI, API, MCP, PWA, and desktop surfaces. Publish reproducible measurements and an experimental TS-aware transform without claiming unproven savings or algorithmic novelty.

## Non-Goals

This proposal does not promise that every binary input becomes smaller, invent a new audio/video codec, replace FFmpeg, bypass content protection, or introduce DRM circumvention.

It does not send a proprietary compressed payload to an unchanged native HLS player, require a browser extension, or turn NixAmp into a separate compression SaaS. A custom browser decoder, trained shared dictionaries, codec-level entropy recoding, and cross-user content deduplication are outside v1.

Changing a container is not a byte-exact archival operation. Discarding null packets, audio tracks, subtitles, program information, or timing data is not allowed in exact-byte mode. HTTP response compression after ingestion does not reduce traffic on the upstream provider-to-NixAmp link.

## Users

**Server operators** configure policies, inspect savings and resource use, and roll back without interrupting unrelated channels.

**Broadcasters and relay operators** move authorized static or live sources between NixAmp instances, including constrained uplinks, without changing original media bytes.

**Viewers** use the existing mobile-first player, PWA, desktop app, or an external compatible player without being asked to understand compression algorithms.

**Developers and agents** manage the same policies and diagnostics through the CLI, API, and MCP, with the same permissions and structured errors.

## Requirements

Priorities: P0 is required for the initial production-capable feature; P1 follows the compatibility and resource gates; P2 is experimental research. Configuration and routes below are proposed contracts, not claims that these commands already exist.

### Preservation and architecture

- R1 [P0] Distinguish `losslessCompression`, `hlsPackaging`, and `qualityProfile` in configuration, telemetry, APIs, and UI; changing lossless compression must never silently enable re-encoding.
- R2 [P0] Define exactness relative to a named byte boundary: `source` means bytes captured before FFmpeg, while `channel` means bytes emitted by the existing channel pipeline; record the boundary in every analysis and negotiated relay session.
- R3 [P0] Integrate a shared compression stage into the existing streaming architecture, with at most one active compression result per source generation, boundary, and policy variant, rather than one compressor per viewer.
- R4 [P0] Keep existing media endpoints and compatibility behavior unchanged by default; introduce compressed delivery only through an explicitly negotiated NixAmp-controlled relay representation.

Proposed flow:

```text
Static .ts or live source
  ├─ bounded source tee, when supported and explicitly enabled
  │    → exact-source relay compressor
  │    → authenticated NixAmp relay receiver
  │    → original source bytes → receiver's existing media pipeline
  │
  └─ existing FFmpeg / channel pipeline
       ├─ ordinary MP4 / MP3 delivery
       ├─ existing TS HLS or new fMP4 HLS variant
       └─ optional exact-channel relay compression
            → authenticated NixAmp relay receiver
            → original channel-output bytes → ordinary delivery
```

A source tee must be a bounded streaming operation, not an additional full download. Where FFmpeg owns source acquisition and the original bytes are unavailable, exact-source mode must return `SOURCE_BOUNDARY_UNAVAILABLE` or use an explicitly selected channel boundary. It must not label a remuxed or transcoded output as original source bytes. Support authorized local files and direct HTTP(S) TS sources first; do not silently proxy unsupported protocols through a new ingestion path.

### Diagnostics and adaptive compression

- R5 [P0] Add a bounded analyzer that reports container and codec information, TS packet layout, null-packet share, observed bitrate, and complete-wire-size compression results; inspect bytes rather than trusting the filename alone.
- R6 [P0] Benchmark identity, gzip, and Zstandard on identical samples and block boundaries, reporting encoder/decoder time, memory, framing cost, exact round-trip verification, source provenance, and tool versions.
- R7 [P0] Implement `off`, `auto`, and `zstd` lossless policies with a maintained, pinned Zstandard implementation; use stored frames whenever compression does not beat the complete stored representation by the required margin.
- R8 [P0] Run adaptive selection without holding playback for a full diagnostic sample; evaluate bounded blocks, bypass low-value compression, and periodically resample after cooldown or a source-generation change.
- R9 [P0] Run compression and decompression outside the server's JavaScript event loop with bounded worker concurrency and explicit cancellation, timeout, and resource limits.

Initial tunable defaults, subject to measured release gates:

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
    "maxListenerQueueBytes": 1048576
  },
  "hlsPackaging": "mpegts",
  "qualityProfile": "source"
}
```

`off` preserves existing delivery. `auto` uses measured eligibility; `zstd` chooses the codec but still stores incompressible blocks. A compressed relay can carry stored blocks, so bypass does not require a protocol change mid-session. Eligibility compares all representation bytes, not compressed payload alone. Report any framing expansion against the original unwrapped byte stream honestly.

The 100 ms hold limit starts when the first byte enters a block. Flush at the byte limit or time limit, whichever comes first. Do not wait indefinitely for TS alignment or a large block; carry unsupported or incomplete data as stored bytes. Sample limits default to 30 seconds or 25 MiB, whichever occurs first. Reuse bounded copies of an existing ingest where possible; a new source connection requires an explicit authorized diagnostic request.

### Live relay, recovery, and security

- R10 [P0] Specify and implement a versioned binary relay envelope with explicit algorithm negotiation, source generation, sequence number, original length, encoded length, original-byte integrity check, and an unambiguous clean-end marker.
- R11 [P0] Make each compressed block independently decodable without an unbounded shared history; reconnects must start a new generation or resume from a validated checkpoint rather than mix bytes from different source generations.
- R12 [P0] Bound all queues and apply transport-aware backpressure; disconnect and resynchronize slow live listeners without blocking healthy listeners or dropping arbitrary bytes inside a continued media stream.
- R13 [P0] Negotiate compression only between authenticated endpoints advertising a compatible decoder; retain ordinary playback URLs and gracefully fall back before a compressed session begins when support is absent.
- R14 [P0] Validate versions, modes, lengths, sequence continuity, checksums, decoder window limits, and expansion budgets before forwarding decoded bytes; reject corruption and unsupported frames rather than silently emitting damaged media.
- R15 [P0] Preserve existing source-access controls and validate newly introduced fetches against SSRF, redirect, credential-forwarding, path-traversal, and tenant-isolation threats; never place credentials in compression dictionaries or metric labels.

Publish the envelope's byte layout, endianness, negotiation examples, and cross-language test vectors under `docs/stream-compression.md` before the first transport implementation merges. Use a dedicated custom media type, provisionally `application/vnd.nixamp.stream`, rather than pretending the envelope is an ordinary `.ts` response or a standard HTTP Zstandard body. Do not apply a second HTTP compression layer to the envelope.

Each block declares its actual mode, including `stored`. The stored-frame integrity path is identical to the compressed path. SHA-256 of original bytes is the initial integrity contract; transport authentication still comes from the authenticated TLS connection, not that hash. Reject length fields above negotiated limits before allocating. Initial decoded-frame limit is 256 KiB; compressed data, frame headers, and decoder windows have separately enforced limits.

The custom transport's independent blocks are not necessarily media random-access points. A joining viewer still needs the appropriate initialization data and codec keyframe. Recovery must therefore reuse existing channel initialization/backlog logic or restart the receiving demuxer and obtain valid media initialization. An incomplete static transfer must never be reported as a complete file; an unexpected live EOF must be reported as a disconnect.

For live overflow, close that listener and reconnect at a valid media boundary. For finite file transfer, pause or resume with a verified byte/checkpoint offset. Do not pause an indefinitely producing shared upstream merely to accommodate one slow consumer. Fix ignored `write()` backpressure signals in touched channel/packager paths as part of this work.

### Static files and HLS delivery

- R16 [P0] Support precomputed, immutable compressed representations for authorized static files, with atomic publication, source-identity validation, bounded retention, corruption detection, and the original file retained.
- R17 [P0] Preserve byte-range and seek semantics by keeping the original representation available; never apply original-file offsets to compressed bytes or serve a whole-file compressed cache entry as an arbitrary original range.
- R18 [P0] Add opt-in fMP4 HLS packaging alongside MPEG-TS HLS without re-encoding selected compatible media; correctly serve initialization segments, playlists, media segments, and discontinuities.
- R19 [P0] Extend HLS routing, MIME types, authorization, cleanup, generation-specific filenames, and cache behavior for `.m4s` media and initialization `.mp4` files, including authentication of every `EXT-X-MAP` URI.
- R20 [P0] Validate segment independence against actual source keyframes and timestamps; do not advertise independent segments or guaranteed two-second cuts solely because an HLS flag or duration target was set.
- R21 [P1] Permit fMP4 HLS as the preferred packaging only after the supported-client matrix passes, retaining the TS variant for clients or source codecs requiring it.

The static cache key must include content identity, representation boundary, algorithm/format version, and settings. When byte identity cannot be established cheaply, do not reuse a questionable entry. Include source modification checks and a verified identity before final publication. Keep media on existing storage volumes; do not place media blobs in PostgreSQL.

Initial static seeking uses the uncompressed endpoint or standard HLS representation. A seekable compressed archive/index is not required for v1. The custom relay representation may explicitly reject Range requests; it must not silently return the wrong range. Preserve authorization on all cached variants; generation-specific resource names must prevent an old initialization segment from being combined with new media.

At the reviewed revision, HLS uses a two-second target and six listed segments. Retain current defaults unless tests justify changes. Copying media does not create missing keyframes. Re-encoding to change GOP structure requires the separate quality policy. [S5]

### Existing encoder and product surfaces

- R22 [P1] Extend the existing bitrate-capped encoding path into an explicitly selected lower-bitrate quality option, sharing each rendition across viewers and keeping `source` quality as the default policy.
- R23 [P0] Expose authorized policy reads, conditional updates, diagnostic jobs, cancellation, and structured compression metrics through the existing server API without creating a separate service or identity system.
- R24 [P0] Expose CLI analysis, status, and policy commands using those same handlers, with JSON output on stdout, progress on stderr, nonzero error exits, and no credentials in arguments where safer existing mechanisms are available.
- R25 [P1] Add mobile-first PWA and desktop controls for lossless savings, packaging, and lower-bitrate mode as distinct settings, with visible effective policy and fallback reasons.
- R26 [P1] Expose matching MCP tools with the same schemas, owner/control authorization, job limits, and audit events; read-only tokens must not change policies or start expensive unbounded work.
- R27 [P0] Export per-boundary input/output bytes, complete representation bytes, active codec, stored-block share, processing latency, queue depth, worker health, cache behavior, and fallback reason without claiming hypothetical savings as realized savings.

Proposed API surface, aligned with the existing `/api/channels` namespace:

| Method and route | Purpose |
| --- | --- |
| `GET /api/channels/:id/compression` | Configured policy, effective policy, boundary, and measured status. |
| `PATCH /api/channels/:id/compression` | Validated policy change with an expected policy version / `If-Match`. |
| `POST /api/channels/:id/compression/analyses` | Start a bounded, deduplicated analysis; return a job ID. |
| `GET /api/compression/analyses/:jobId` | Authorized job status and reproducible result. |
| `DELETE /api/compression/analyses/:jobId` | Cancel a diagnostic job. |
| `GET /api/channels/:id/relay` | Explicitly negotiated compressed channel relay; not a public replacement playback URL. |

Exact-source relay acquisition must be bound to an existing authorized source record, not an arbitrary URL appended to a public endpoint. Static diagnostics and configured source relays reuse that source-access layer. Diagnostic job identifiers and results are scoped to the requesting owner or authorized server role.

Proposed CLI examples:

```bash
nixamp compression analyze ./sample.ts --seconds 30 --format json
nixamp compression analyze --channel main --seconds 30 --format json
nixamp compression status --channel main --format json
nixamp compression set --channel main --mode auto --boundary channel
nixamp compression set --channel main --mode off
```

Proposed MCP tools: `nixamp_compression_analyze`, `nixamp_compression_status`, and `nixamp_compression_set`. Do not present these interfaces as installed until implementation and tests exist.

Policy updates are audited and idempotent where applicable. Apply a compatible compression-policy change at a complete frame boundary; changing boundary, envelope version, media initialization, or rendition requires a documented reconnect/discontinuity. Do not silently mutate an active stream's contract.

### Format-aware research and rollout

- R28 [P1] Implement a feature-flagged `ts-zstd` experimental transform that groups original TS headers/adaptation data and payload bytes reversibly, preserving full null packets, ordering, timestamps, continuity counters, and all exceptions.
- R29 [P1] Select TS-aware mode only for validated packet layouts and when its complete framed output beats the baseline; preserve unsupported, malformed, scrambled, or unrecognized layouts through byte-exact stored or ordinary Zstandard modes.
- R30 [P2] Benchmark birnpack in an isolated, offline adapter with pinned source, timeouts, memory limits, and exact round trips; it cannot enter the live path without a streaming design and the same release gates as other codecs.
- R31 [P0] Add deterministic fixtures, property-based tests, cross-decoder vectors, corruption tests, player integration tests, and soak/load tests for both finite files and live feeds before enabling production traffic.
- R32 [P0] Ship staged feature flags and a per-channel/global kill switch, with metrics-only observation first, opt-in canaries second, and defaults changed only after documented compatibility and performance acceptance.
- R33 [P0] Commit the OpenPRD, protocol documentation, tests, benchmark harness, fixtures with redistribution rights, and operator rollback instructions to the NixAmp repository using its existing open-source license and contribution workflow.

The TS-aware experiment initially targets verified 188-byte TS packets. Detect 192/204-byte variants but leave them untouched unless separately implemented and tested. Never reconstruct a supposedly standard null packet instead of preserving its original bytes. Preserve incomplete tails and any unsynchronized regions; no source byte may disappear during parsing or regrouping. Choose among stored, ordinary Zstandard, and transformed Zstandard using the entire output size.

Treat this as a reversible preprocessing technique plus an established compressor. Claims of algorithmic novelty require a separate prior-art review. Promotion requires a reproducible improvement on a held-out representative TS corpus, not just on padded synthetic fixtures; if it does not beat the baseline under the latency budget, retain it as research-only.

Suggested integration locations, adjusted to actual repository conventions:

| Location | Change |
| --- | --- |
| `src/audio.ts` | Preserve existing codec and bitrate logic; extend only the explicit quality path. |
| `src/channels.ts` | Shared output taps, bounded queues, generation handling, and slow-listener recovery. |
| `src/hls.ts` | TS/fMP4 variants, init/media lifecycle, valid keyframe/discontinuity behavior. |
| `src/server.ts` | Protected routes, capability negotiation, metrics, and resource serving. |
| New `src/compression/` modules | Codec adapters, framing, worker management, policy, analysis, and optional TS transform. |
| Existing web/desktop/CLI/MCP adapters | Thin clients over shared service contracts; no duplicated compression logic. |
| `test/`, `scripts/`, `docs/` | Round-trip fixtures, benchmark/soak harness, wire specification, and operational guide. |

Implementation sequence: establish baseline and bounded queues; implement negotiated identity/Zstandard relay and static caching; add optional fMP4 HLS; canary against the client matrix; expose UI/MCP controls and the existing capped quality path; evaluate TS-aware and birnpack research independently. No algorithm experiment blocks useful baseline delivery.

## UX Notes

Ordinary viewers see the existing player. They do not select compressors or install a decoder. Relay compression is terminated by a compatible NixAmp receiver, which serves normal media to downstream clients.

The operator's channel settings separate **Lossless bandwidth savings**, **HLS packaging**, and **Video/audio quality**. Show configured versus effective settings, measurement window, representation boundary, and a plain-language reason when bypassed: “Already efficiently compressed,” “Receiver does not support this format,” “Processing budget exceeded,” or “Original source bytes are unavailable.”

“Analyze” starts a bounded job with progress and cancellation. Results distinguish source-to-server, server-to-relay, and server-to-viewer links. A source-boundary saving must not be presented as a viewer-delivery saving. Remuxed output must not carry a “byte-identical original” badge.

Lower-bitrate mode displays “Re-encodes media; picture or sound may change.” Packaging changes display “Changes the container; does not re-encode media in this stage.” Lossless mode displays “Restores the exact bytes at the selected boundary.”

Use existing mobile-first panels, keyboard/accessibility conventions, and desktop components. Do not redesign NixAmp's player as part of this feature. Rollback is a clearly labeled operator action; viewers either remain on an unaffected ordinary endpoint or receive a bounded reconnect through the established player recovery flow.

## Tech Stack

Extend `profullstack/nixamp`; do not introduce a greenfield service or migrate its architecture.

Use the existing TypeScript/ESM server and CLI, its supported Node.js runtime and Bun-compatible workflow, FFmpeg/ffprobe, existing test runner, and repository package manager/lockfile. The reviewed README specifies Node 24 or newer for the npm distribution; verify the working tree and deployed runtime before choosing bindings. [S7]

Use a maintained native Zstandard binding or a bounded persistent native worker compatible with the supported platforms. Pin versions, verify licensing, and test deterministic decode compatibility. Avoid synchronous codec calls on the request/event-loop thread and avoid spawning a process for every block. Use the current worker/process conventions where suitable.

Retain self-hosted PostgreSQL for account-backed configuration, audit records, and durable analysis summaries where persistence is needed. Do not introduce Turso, SQLite, Redis, or another datastore merely for this feature. Standalone local NixAmp instances retain their existing local configuration/state model and must not require PostgreSQL just to play or relay a stream.

Use existing writable storage volumes for HLS and static caches, with quotas and cleanup. Object storage, Cloudflare R2, and a paid transcoding vendor are not required. Retain the existing deployment paths, including self-hosted Linux/Docker and supported Railway deployments. Native decoder and worker availability must be checked in the actual deployment image.

Reuse the PWA/desktop UI stack and existing shared components. New controls may use the existing shadcn-style components where available; this feature does not require a framework migration. Native compression runs server-side in v1, not on viewer phones.

## Monetization

This is an infrastructure-efficiency capability inside NixAmp, not a new separately billed product. Add no compression fee, subscription requirement, payment provider, or new billing flow. Existing self-hosting, access controls, and monetization remain unchanged.

Measure operational benefit as actual network/storage reduction against incremental CPU, memory, and storage activity. Compression is not automatically profitable when it saves bytes. Report these measurements without assigning invented infrastructure prices; operators may supply their own unit costs for an optional estimate.

Optional future paid transcoding capacity or hosting tiers require a separate product decision. This PRD does not authorize them.

## Success Metrics

These are proposed release gates, not claims of achieved production performance. Record hardware, runtime, versions, workload, source identities, and the measurement interval for every result.

| Gate | Acceptance criterion |
| --- | --- |
| Exactness | Every accepted lossless fixture and transferred static file restores byte-for-byte; SHA-256 matches at the declared boundary. Every live frame validates before downstream delivery. |
| Adaptive savings | Compressed blocks satisfy both the configured 3% and 512-byte net-saving thresholds versus the complete stored frame; all other blocks are stored. Also report aggregate bytes versus unwrapped original traffic, including envelope overhead. |
| Incompressible data | No misleading positive savings; additional transmitted bytes are limited to the documented envelope/end-marker overhead when all blocks are stored. |
| Live delay | On approved target hardware and admitted concurrency, p95 added delay from first byte entering a block to decoded block availability is at most 150 ms; separately report p99, startup, and media latency. |
| Processing headroom | Encoder and decoder sustain at least twice the tested aggregate peak input rate on the admitted workload; otherwise lower concurrency or bypass compression. |
| Memory and queues | Configured channel/listener/global limits hold; a 24-hour soak shows no sustained memory or queue growth after warm-up. |
| Viewer compatibility | Supported Chrome/Chromium, Firefox, Safari/iOS, desktop, and representative external HLS/TV clients pass their ordinary media path or an explicit TS fallback. |
| HLS integrity | Authenticated init and media requests work; keyframe joins, discontinuities, reconnects, live cleanup, and static seeking pass. No init/media generation mixing. |
| Isolation | A slow viewer, bad source, crashing codec worker, or cancelled diagnostic job cannot stall healthy unrelated channels. |
| Work sharing | Adding viewers to the same channel/representation does not create additional encoder/compressor instances; increased network-write work is measured separately. |
| Recovery | Decoder failures and source restarts cause an explicit bounded reconnect or error, never silent corruption or false completion. |
| Rollback | Global/per-channel disable stops new compressed sessions and returns active relays through a documented safe restart path without changing source media or deleting originals. |

The test corpus must include authorized real static and live samples, low- and high-motion video, audio-only streams, padded and unpadded TS, already-efficient fMP4, random bytes, tiny inputs, empty finite files, multiple programs, multiple audio tracks, subtitles/metadata, damaged packets, timestamp discontinuities, variable bitrate, and 188/192/204-byte packet layouts. Unsupported layouts must prove exact passthrough, not silently fail detection.

Test disconnections mid-header and mid-payload, corrupt lengths/checksums, decompression bombs, stale caches, source mutation during preprocessing, worker death, unavailable FFmpeg/codecs, unauthorized init requests, redirects, slow clients, and concurrent policy updates. Test at the operator-declared channel/viewer scale; do not infer server capacity from a single-stream benchmark.

For TS-aware promotion, publish both its incremental gain over ordinary Zstandard and its incremental CPU/latency cost on held-out sources. No mandatory improvement percentage is promised before measurement. If the transform fails to outperform the baseline usefully, `auto` must not select it.

## Risks & Open Questions

**Limited compressibility.** Some sources will have little redundancy after existing encoding and repackaging. That is a valid bypass outcome, not a reason to force CPU-intensive compression or quietly lower quality.

**Source-boundary availability.** Direct FFmpeg acquisition may hide original TS bytes. The first implementation must document which source adapters support an exact pre-FFmpeg tee and reject unsupported requests explicitly. Refactoring ingestion must preserve reconnect, pacing, source credentials, and cancellation behavior.

**Live behavior and compatibility.** Independent compression blocks do not create video keyframes. HLS segment targets are not guarantees under stream copy. Native player behavior must be checked using real clients and supported codecs, especially initialization and authenticated fMP4 delivery.

**Codec resource and security exposure.** Native decoder bugs, hostile frames, unbounded windows, and poorly handled backpressure can turn modest bandwidth savings into an outage. Enforce admission limits, isolate workers, pin dependencies, and retain kill switches. Compression is not encryption; use authenticated TLS and avoid cross-tenant compression state.

**Cost and metrics.** Input-byte counts, channel-produced bytes, cache storage, and bytes delivered to multiple viewers are different measurements. Report each separately. Defaults cannot be justified by synthetic padding savings or by assuming the development machine matches production.

**Experimental algorithm maturity.** TS-aware preprocessing and birnpack remain gated until reproducible benchmarks, cross-platform decode tests, licensing review, and resource tests pass. Do not market either as a new universal binary compressor.

**Repository numbering.** This standalone proposal uses `0001`, matching the reviewed root without a `prd/` collection. Before committing, inspect the current collection, assign the next available contiguous ID if necessary, update the filename/front matter together, regenerate the index, and run the OpenPRD validator. No repository changes or number reservations are made by this document.

Remaining operator inputs are target hardware/concurrency, the supported viewer/TV matrix, and representative authorized feeds. These do not block instrumentation or opt-in implementation; they block changing production defaults. Keep all new behavior disabled until its specific gates pass.

### Sources and implementation references

The sources below establish the format and reviewed implementation context, not benchmark guarantees. Verify the working tree before making changes.

- [S1] OpenPRD 0.3 source specification: <https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md>. Reviewed file blob: `74d5d0b1df4ccc8e9990acc470ad07ecda1a93f6`.
- [S2] OpenPRD front-matter schema: <https://github.com/profullstack/logicsrc/blob/master/packages/schemas/schemas/openprd-prd.schema.json>. Reviewed file blob: `51a44594b6f6a2d2a6b5d5e61b5d61e0c924ae0e`.
- [S3] NixAmp codec selection and capped encoding: <https://github.com/profullstack/nixamp/blob/38c2641354a456919ef1377062202061a1de7891/src/audio.ts>.
- [S4] NixAmp channel lifecycle and listener fan-out: <https://github.com/profullstack/nixamp/blob/38c2641354a456919ef1377062202061a1de7891/src/channels.ts>.
- [S5] NixAmp HLS packager and URL authorization helper: <https://github.com/profullstack/nixamp/blob/38c2641354a456919ef1377062202061a1de7891/src/hls.ts>.
- [S6] birnpack research candidate: <https://github.com/ingo6/birnpack>. Review the README and `src/welle_fast.c` at a pinned commit before running experiments.
- [S7] NixAmp runtime and deployment guidance: <https://github.com/profullstack/nixamp/blob/38c2641354a456919ef1377062202061a1de7891/README.md>.
- [S8] HLS specification and fMP4 requirements: <https://www.rfc-editor.org/rfc/rfc8216>.
- [S9] FFmpeg HLS muxer reference: <https://ffmpeg.org/ffmpeg-formats.html#hls>.
- [S10] Zstandard reference implementation and format documentation: <https://github.com/facebook/zstd>.

Repository completion checks:

```bash
logicsrc prd index --write
logicsrc prd validate --strict
```

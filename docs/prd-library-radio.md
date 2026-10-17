# Nixamp: Personal Music Library and Radio Stations

## Product Requirements Document

- Version: 1.0
- Date: October 17, 2026
- Owner: Profullstack, Inc.
- Primary domain: https://nixamp.com
- Connected product: https://bittorrented.com
- Primary repository: https://github.com/profullstack/nixamp
- Integration repository: https://github.com/profullstack/media-streamer
- Status: Proposed implementation specification; existing capabilities require verification.
- Phase 0 verification: [library-radio-phase0.md](library-radio-phase0.md)

## 1. Product and domain decision

Use Nixamp as the product and nixamp.com as the primary domain. No additional domain purchase or separate brand is required.

Organize the experience into Library and Radio. BitTorrented remains a connected source and an additional place to discover and start stations.

Product promise:

> Play your files anywhere. Turn your collection into a station.

Radio workflow:

> Pick a collection. Start a station. Share a link.

Proposed navigation destinations are /library and /radio. Reuse existing public listening routes where compatible. These are proposed information-architecture decisions, not claims that those routes are currently deployed.

## 2. Problem and opportunity

People with audio collections need a convenient way to browse and play their files across devices. Some also want to turn those collections into persistent stations that other people can join.

The proposed advantage is a simple, reliable path from an existing collection to a working station, supported by Nixamp's interfaces and BitTorrented integration.

There is established competition. Music Assistant supports multiple music sources, remote listening, and guest requests. AzuraCast provides station management and public players. The opportunity must therefore be demonstrated through setup convenience, reliability, integration, and repeat use. [S4, S5]

Primary audiences:

- Collection owners using their own files across devices.
- Existing Nixamp and BitTorrented users who want to broadcast selected collections.
- Independent artists, labels, podcasters, and communities with permission to distribute their programming.
- Operators willing to pay for reliable hosting and reduced administration.

## 3. Existing foundation and implementation policy

The Nixamp documentation describes folder playback, a background daemon, live channels, listening links, a directory, and BitTorrented party integration. Its manifest identifies a TypeScript project with Bun tooling, an hqtui dependency, and existing web and desktop workspaces. BitTorrented documents audio streaming and personal collections. [S1, S2, S3]

These findings establish a documented starting point, not production acceptance.

Before implementation:

1. Record the exact commit and deployed version of each repository.
2. Inventory existing source, library, channel, authentication, directory, billing, CLI, and MCP behavior.
3. Classify each requirement as verified existing, partial, missing, or incompatible.
4. Record migrations and compatibility obligations.
5. Confirm the deployment and media-hosting arrangement.

Extend the existing engine, interfaces, and persistence. A replacement player, second daemon, new identity system, or new frontend framework is not a prerequisite.

## 4. Goals and scope

### Goals

1. Let an owner connect an authorized collection and play it privately.
2. Let that owner operate a persistent radio station from selected files.
3. Let outside listeners open a link and hear the current broadcast.
4. Keep listening, library access, and station control independently authorized.
5. Make station operation observable and recoverable.
6. Validate demand before expanding paid infrastructure.

### Initial release

- Local-folder sources through an existing Nixamp host.
- Explicit BitTorrented collection handoff.
- Private on-demand library playback.
- Persistent stations with ordered or shuffled playlist rotation.
- Public listening pages and authenticated private listening.
- Explicit directory publication.
- Compatible standard stream output and playlist export.
- Core management through web, desktop, CLI/TUI, API, and MCP.
- Recovery, usage measurement, and an operator dashboard.

### Later releases

- Managed storage and continuous hosted playout.
- Broader relay hosting and custom domains.
- Weekly schedules, live microphone takeover, and additional DJ roles.
- Optional listener requests and creator monetization.
- OpenSubsonic compatibility for the private library.
- Additional sources and optional AI presentation features.

### Outside initial scope

- A supplied commercial music catalog.
- Automatic broadcasting of every downloaded file.
- New video, television, or event-platform features.
- Sample-accurate synchronization across arbitrary devices.
- Claims that streamed audio cannot be captured.
- Mandatory AI services or a requirement to upload an entire library.

Existing video, event, account, and payment functionality must retain its current behavior unless a separately reviewed change is necessary.

## 5. Two playback modes

| Mode | Playback behavior | Access model |
| --- | --- | --- |
| Personal library | Each user has an independent queue and playback position | Private; additional access requires a specific grant |
| Radio station | The server owns one continuous program; listeners join its current position | Private, unlisted, or public, with directory publication separately controlled |

Playing, pausing, or seeking in a personal library must not change station playback.

A station listener controls their own volume and connection. Pausing or stopping listening must not pause the broadcast. Rejoining returns to the live position; station rewind is outside the initial release.

A live station is not an independently shuffled playlist for each visitor.

## 6. Core user journeys

### 6.1 Connect a personal collection

The owner selects a folder through a desktop application or an authorized daemon connection. A hosted website must not imply it can continuously read an arbitrary folder on the user's computer without a connected host.

Nixamp displays the selected source, its host, scanning progress, available tracks, and problems. The owner can browse by artist, album, track, playlist, or folder and start private playback.

Removing a source from Nixamp removes its association and applicable cache. It must not delete original files.

### 6.2 Create and share a station

The owner selects eligible tracks or a collection, names the station, chooses artwork and rotation, and starts a private preview.

After confirming audio works, the owner can invite listeners or explicitly publish the station. The share page displays the station, current track, playback status, and a prominent Play control.

Public listening requires no account. Private listening uses a valid account grant or revocable invitation.

### 6.3 Start from BitTorrented

BitTorrented offers a proposed Broadcast with Nixamp action for selected audio or a collection.

The owner selects a Nixamp host, reviews the files and any storage transfer, and creates a private station draft. Incomplete files remain pending. The owner starts and publishes the station separately.

Retrying the handoff must not create duplicate sources, assets, or stations.

### 6.4 Leave it running

Closing control tabs or disconnecting the phone leaves the station running on its host.

The interface identifies the machine providing continuous playback. If that machine sleeps, disconnects, or shuts down, a forwarding relay alone cannot continue the collection indefinitely.

## 7. Library requirements

### LIB-01: Authorized sources

- Sources have stable IDs, an owner, a host, and explicit access configuration.
- Local indexing is restricted to approved roots, including symlink handling.
- Connector credentials remain server-side.
- Initial source types are local folder and BitTorrented handoff.
- A source can be disabled, rescanned, or removed independently of its files.

### LIB-02: Indexing and metadata

- Support MP3, FLAC, Ogg/Vorbis, Opus, AAC/M4A, and WAV when the deployed decoder supports the specific file.
- Probe format, duration, decodability, and required technical metadata.
- Extract title, artist, album, track number, genre, and available artwork.
- Provide usable filename-based labels when tags are missing.
- Preserve explicit metadata corrections across rescans.
- Use stable item identities and content hashes where appropriate; do not merge different recordings solely because their names match.
- Perform incremental rescans and expose actionable errors.

### LIB-03: Availability and preparation

Every item has an explicit state: pending, ready, unavailable, unsupported, or failed.

Only ready items enter active station rotation. Indexing must not block playback of items already ready.

Cache storage has a configurable limit. Files required for the current track, upcoming prepared tracks, or a selected fallback are pinned until no longer needed.

### LIB-04: Private playback

- Search and browse with pagination.
- Create, rename, reorder, and delete playlists.
- Play, pause, seek, skip, shuffle, and repeat independently of stations.
- Preserve the owner's queue and recent playback position.
- Resume across devices after authentication.
- Request only the source and item permissions needed for playback.

Library search and raw-file endpoints are never implicitly exposed by publishing a station.

## 8. Station requirements

### RAD-01: Durable identity

A station has a stable ID, owner, name, description, artwork, listening URL, source bindings, playlist, and access configuration.

Station identity is distinct from the temporary channel or playback process delivering its current program. Restarts, renderer replacement, and temporary offline periods must preserve its listening URL.

Renaming a station preserves existing links through stable IDs or an intentional alias strategy.

### RAD-02: Publication and permissions

- Newly created stations are private, stopped, and absent from the public directory.
- Starting a station does not automatically publish it.
- Visibility and directory listing are separate settings.
- Public pages expose only approved station metadata.
- Unlisted stations have a shareable listening URL but no directory entry.
- Private stations require access grants.
- An unlisted URL is not presented as equivalent to authenticated private access.
- Owners can revoke invitations and controller access.

Removing a directory listing changes discovery only. Changing public visibility to unlisted leaves link-based listening available. Changing public or unlisted visibility to private must remove unauthorized access, invalidate controlled public delivery caches, and terminate or reauthorize active connections within the revocation bound.

Apply new-station defaults without silently changing existing publication choices. Migration must never publish an existing private stream.

### RAD-03: Rotation and controls

- Support an ordered playlist, repeat, and station-wide shuffle.
- Persist the chosen rotation and sufficient state for predictable recovery.
- Offer start, stop, skip, and playlist update controls to authorized operators.
- Apply playlist edits at a documented boundary, normally the next track.
- Reject an empty station start with an actionable message.
- Skip a corrupt or missing item without entering an endless retry loop.
- Exclude repeatedly failing items until they are repaired or explicitly retried.

### RAD-04: Desired and observed state

Persist desired state as running or stopped.

Expose observed states including starting, live, recovering, offline, and stopped. Equivalent existing states may be retained if their meanings are documented.

A station deliberately stopped by its owner stays stopped after restart. A station configured to run may recover automatically after a crash.

Directory status follows station health without deleting the station's identity.

### RAD-05: Recovery

Initial recovery policy: restore configuration and permissions, then advance to the next eligible track rather than replaying an unknown amount of the interrupted track.

Renderer retries use bounded backoff. If recovery fails, present an offline state and an operator diagnostic.

A configured playable fallback may bridge missing-source or decode failures. If no usable content remains, stop the renderer, set observed state to offline, and explain the failure. Preserve desired state as running so source restoration can trigger bounded recovery. An explicit owner stop overrides recovery and sets desired state to stopped.

## 9. Audio delivery and now-playing metadata

Use the existing Nixamp audio pipeline where it satisfies these requirements.

Maintain one authoritative program timeline per station. Encoding may differ by output rendition, but listeners must not trigger independent station scheduling or a full transcoder per connection.

Initial interoperability requirements:

- At least one documented continuous HTTP audio stream usable by compatible outside players.
- M3U export containing that stream's listening URL.
- Browser-compatible playback on the supported device matrix.
- HLS/AAC may provide an additional browser delivery path when supported and tested.
- Explicit codec, bitrate, sample rate, and channel reporting.
- Configurable compressed output suitable for internet delivery; 128 kbps is the initial cost-model baseline, not a claim about existing defaults.
- Bounded buffers and backpressure so a slow listener does not stall the station.

Now-playing events include station ID, playback-instance ID, track-instance ID, rendered start time, duration when known, and public metadata.

Events must follow confirmed output transitions rather than the time a future track starts preparing. The Nixamp player accounts for its own buffer so displayed metadata follows audible playback. External players may have different metadata and timing capabilities.

Reconnection rejoins the current live program. A socket connection or HTTP 200 alone is insufficient evidence of healthy audio.

## 10. BitTorrented integration contract

Keep BitTorrented responsible for its acquisition and collection workflows. Nixamp manages its imported library references, station programming, and playback.

The handoff contains:

- Stable source, collection, and file identifiers.
- The authorizing user and destination Nixamp host.
- File name, size, media type, and available metadata.
- Completion and integrity-verification state.
- A scoped access mechanism or approved shared-storage mapping.
- Expiry information for temporary access.
- An idempotency key and handoff version.

Requirements:

1. Only explicitly selected files or collections are eligible.
2. Initial handoff admits completed, verified files; partial files remain pending.
3. Nixamp probes each file before declaring it ready.
4. Transfer or storage replication is shown before it happens.
5. Current and upcoming tracks are available from a verified cache or retained source independently of torrent peer availability.
6. Expired access, source deletion, or mount loss produces a defined unavailable state.
7. Removing a BitTorrented item does not silently destroy an authorized independent copy; retention and deletion behavior must be visible and documented.
8. Automatically adding future collection items requires an explicit setting and applies the same readiness checks.
9. Account linking uses the existing supported integration rather than a second password database.

A selected collection is not, by itself, permission to publish every file publicly.

## 11. Hosting and connectivity

| Deployment mode | Required running components | Behavior when the source computer is off |
| --- | --- | --- |
| Direct host | Nixamp origin and accessible files | Station becomes unavailable |
| Host with forwarding relay | Origin, files, and relay | Station stops after any remaining buffer; relay does not generate new programming |
| Managed storage and playout | Authorized replicated assets and hosted Nixamp runtime | Station can continue independently of the original computer |

The beta must support at least one documented internet-reachable deployment and verify outside listening before calling a station shareable.

General consumer onboarding requires a tested connection method appropriate to the user's network, including a relay where necessary. Do not promise universal remote access based only on a local-network test.

A relay connection exposes only required authenticated functions. It must not expose the daemon's unrestricted administration surface.

Managed storage and playout is a separate later feature with explicit storage consent, quotas, deletion controls, and operating costs.

## 12. User experience and surfaces

### Web and mobile PWA

- Primary navigation: Library, Radio, My Stations, and Settings.
- Station creation is a short guided flow with a real audio preview.
- Listening pages prioritize Play, station identity, and now-playing information.
- Playback status distinguishes live, reconnecting, unavailable, and intentionally stopped.
- Public listening works without an account.
- Show a clear user-initiated Play action where browsers require it.
- Support keyboard operation, screen readers, visible focus, and reduced motion.
- Keep file paths, credentials, and infrastructure diagnostics out of public pages.

### Desktop

- Reuse the existing desktop application and daemon.
- Provide folder selection, host status, and background-operation controls.
- Clearly distinguish closing a window from stopping the station.
- Show whether the machine is the active origin.

### CLI, TUI, API, and MCP

Provide the same core library, station, status, and access-management operations through shared application services.

Routine headless operation must not depend on clicking a browser. Reuse existing authentication and machine-token support.

Core errors must be consistent across surfaces. CLI commands support structured output and useful exit codes. Advanced station design can remain a web-first workflow in the initial release.

## 13. Proposed API and command additions

The following contracts are proposed. They must be mapped to existing interfaces where possible and are not claims about installed commands.

| Capability | Proposed HTTP shape |
| --- | --- |
| Sources | GET/POST /api/v1/library/sources |
| Source update/removal | PATCH/DELETE /api/v1/library/sources/:id |
| Scan source | POST /api/v1/library/sources/:id/scan |
| Browse/search items | GET /api/v1/library/items |
| Manage playlists | GET/POST/PATCH/DELETE under /api/v1/library/playlists |
| Create/list stations | GET/POST /api/v1/stations |
| Station configuration | GET/PATCH/DELETE /api/v1/stations/:id |
| Playback operations | POST /api/v1/stations/:id/start, /stop, /skip |
| State and now playing | GET /api/v1/stations/:id/state |
| Invitations and grants | Scoped operations under /api/v1/stations/:id/access |
| BitTorrented handoff | POST /api/v1/integrations/bittorrented/handoffs |

Illustrative CLI:

    nixamp library add ~/Music
    nixamp library scan SOURCE_ID
    nixamp station create --name "My Station" --source SOURCE_ID
    nixamp station start STATION_ID
    nixamp station status STATION_ID --json
    nixamp station publish STATION_ID
    nixamp station stop STATION_ID

Publishing is an explicit operation. A script creating or starting a station must not implicitly publish it.

Expose equivalent MCP operations for source inspection, library search, station creation/update, start/stop, status, and publication, with the same scopes and audit records.

All mutation APIs validate ownership, support safe retries where applicable, and return stable error codes. List endpoints require pagination. Long-running scans and transfers return job IDs.

## 14. Data model

| Entity | Core responsibility |
| --- | --- |
| Source | Owner, host, connector type, approved root or reference, credentials reference, status |
| LibraryItem | Stable identity, source reference, metadata, format, duration, availability, hash |
| Playlist | Owner, ordered item references, revision, rotation settings |
| Station | Durable identity, owner, presentation, playlist, visibility, desired state, quotas |
| PlaybackInstance | Runtime channel mapping, track instance, timing, health, recovery state |
| AccessGrant | Subject or invitation, station/library scope, permissions, expiry, revocation |
| HandoffJob | Source/destination, selected assets, idempotency key, progress, errors |
| UsageRecord | Listener-seconds, delivery bytes, storage use, and billable context |
| AuditEvent | Actor, action, target, result, and timestamp |

Use existing local persistence for local state and existing hosted persistence where appropriate. Keep schemas additive and migration-safe.

Artwork and media belong in existing media storage or explicit cache locations. Database records store references rather than large audio blobs.

## 15. Security, privacy, and broadcast permissions

### Access and isolation

- Enforce owner, controller, listener, and library permissions server-side.
- Listening permission never grants station control or library enumeration.
- Validate authorization on every station and asset reference.
- Private stream access must work through short-lived authorized delivery mechanisms; never place owner tokens in media URLs.
- Apply revocation consistently through origin, relay, and cache.
- Protect browser mutations against CSRF where cookie authentication is used.
- Restrict CORS to intended origins.

### Source safety

- Validate paths against approved source roots.
- Treat filenames, tags, artwork, and playlist content as untrusted input.
- Pass decoder arguments without shell interpolation.
- Restrict remote connectors by scheme, destination, and credentials.
- Check redirects and resolved destinations to prevent arbitrary server-side fetching.
- Explicitly configured private-network connectors may access only their approved endpoints.
- Bound decoder resources, file sizes where appropriate, scan concurrency, and transfer jobs.
- Restrict decoder/probe privileges and permitted protocols so embedded media or playlist references cannot escape approved sources or bypass network restrictions.

### Privacy

- Collect aggregate operational metrics by default.
- Avoid retaining unnecessary listener IP addresses or private listening history.
- Document retention, deletion, and export behavior.
- Do not expose raw paths, privileged fetch URLs, or credentials in station metadata.

### Broadcast permissions

Possessing a file does not automatically grant public broadcast rights. U.S. noninteractive sound-recording licensing and interactive/on-demand licensing differ; underlying compositions also have rights. [S6]

The product must distinguish personal playback from station publication. Before public publication, require the owner to identify an applicable basis such as controlled rights, explicit permission, suitable licensing, or public-domain status for the relevant recording and composition.

This record is an operational declaration, not automatic legal clearance. Private or unlisted access must not be advertised as a copyright exemption.

Keep track-level playout records sufficient for applicable reporting, and provide a process to report and suspend unauthorized public content. Broader commercial music licensing requires a separate launch decision.

## 16. Reliability and performance targets

These are acceptance targets, not measured current performance or an advertised SLA.

Reference test conditions: an agreed Linux host with 4 vCPU, 8 GB RAM, SSD storage, adequate unthrottled network capacity, and a representative collection of 10,000 supported audio files.

| Measure | Initial target |
| --- | --- |
| Indexed library search | p95 under 500 ms, excluding remote audio fetch |
| First audible playback | p95 under 5 seconds on a documented broadband test profile |
| Station capacity | 100 concurrent listeners to one 128 kbps rendition on the reference deployment |
| Controller independence | Closing all control tabs causes no station interruption |
| Decoder recovery | p95 under 30 seconds when healthy fallback/media are available |
| Metadata alignment | Within 2 seconds of audible transitions in the supported Nixamp player |
| Access revocation | New requests denied within 60 seconds; continuing delivery terminated within that bound plus documented unavoidable client buffer |
| Soak test | Seven days without manual intervention or unbounded resource growth |

Test actual decoded audio, startup latency, transitions, and reconnect behavior. Record client buffering and end-to-end delay separately.

Do not infer exact speaker synchronization from a shared program timeline.

## 17. Observability and operator controls

Expose:

- Station desired state, observed state, host reachability, and last healthy output.
- Current track, upcoming prepared item, and fallback readiness.
- Listener count with a documented counting method.
- Delivered bytes, output format, and bitrate.
- Cache/storage use and preparation failures.
- Decoder restarts and reconnect rates.
- Authentication, grant, and publication changes.

Provide actionable alerts for sustained source loss, repeated rendering failure, exhausted storage, and delivery limits.

An operator must be able to stop one station without disrupting others. Logs must identify the affected station and playback instance while excluding secrets.

Enforce configurable limits for active stations, renditions, concurrent listeners, delivery allowance, and request rates at both origin and relay. Limit control requests as well as public delivery. Reject new admissions with an actionable response when capacity is exhausted; an exhausted delivery allowance follows the configured pause policy. Reserve operational capacity so one overloaded station cannot exhaust the entire service.

## 18. Commercial model and cost controls

Keep self-hosted use viable. Test paid value through managed operation, delivery, and administration.

Potential paid services:

- Hosted station runtime and storage.
- Relay delivery and included transfer allowance.
- Additional stations and collaborators.
- Custom domains, branding, backups, and advanced scheduling.
- Operational support and audience analytics.

Use existing CoinPay integration where suitable after verifying its current behavior. Do not introduce a second billing identity.

Public pilot stations should support a frictionless first listen. Existing paid events and creator-controlled access can remain optional.

Cost model:

    monthly_bytes =
        bitrate_bits_per_second / 8
        * average_concurrent_listeners
        * seconds_in_month

At 128 kbps, 100 average concurrent listeners over 30 days consume approximately 4.15 TB before protocol overhead.

Meter actual delivery, storage, and runtime use. Plans must state station, storage, concurrency, and transfer limits. Provide threshold notifications and an explicit limit policy. No silent paid overages or claims of unlimited delivery.

Hosted pricing follows measured pilot costs and willingness to pay. AI features, if added later, require opt-in and separate usage limits.

## 19. Acceptance scenarios

| ID | Scenario | Required result |
| --- | --- | --- |
| AC-01 | Connect a folder with supported, corrupt, and unsupported files | Ready items play; failed items have actionable status |
| AC-02 | Remove a source | Original files remain intact |
| AC-03 | Play a private album while a station runs | Personal controls do not change the station |
| AC-04 | Two clients join a station at different times | Both hear the same program in progress |
| AC-05 | Close every controller window | The station continues on its host |
| AC-06 | Restart the daemon | Station identity, URL, settings, and grants survive |
| AC-07 | Restart an intentionally stopped station's host | It remains stopped |
| AC-08 | Kill the active renderer | Recovery follows policy and status is truthful |
| AC-09 | Remove or corrupt the upcoming file | Playback advances or uses fallback without a retry loop |
| AC-10 | Disconnect an origin behind a healthy relay | The station reports source loss; relay health does not imply station health |
| AC-11 | Retry a BitTorrented handoff | No duplicate assets or station are created |
| AC-12 | Include incomplete download files | They cannot enter active rotation |
| AC-13 | Attempt control using listener access | All unauthorized changes are denied |
| AC-14 | Substitute another station or asset ID | Cross-owner access is denied |
| AC-15 | Revoke a private grant | Direct and relayed access meet the revocation bound |
| AC-16 | Supply a traversal path or disallowed redirect | The source request is rejected |
| AC-17 | Join and reconnect across supported browsers | Audio starts after the required interaction and rejoins live |
| AC-18 | Observe consecutive track changes | Player metadata meets the audible-alignment target |
| AC-19 | Create/start a station without publication | It is absent from the public directory |
| AC-20 | Run the capacity and seven-day tests | Targets hold, with no unbounded memory, process, or cache growth |
| AC-21 | Restore a lost source while desired state remains running | The station recovers under the same identity and URL |
| AC-22 | Remove directory listing, then make the station private | Discovery and access change independently; unauthorized delivery is revoked |
| AC-23 | Exceed configured connection or delivery limits | Limits are enforced without exhausting other stations or control access |
| AC-24 | Probe media containing a disallowed embedded reference | Decoder access cannot escape the approved source or connector policy |

The browser matrix must include current Chrome, Firefox, and Safari desktop releases, iOS Safari, and Android Chrome at release time. Document any feature-specific differences and validate background playback on the supported mobile configurations.

## 20. Delivery phases

### Phase 0: Verify the existing product

Produce a capability map, pinned baseline, deployment inventory, compatibility plan, and revised implementation estimate.

Demonstrate existing folder playback and one external listener before selecting additional infrastructure.

### Phase 1: Complete the core beta

Deliver the required source/library workflow, persistent station lifecycle, BitTorrented handoff, access boundaries, compatible listening, and operational visibility.

Verify one internet-reachable deployment. Label network limitations honestly.

### Phase 2: Operate the Profullstack pilot

Run a public demonstration station using authorized material for seven days. Include outside listeners and complete the acceptance scenarios.

Have at least five external creators attempt the collection-to-station flow without live assistance.

### Phase 3: Validate managed service demand

Measure costs and test paid hosting with actual customers. Require at least two paid pilot customers before expanding managed infrastructure.

Add managed playout, broader relay onboarding, and commercial controls in response to observed needs.

### Phase 4: Expand selectively

Prioritize schedules, DJ workflows, discovery, interoperability, and additional sources according to repeat usage. AI hosts and other enhancements follow demonstrated demand.

Calendar estimates are set after Phase 0; this document does not assume missing features are already implemented.

## 21. Product success measures

Track:

- Source connection and station-creation completion.
- Time from selecting a ready collection to successful outside listening.
- Station return usage at seven and thirty days.
- Repeat listeners on separate days.
- Stations with listeners other than their owner.
- Support needed per creator.
- Cost per listener-hour and active station.
- Paid conversion and retention for hosted pilots.

Initial validation targets:

- At least four of five pilot creators complete setup without live help.
- With a reachable host and ready media, first outside listening takes under five minutes.
- At least three pilot creators operate their stations again in the following week.
- At least two creators pay for a clearly scoped managed pilot before infrastructure expansion.

These are small-pilot decision thresholds, not proof of broad product-market fit.

## 22. Release and completion criteria

Use additive migrations and feature flags. Preserve existing library, event, directory, and account behavior.

Ship first to the internal station, then pilot creators, then broader access. Rollback must preserve station identities, source bindings, and original media.

The core release is complete when:

1. An owner can connect files and privately play them.
2. The owner can create a persistent station from selected ready items.
3. An outside listener can hear its current program.
4. Closing the controller leaves it running.
5. Recovery, access isolation, and metadata behavior pass acceptance.
6. BitTorrented handoffs are explicit, authorized, and repeatable.
7. Hosting dependence, publication permissions, and costs are clear.
8. The operator has evidence of the seven-day pilot and creator setup outcomes.

The first concrete deliverable is a working Profullstack station on Nixamp, supported by the existing products and a verified end-to-end listening experience.

## 23. Sources and evidence

Sources were consulted on October 17, 2026. Repository documentation may differ from deployed behavior. Requirements and targets above are proposed unless explicitly described as documented existing capabilities.

- [S1] Nixamp repository and README: https://github.com/profullstack/nixamp
- [S2] Nixamp package manifest: https://github.com/profullstack/nixamp/blob/main/package.json
- [S3] BitTorrented repository: https://github.com/profullstack/media-streamer
- [S4] Music Assistant and remote party capabilities: https://www.music-assistant.io/ and https://www.music-assistant.io/plugins/party/
- [S5] AzuraCast: https://www.azuracast.com/
- [S6] SoundExchange licensing overview: https://www.soundexchange.com/service-provider/licensing-101/
- [S7] OpenSubsonic API: https://opensubsonic.netlify.app/docs/
- [S8] HLS live and on-demand audio delivery: https://developer.apple.com/streaming/

# UX and accessibility baseline

These rules apply to every Nixamp interface. They are the proposed shared
`/specs/ux` baseline alongside the design specs.

## The reader owns scrolling and focus

- Incoming captions, chat, polling, playback changes, loading, and rendering
  MUST NOT scroll the document or any panel, move focus, change the reader's
  selected page, or reset the caret. Never scroll a new transcript into view.
- No scrolljacking: do not override native wheel, touch, scrollbar, or browser
  navigation behavior. New messages may be indicated without navigating to them.
- A specifically requested navigation action may use a native link. An explicit
  close or keyboard reorder action may restore relevant focus with
  `preventScroll: true`. Background callbacks never get that exception.
- Live updates MUST preserve focused controls. Defer replacement until focus
  leaves a list rather than rebuilding the focused element and repairing focus.
- Reduced-motion and forced-colors preferences MUST work by default.

## Accessible without setup

- Use native buttons, links, inputs, labels, lists, and headings. Every control
  needs an accessible name; icons and color alone are insufficient.
- Support keyboard activation and visible focus. Dragging requires a keyboard
  alternative. Global single-character shortcuts MUST NOT interfere with screen
  readers, typing, sliders, buttons, or normal browser navigation.
- Provide skip links, meaningful landmarks and headings, current/expanded states,
  and descriptive slider values such as elapsed time or volume percentage.
- Announce concise operational changes politely without moving focus. Deduplicate
  repeated render output. Live transcripts, chat history, clocks, meters, and
  visualizers MUST NOT flood assistive technology with repeated announcements.
- Forms remain usable with password managers, autofill, keyboard, and screen
  readers. Errors and success messages must be available as text.
- Captions, language selection, voice selection, speaker overrides, and disabling
  translated playback must be keyboard and screen-reader accessible.
- Accessibility is not a mode users must discover. It is the default interface.

## Verification

Check anonymous and signed-in playback, files, directory, rooms, transcript,
translation controls, forms, and panel controls. Verify keyboard-only operation,
accessible names, contrast, reduced motion, and representative mobile layouts.
Automated checks complement manual assistive-technology testing; passing an
automated audit alone is not a claim of full WCAG conformance.

For realtime regressions, focus an unrelated field and scroll to a chosen
position, deliver multiple updates, and assert that document scroll, panel
scroll, focus, caret, and the selected browsing page remain unchanged.

## Player translation controls

Keep translated playback in the player: one opt-in beside the existing language
menu replaces that player's original audio. Turning it off restores the source.
Do not add tab-sharing, microphone-source, or separate capture start/stop controls
to this interface. Keep optional background settings and speaker overrides
collapsed. Keep background gain steady across translated phrases and gaps;
never duck or fade it in response to synthesized speech. Temporary connection
recovery must keep original commentary muted. Stock-voice choices must not be presented as detected speaker gender.

## Paid panels and upgrades

All Nixamp-owned paid panels and upgrades use the common server-side
`UpgradeAllowances` policy: five free session starts total per account per UTC
day. New paid features must use this shared counter rather than inventing an
independent trial or a browser-only limit. Creator-sold event tickets and external
stream access are separate products, not Nixamp upgrades.

Free sessions last while the listener remains, within existing usage limits;
there is no fixed minute cutoff. Reconnect within 90 seconds to reuse a session.
Ongoing sessions continue across midnight. Account identity, atomic claims and
active leases are checked on the server. Polling and rendering never claim or
renew free use. A session's provider requests do not consume additional starts.

Show the remaining daily allowance and purchased credit beside the upgrade.
Use free access first and retain paid credit unchanged while it applies. Keep
the purchase action available after free sessions run out. All normal account,
IP, provider and concurrency limits continue to apply to free usage.

## Interface language

Use the saved interface-language choice first, then the first supported system
language, then English. Keep this preference separate from the audio/caption
translation target. Use the shared target list in `src/ui-languages.ts`.

Interface text belongs in the bundled `src/locales` catalogs. Do not call a
translation provider to render controls. Keep English as the fallback for
missing messages. Update visible labels and accessible names together, use
`Intl` for displayed dates, numbers and currency, and support Arabic RTL layout.
Native language names stay readable in the selector in every locale.

Changing language must update the existing controls without reloading playback,
claiming another session, restarting translation, or resetting forms. Never
localize user text, media titles, transcripts, chat, URLs, API property names,
role identifiers or submitted values. Mark only application-owned copy. Use the
shared DOM bindings for dynamic labels so changing language preserves node
identity, focus, caret and scrolling. A manually updated element must not be
replaced with an earlier bound message during a later language change.

# Interface changes

Follow [the UX and accessibility baseline](docs/ux.md).

Never scroll or focus in response to captions, chat, polling, rendering, or
playback updates. Preserve the user's scroll position, focus, caret, and browsing
page. Native controls, accessible names, keyboard access, visible focus, and
non-disruptive screen-reader status messages are required by default.

Only explicit navigation, dialog closing, or keyboard reordering may move focus;
use `preventScroll: true` for focus restoration. Verify affected behavior in a
browser as well as running the relevant tests and builds.

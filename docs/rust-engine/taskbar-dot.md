# Persistent taskbar notification dot

The desktop's existing native app feed drives a persistent app-wide badge when
there is unread user mail or a nonzero existing attention summary (questions,
docket attention, unseen mentions). Unread routine, urgent and failure mail are
already present in the complete notice inventory; no new counter or poll exists.
Notification preferences govern interruptions and do not hide this indicator.

Windows uses a red dot with the tray indicator's light rim as an overlay icon on
each live app window. New windows immediately receive current state. Focus does
not clear it: the last unread/pending item must resolve. An unchanged feed avoids
native writes. macOS uses a dock bullet; Linux uses its available badge API with
presence represented by one, clearing with zero. Unsupported badges are best effort.

The existing `TaskbarAttention` pulse remains separate: only new attention items
pulse their owning org's window, with its existing focus/dedup policy. The badge
adds ordinary unread mail without changing those pulse rules or the tray count.

`tests/taskbar-badge.test.mjs` covers the shared app-feed projection, transitions,
window lifecycle and platform adapters. `taskbar-badge-native.cjs` applies and
clears the real Windows overlay API on a hidden synthetic window, then captures
an explicit synthetic before/dot/cleared comparison of the actual bitmap. It
does not claim to capture Windows taskbar pixels or use the installed app.

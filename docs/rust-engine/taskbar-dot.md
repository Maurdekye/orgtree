# Persistent taskbar notification dot

The desktop's existing native app feed drives a persistent app-wide badge for
urgent mail, open questions, docket attention flags and unseen mentions only
(user 2026-10-19 16:51–16:55Z, replacing the earlier unread-mail rule). Ordinary
unread mail and standalone terminal failures do not count. Failure mail counts
when the engine's existing urgent-or-mention qualification is true, carried as
the notice's `attention` boolean independently of its toast kind. Badge and
menu share `isTaskbarAttentionNotice`; no new counter or poll exists.
Notification preferences govern interruptions and do not hide this indicator.

Windows uses a standalone red circle with real alpha antialiasing and no white
ring or grey halo (user 2026-10-19 17:10Z). Each physical raster is sampled
separately at 100/125/150/175/200/250/300/400% DPI. Electron decodes straight-alpha
PNG representations; the raw bitmap helper uses premultiplied BGRA. The tray
icon retains its existing artwork. New windows immediately receive current state. Focus does
not clear it: the last qualifying item must resolve. An unchanged feed avoids
native writes. macOS uses a dock bullet; Linux uses its available badge API with
presence represented by one, clearing with zero. Unsupported badges are best effort.

The existing `TaskbarAttention` controller owns both native effects. Its
`updateInventory` and `applyBadge` methods delegate persistent overlay/platform
writes to `TaskbarDot`; its original `set` and `focused` paths retain per-org
arrival pulses and their focus/dedup policy. Ordinary unread mail adds neither
a badge nor a menu entry, without changing the tray/toolbar counts. There is
one host controller, one existing app feed, no second reader or poller. The
badge adapter caches native writes, not a second pending-attention counter.

Jump-list row types and the pure inventory projection are named
`TaskbarAttentionItem` / `taskbarAttentionItems`; neither may shadow the existing
controller class or its host variable. Full root `npm run typecheck` is required
for host changes; changed-module checks cannot validate host import resolution.

`tests/taskbar-badge.test.mjs` covers the shared app-feed projection, transitions,
window lifecycle and platform adapters. `taskbar-badge-native.cjs` applies and
clears the real Windows overlay API on a hidden synthetic window, then captures
an explicit synthetic before/dot/cleared comparison of the actual bitmap. It
does not claim to capture Windows taskbar pixels or use the installed app.
The native smoke validates PNG decoding and premultiplied pixels at
100/125/150/200%, then captures those actual representations on light, dark
and grey backgrounds. This proves the supplied image data, not a real monitor's
Windows taskbar rendering at each DPI.

While the inventory contains waiting items, the Windows custom jump-list
category is **Needs attention**, replacing **Recent**. Every urgent mail,
open question, attention flag and unseen mention supplies one entry, including
failure mail with an urgent flag or user mention. Ordinary unread mail never
replaces Recent; banner preferences do not hide qualifying items. Home and New org remain fixed actions.
Windows controls how many entries it displays, and can disable custom
categories in its privacy settings. The app supplies the complete list.
Mail/question entries use the mail outline; flags use a ticket; mentions use @.
No titles or bodies are placed in launch arguments: only an org and opaque
notice ID, encoded as one validated argument. Cold and second-instance clicks
use a held event delivered to the org's window and revalidate the live item.

**App settings > Runtime > Notifications > open questions** selects **focus
the agent desk** (default) or **open questions as mail**. Desk focus first
raises an existing pin or separate desk window, otherwise uses the normal
desk focus destination. Mail goes to the exact inbox row; tickets open their
ticket; mentions focus their author. Banner preferences do not gate clicks.
The ordinary recent-org list returns after the pending set clears.

The engine notice inventory now exposes the already-counted unseen mention
markers using the same live-agent filter and duplicate-mail exclusion as
`attention_count`; no new attention state is written. Streaming refinements
keep the marker identity, while a new mention or agent generation changes it.

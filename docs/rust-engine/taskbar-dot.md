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

The existing `TaskbarAttention` controller owns both native effects. Its
`updateInventory` and `applyBadge` methods delegate persistent overlay/platform
writes to `TaskbarDot`; its original `set` and `focused` paths retain per-org
arrival pulses and their focus/dedup policy. Ordinary unread mail adds a badge
without inventing a pulse policy or changing the tray/toolbar counts. There is
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

While the inventory contains waiting items, the Windows custom jump-list
category is **Needs attention**, replacing **Recent**. Every unread mail,
open question, attention flag and unseen mention supplies one entry; ordinary
mail counts even with banners off. Home and New org remain fixed actions.
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

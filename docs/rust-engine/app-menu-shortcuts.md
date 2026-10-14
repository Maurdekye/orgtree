# Main menu, header and function keys

User requests on 2026-10-14, docket
`app-level-menu-order-settings-usage-usage-histor`:

- The shell's app menu orders its existing entries App settings, Usage, Usage
  history. Their labels, icons and destinations are preserved. The tray does
  not offer this group. The legacy header gear opens org settings, not app
  settings, so it is not this group.
- The main ShellHeader orders its current-org buttons Inbox, Work (Docket),
  Presentations, Org settings. The agent DeskChat toolbar is unchanged.
- F1 opens app Settings (`AccountsPanel`). F2/F3 use the existing Usage and
  Usage history actions. F6-F9 reuse the four main-header current-org actions;
  F9 opens organization settings, unlike F1.
- Shift+F1 uses the app menu's New window action; Shift+F3 uses its Create
  organization action. Shift+F2 opens that same menu and its Open organization
  submenu with keyboard focus on the filter (when present) or first org.
  Repeating Shift+F2 refocuses an already-expanded submenu. Its existing
  arrow-key and Escape behavior remains; selection uses the same callback.
- F4 switches Canvas/Attention. From a centred app/org panel it closes the
  panel and chooses Canvas; pinned/detached surfaces keep their content and
  placement. There is no org canvas destination on Homepage/Create.
- F5 clicks the actual main-header Refresh button, preserving its callback
  and availability. Its current action is renderer reload; no engine restart
  or quota refresh is introduced.
- F10 opens only the local safety latch. A second F10 does nothing and cannot
  extend its deadline. For a persistently halted org it is a no-op; Release
  remains mouse-only. F10 never calls killAll or releaseKillswitch.
- Shift+F10 uses the existing killAll request immediately, without confirmation
  or the mouse arming delay, whether locally armed or already persistently
  halted. A synchronous busy guard admits only one in-flight request. Mouse
  Halt all retains its 500 ms arming delay and all existing response handling.
- The local latch closes after five seconds instead of six. Mouse or F10
  arming starts that timer; a press at 4.9 seconds still works. Unmount and
  re-latching cancel its timers.

## Shortcut custody and defaults

`shell/appshortcuts.ts` exports `APP_FKEYS` as the single data table used by
the matcher and the Settings keyboard explainer. `App` installs one capture
listener on its own window. It takes only bare assigned function keys plus
Shift+F1/F2/F3/F10; other modifier combinations (Alt+F4, Ctrl+F4, etc.) are
untouched. A held key consumes its default without repeatedly invoking an
action. It does not listen in popped-out panel documents.

Coordinator rulings 10:51/10:52/10:53 UTC explicitly require the keys to work
in input, textarea and contenteditable fields. This differs intentionally
from toast Undo, since composers are usually focused. The source audit found
no embedded-editor function-key binding to except. Capture prevents the
assigned key's default and stops ordinary widget/menu key handlers, including
the keyboard context-menu path on Shift+F10. Native OS accelerator suppression
and real-device behavior still require verification; synthetic DOM dispatch
alone is not proof that Windows never activates a native menu.

Audited [Electron 44.2.0 default role accelerators](https://raw.githubusercontent.com/electron/electron/v44.2.0/lib/browser/api/menu-item-roles.ts):
reload uses Ctrl/Cmd+R, DevTools Ctrl+Shift+I on Windows, fullscreen F11; none
uses F1-F10. The [Chromium browser table](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/chrome/browser/ui/accelerator_table.cc)
has Help F1, find-next F3, reload F5, pane-focus F6, caret browsing F7 and menu
focus F10. These browser UI defaults are not all Electron defaults; the
coordinator approved overriding them where they apply. Other chords remain.

## Verification recipe (not yet executed)

Under rig-opus's one shared-lock/contained batch, set temp/output to its C
scope and invoke `apps/desktop/renderer/tests/appkeys-check.mjs` with arguments
`<combined root> <C output> <shared node_modules> <mode> [suite ...]`:

1. `typecheck`: root typecheck exit 0.
2. Set `UI_APPKEY_BASE` to the exact parent before these source commits in the
   combined batch; `tests appkeys` retains the new table/fixtures but overlays
   baseline App, KillSwitch and menu. Expected 10 tests: four controls pass,
   six behavioral failures (menu order, five-second timeout, F10 arming, two
   emergency states, actual App routing/header). The actual totals must be
   reported from raw logs, not assumed from this recipe.
3. Unset the base. `tests appkeys killswitch shellviews header_docket_glow`:
   every check passes, none skipped. Covers actual App current-org navigation,
   text-field capture, modifiers, deadline and 4.9-second press, immediate
   emergency halt, duplicate admission, and F10 never halting or releasing.

Source and fixtures only; no app packaging, installation, live data/provider
operation or push. Coordinator reviews and integrates the exact checked tip.

## Added Shift-key checks (not yet executed)

The user added Shift+F1-F3 at 11:06 UTC. `APP_FKEYS` contains all three rows,
so the existing explainer consumer automatically lists them. `appshiftkeys`
has four focused checks: shared matching, two submenu/focus variants (with
and without a filter), and actual App new/create-window/submenu callbacks
while typing. For its separate red control, set `UI_APPKEY_BASE=3d716fe`
(or the exact pre-addition batch parent) and `UI_APPKEY_TABLE_BASE=1`, then
run `tests appshiftkeys`. The runner overlays the old App, menu, KillSwitch
and function-key table; expect four behavior failures. Unset both variables
for green `tests appshiftkeys appkeys killswitch shellviews header_docket_glow
shortcuts`, with zero failures/skips, plus root typecheck. The original
ten-case red recipe keeps the new table unless `UI_APPKEY_TABLE_BASE` is set.

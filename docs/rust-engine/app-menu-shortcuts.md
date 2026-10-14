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
  Updated user ruling 17:58 UTC: F1-F3/F6-F9 close the exact target if already
  open, including pins behind another surface, through the same close callbacks
  as the close button (transient-tab/jump cleanup and tree refresh included).
  A shortcut-opened panel returns focus to its connected opener on re-press.
  Mouse open/raise behavior is preserved. Different targets stack as before;
  closing one leaves its sibling mounted.
- Shift+F1 uses the app menu's New window action; Shift+F3 uses its Create
  organization action. Shift+F2 opens that same menu and its Open organization
  submenu with keyboard focus on the filter (when present) or first org.
  Updated user ruling 17:58 UTC: repeating Shift+F2 closes the menu and submenu,
  returning focus to the menu button. If only the parent menu is open, it opens
  the organization submenu. Its existing
  arrow-key and Escape behavior remains; selection uses the same callback.
  User 18:02 UTC: "No, leave windows" — Shift+F1/F3 keep their native window
  opening/focusing behavior and do not become window-close shortcuts.
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

## Toggle correction recipe (execution pending)

Ticket `pressing-an-f-key-shortcut-again-closes-the-menu`, source base `0f8638f`.
Run through rig-opus's next shared-lock/contained batch and C output. The existing
`appkeys-check.mjs` supports the new `appkeytoggle` suite without a runner change.

- Red: set `UI_APPKEY_BASE=0f8638f` (or the exact pre-correction batch parent),
  leave `UI_APPKEY_TABLE_BASE` unset, run `tests appkeytoggle appshiftkeys`.
  The new fixtures/table remain; exact baseline App/menu/KillSwitch are overlaid.
  Expected appkeytoggle: nine behavioral failures, one table control pass;
  appshiftkeys: two submenu toggle failures, two unchanged window/matcher controls.
  Confirm failure names from raw output; these counts are a recipe, not evidence.
- Green: unset both base variables; run `tests appkeytoggle appshiftkeys appkeys
  killswitch shellviews header_docket_glow shortcuts`, then root `typecheck`.
  The seven actual-App panel cases each open, hold (repeat), close, return focus,
  and reopen. Additional cases check stacking, keyboard close behind a sibling
  pin versus mouse raise, and shared explainer text. Shift+F2 tests cover short
  and filtered org lists, hold, close/focus, reopen, arrows/Escape, parent-only
  opening and original selection. Existing window controls remain unchanged.

Native device keys and detached-panel native-window closure are not newly
measured by these renderer tests. No engine/provider/live operation is needed.

Round439 fixture correction: F6/F9 close requests use the existing TreeReadPacer,
so counting an HTTP read after microtask flush alone was premature. Their checks
now use the fake clock in a visible document, settle opening reads, then advance
the shared TREE_MIN_GAP_MS after closing. Product source is unchanged. The other
eight new cases and shortcuts suite passed in the initial standalone run; the
two corrected cases still require rig-opus's green/red execution.

Round439 follow-up at combined `04b83de`: green 73/73 and root typecheck exit 0.
The red run exhausted its contained process before reporting tests: comparing a
live jsdom element with null made the failure reporter inspect the DOM graph.
The seven null checks in appkeytoggle/appshiftkeys now compare a boolean, with
identical closure expectations and no product changes. Rig's diagnostic edits
to built red bundles yielded the predicted nine toggle and two submenu failures,
with three controls passing; the committed fixup still needs red/green execution.

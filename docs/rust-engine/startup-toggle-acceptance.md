# Run on startup: reboot acceptance and tray checkmark repair

Measured on Windows, 2026-10-11, installed 4.2.0-alpha.10 (`1fcce40`).
The user changed the switch and rebooted; the agent only inspected live state.
The tray fix below is separate source work and was not installed during these
observations.

## Reboot behavior

| Stage | User observation | Independent read-only measurement |
|---|---|---|
| OFF reboot, then manual launch | No Orgtree services started before manual launch; Hubchat did. | 15:30Z: both production tasks disabled/not running; HKLM `RunOnStartup=0`; saved `startAtLogin=false`; production login entry absent. Desktop 32816 in Session 1 directly parented engine 33884 in Session 1, which parented mailhub 34944. No helper or Session 0 Orgtree process in the snapshot. |
| First ON click, no retry | Native tray checkbox stayed unchecked after accepting UAC; no error shown. | 15:33:22Z: both tasks enabled/Ready; registry value 1; saved preference true, last write 15:32:25.0783151Z; production HKCU Run entry restored. The first click successfully persisted ON. |
| ON reboot, no second click | Engine running by sign-in; desktop eventually auto-started; tray checkbox checked. | 15:52:22Z: both tasks enabled/Running; registry 1; saved preference true; production login entry present. Boot host 3860 -> engine 11976 -> mailhub 33104 in Session 0; helper 9224 and desktop 38276 in Session 1. |

The pre-manual-launch absence during OFF boot is user-observed, not an agent
process snapshot. Existing legacy entries were also inspected: the enabled
Recovery Desktop task has no triggers; the old deploy/ensure/hard-stop tasks
are disabled; a stale development Run entry points to a missing executable;
neither Startup folder has an Orgtree entry. Nothing was changed by these checks.
The sandbox denied task/process inspection, so the approved read-only tool
escalation was used. Default-token HKCU inspection missed the stale development
entry; the full-token result above supersedes that partial result.

## Tray defect and repair

The screenshot identified the control as the **native tray context menu**, not
the renderer's Settings checkbox. The OS/application differential proves a
stale checkmark after a successful first ON write. It does not establish the
exact Windows menu-event ordering or whether the pictured menu was the original
or a reopened object.

`rebuildTray` deliberately avoids replacing an open native menu. Its early-return
path refreshed updater, engine and mailhub items, but omitted the startup
checkbox. After a refresh creates a menu from the old saved value while UAC is
pending, completing the write while that menu is open leaves its checkmark
unchanged. Menu-show previously did not resynchronize it either. A second click
on that stale value can request the value already saved, so the task writer
correctly does not ask for UAC again. This is a reproduced source-level failure
path consistent with the observations; exact original native timing remains
inferred.

The repair gives the startup item a stable id and refreshes its checked state
from committed preferences before the open-menu return. Menu-show also invokes
that in-place refresh. The active Menu object is preserved. Rejection uses the
existing error path and refreshes the checkbox back to the committed value.
The startup task writer, elevated script, permission rules, registry writes,
saved-setting contract and renderer are unchanged.

## Isolated verification

`tests/startup-tray.test.mjs` transpiles and executes the actual `rebuildTray`
closure from `index.ts` with native-menu dependencies replaced by test doubles.
It does not copy the refresh implementation, start Electron, invoke UAC, modify
tasks, or touch live settings. Its controlled async writer models the normal
refresh occurring while the startup write is pending.

- Before the fix on `1fcce40`: six cases, **five failed, one passed**. The failures
  cover completed ON/OFF with the current menu open, rejected changes in both
  directions, and reopening a stale menu. Closed-menu reconstruction passes.
- After the fix: all **six passed**. The tests also assert that the open Menu is
  not replaced and that one click invokes the writer once.
- Focused new/startup, tray-dot, traylist and traylist-wiring suites: **25 passed**.
- Existing engine-restart tray-refresh wiring check, selected by test name:
  **one passed**; no engine restart test executed.
- Disruptive-policy scanner: **six passed**. `npm run typecheck` passed.
- `git diff --check` passed. No engine code changed, cargo/app/installer build,
  live restart, kill, or live settings mutation was performed.

Logs: `D:/orgtree-work/tests-astra/startup-tray-before.log`,
`startup-tray-after.log`, `startup-tray-focused.log`,
`startup-tray-engine-wiring.log`, `startup-tray-policy.log`,
`startup-tray-typecheck.log`. Original user screenshot:
`D:/orgtree-work/startup-toggle-evidence/on-first-click-tray.png`.

The repair is verified at the main-process menu-model boundary. Native Windows
tray repaint/UAC event timing after packaging has not been tested, nor has a
rig run been performed for this patch. The existing installed code passed the
OFF/ON boot observations; that does not prove the newly committed visual repair
is deployed or accepted in a running build.

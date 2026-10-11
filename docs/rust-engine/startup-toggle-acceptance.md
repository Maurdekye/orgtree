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

## Delay after the first click, and the pending state (alpha.11)

On the installed alpha.11 (`cedbe0d`, which contains the repair above; checked
read-only in its `app.asar`) the user first reported that the tray checkmark
still did not change after the first click. At 19:55Z they corrected that: "it
does change, just after a few-second delay".

**Likely cause.** The checkmark is the saved value, and the value is saved only
once the change has finished: reading the tasks, the permission prompt, the
elevated change, and reading the change back. Timings on this machine come from
a NON-ELEVATED STAND-IN: a read-only harness that runs the real
`runonstartup.ts` / `runasadmin.ts` code. The live tasks were only read, and the
elevated step ran without `-Verb RunAs`, so there was no prompt and no
elevation.
- reading both tasks: 0.35–0.38 s, once before the prompt and once after it;
- the launcher and change script: 1.59–1.64 s; the script alone 0.41–0.62 s;
  the launcher alone 0.24–0.27 s;
- `Start-Process -Wait` alone adds about 0.8 s over `WaitForExit()` (1.54–1.61 s
  vs 0.77–0.83 s with a trivial child): Windows PowerShell 5.1 checks its job
  object about once a second.

In that stand-in, the save comes about 2 s after the point where Yes would be
clicked. Nothing was measured after a real Yes: creating the elevated process,
and how long `-Wait` takes on an elevated child, may differ. A menu reopened
before the save shows the old checkmark, with nothing saying a change is still
running. Nothing stopped a second click, or the Settings switch, from starting a
second change and a second permission prompt meanwhile.

Two things support the change's duration as the cause: the source (every time
the menu opens it reads the saved value) and the user's report that the
checkmark changes a few seconds later. The native redraw itself was not
measured.

**Repair (lead-astra's ruling, 2026-10-11 20:00Z).**
- While a change runs, the tray item is disabled and reads **Run on startup
  (changing…)**; the checkmark stays the saved value.
- `changeRunOnStartup` allows one change at a time, from the tray or Settings.
  The pending state is set before anything asynchronous and cleared in `finally`
  on every outcome. A second request is refused with "Orgtree is still changing
  "run on startup". Try again once that has finished." and leaves the running
  change's pending state alone.
- An open menu is never replaced or forced closed. A built menu's labels cannot
  change, so a menu that was open when a change began or ended is rebuilt once
  it closes.
- The shared elevated launcher is unchanged on purpose: timings measured without
  elevation do not prove the same saving with an elevated child.

**Verification.**
- `tests/startup-tray.test.mjs` now runs the real `changeRunOnStartup` together
  with the real `rebuildTray`, with stand-ins for the task calls. **13/13 pass.**
  - Against `78ad4fd` the same file fails **11 of 13**: no pending label, no
    disabled item and no refusal. The two that pass there are the reopen-resync
    and closed-menu cases.
  - The first version of this change refreshed the tray before its `try`
    block. Against it, the tray-error case fails: one failed refresh left the
    guard set, so every later request was refused. Review caught this, and the
    refresh now runs inside the `try`.
- Before that one-line move, the desktop tests that read this source passed
  135/135 across 8 files (`startup-tray`, `engine-restart`, `icon-assets`,
  `themes`, `traylist-wiring`, `updater-wiring`, `updater`, `run-on-startup`).
  After it, only `startup-tray` and the typecheck were rerun.
- `npm run typecheck` passes.
- Logs: `D:/orgtree-work/tmp/rig-opus/startup-tray-after2.log`,
  `startup-tray-before-78ad4fd.log`, `startup-tray-before-HEAD.log` (the first
  version), `related-tests.log`, `typecheck.log`. Timing harness:
  `D:/orgtree-work/tmp/rig-opus/startup-timing/`.

**Limits.**
- **Not measured natively:** what the user sees in the menu. Agents run in
  Session 0, under the background engine: `UserInteractive` is false and there
  is no shell tray or visible desktop.
- An isolated Electron 44.2.0 app (`D:/orgtree-work/tmp/rig-opus/tray-proof/`)
  ran the real closures with a real `Tray` and `Menu`:
  - Windows refused the tray popup's focus request (no `menu-will-show`).
  - The same current tray menu, opened with `Menu.popup`, did fire
    `menu-will-show` and `menu-will-close` natively.
  - Neither UI Automation nor `EnumWindows` could see its window from Session 0,
    so no native click or screenshot was possible.
- **A menu left open while a change ends:** its checkmark and enabled state are
  updated in place. Electron cannot relabel a built menu, so until it is closed
  and reopened it can still say "(changing…)". Whether the native menu redraws
  the in-place change before the pointer moves over the item is not measured.
- **To check on the next alpha:** right-click the tray, click Run on startup,
  click Yes, then right-click again at once. Expected: greyed out "Run on
  startup (changing…)". A few seconds later, right-click again. Expected: the
  new checkmark and the normal label.

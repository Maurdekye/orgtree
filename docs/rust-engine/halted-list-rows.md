# Halted agents in shared list rows

The user requested halted rows carry the same state icon, colour, elapsed
clock and last status line as every other state, with one canonical row height
(2026-10-14 10:55Z). This changes presentation only, on local rust-engine.

## Shared implementation

AgentTray is used by the canvas Agents List, Attention agents drawer and Quick
chat superior picker. Their main line calls TrayStatus. Halt previously returned
plain HaltStatus before the structured state row; it now renders the existing
StopIcon with var(--bad), taken from the far-canvas halted icon, a Halted label
and the shared ago() clock subscribed to the existing global age clock.

A settled halt uses halt.at; an older record without it uses requested_at.
Halting preserves its Halting label and uses requested_at. An absent timestamp
shows an em dash, never last-turn or status-report time. The current engine
writes both at and requested_at in its settled halt record. Execution state,
halt controls, duration source and scheduling are unchanged. Canvas desk headers
and near-zoom cards show `Halted <duration>`; far-zoom cards show only the stop
icon. Accessible text can retain “Halted for <duration>”.

Precedence matches the current canvas: an explicit durable halt wins a usage
freeze, including agents carrying both. Usage-frozen agents without a halt keep
their current snow/frozen presentation. No new colour or icon is introduced.

AgentTray already chose last_status, or prev_status when last_status is absent.
It still renders the same status text, references, independent report age and
stale styling. Every row now reserves that summary line even when no summary
exists, using an aria-hidden nonbreaking-space with no invented status text or
age. Its explicit line-height/min-height supplies the same second-line geometry.
Summary clipping and main-line keyboard/click handling remain unchanged.

## Verification hand-in

Five new focused renderer tests cover halt icon/label/date, legacy/missing dates
and halting, ticking on unchanged props, explicit-halt/usage-freeze precedence,
and status/previous/empty-line rendering plus one activation. The old haltcontrol
assertion is updated for the new tray clock/icon; it still checks all four status
surfaces and halt precedence. Focused green also runs haltcontrol, usagefreeze
and agentstray regressions. Red runs the same five new tests with only this item's
presentation hunks reversed in memory in current combined source. It must fail
on assertions, not infrastructure. No historical files overwrite batch work.

The real AgentTray browser fixture measures 13 rows across active, halted,
halted/no-summary, halted/previous-summary, halt+freeze, usage freeze, idle,
idle/no-summary, blocked, done, queued, compacting and retired. The matrix has
24 cases: red/green, dark/light, canvas/drawer/superior host contexts, 320/480px
host widths. Green requires equal row heights within 0.5 CSS px, existing halt
icon/label/colour/age, retained summary and separate age, blank reserved line,
halt-over-freeze precedence and no browser errors. Red reproduces the missing
halt icon and shorter-row geometry. These are actual shared rows in representative
host wrappers, not a full installed-app/picker navigation test.

Use combined repo paths under rig-opus's shared lock and contained batch:

    node tools/halted-list-verify.mjs focused <repo> C:/orgtree-build/rig-opus/halted-list
    node tools/halted-list-verify.mjs browser-build <repo> C:/orgtree-build/rig-opus/halted-list
    # HALTED_LIST_OUT = the C directory above
    # HALTED_LIST_EVIDENCE = D:/orgtree-work/rig-opus-halted-list-evidence
    python tools/halted-list-proof.py

Run the root typecheck with the normal batch command. Dependencies are read in
place from the existing real D node_modules; HALTED_LIST_DEPS can override that
root without installing/copying/linking anything. Runtime tests and geometry
are pending the batch. Syntax and whitespace checks alone claim neither.
No app build, install, push, live write or device check.

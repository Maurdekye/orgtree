# Rainbow mode under Custom

Settings > Appearance renders Rainbow mode only when its hidden gesture has
already revealed it and the selected visual theme is Custom. All seven preset
themes omit the complete row. The Custom colour picker's reveal gesture and
the animation remain unchanged.

Selecting a preset does not change the saved `rainbowTheme` preference:
`revealed`, `enabled` and `epoch` survive. Returning to Custom restores the
toggle with its previous enabled state, including after settings remount.
This preserves the existing preference behavior; rainbow already runs only
for Custom accents. Popouts and agent colours are unaffected.

User requirement: 2026-10-14 23:24:59UTC; retained-preference scope ruling:
coordinator-opus, ticket `rainbow-mode-toggle-only-shows-when-the-custom-t`.

Source-only verification uses `rainbowsetting.test.tsx`: seven native
preference-backed preset absence cases, Custom with both enabled states,
unrevealed Custom, and both saved states through all presets and back plus
remount. Absence checks compare booleans to avoid formatting React DOM trees.
Round 445 (rig-sol-b, 2026-10-15) measured all twelve cases plus the existing
Custom picker control passing. Final `37b00ff` includes the fixture correction
that initializes native preferences from `DEFAULT_PREFERENCES`; the affected
combined run passed 35/35 (22 docket cases plus these 13), with no skips or
cancellations. With exact preceding `7eb572a` theme code, the final red executes
nine genuine assertion failures and four passing controls. Root typecheck has
zero errors; strict renderer/tests retain their exact 29/830 baseline
diagnostics with zero added or removed after line/column normalization.

Canonical logs are `batch-445/logs/final-fixture-tests.log`,
`final-rainbow-red.log`, `tc-root-final.log` and `tc-tests-final.log`.
The author inspected the saved logs and compared diagnostics to baseline.
The batch-wide renderer result remains 3519 passes, 88 attributed baseline
failures and four skips; the skipped cases were not executed. No installed-app,
real preference, provider or device verification is claimed.

Inside the assigned rig's normal machine lock and kernel Job, use the existing dependency
root and distinct empty output directories under its authorized C scope:

```text
node tools/rig/rainbow-toggle-check.mjs red <dependency-root> C:/orgtree-build/rig-sol/<round>/rainbow-red
node tools/rig/rainbow-toggle-check.mjs green <dependency-root> C:/orgtree-build/rig-sol/<round>/rainbow-green
```

The runner uses tip tests in both runs and substitutes exact base `themes.tsx`
in the red bundle, leaving source and dependencies in place. Including the
existing picker control, measured red is nine failures/four passes and green
is thirteen passes. Outputs use the assigned rig's C scope, and dependencies
resolve without source copies or junctions. `--test-force-exit` lets each
completed test file release its process. The original runner hung after the
picker control, before any Rainbow case; both interrupted, accidentally
overlapping runs are preserved and excluded from acceptance. Corrected runs
were sequential. The checked implementation was integrated locally at
`8d4c570`, intended for `4.3.0-alpha.5`; no build or installed result is claimed.

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

Source-only verification handoff adds `rainbowsetting.test.tsx`: seven native
preference-backed preset absence cases, Custom with both enabled states,
unrevealed Custom, and both saved states through all presets and back plus
remount. Absence checks compare booleans to avoid formatting React DOM trees.
The new twelve-case suite is prepared for rig-sol, not yet executed by its
author. Expected red against the preceding `7eb572a` implementation is nine
assertion failures and three passes; the tip should pass all twelve. Run the
existing Custom picker suite as a preservation control and root typecheck.
No installed-app, real preference, provider or device verification is claimed.

Inside rig-sol's normal machine lock and kernel Job, use the existing dependency
root and distinct empty output directories under its authorized C scope:

```text
node tools/rig/rainbow-toggle-check.mjs red <dependency-root> C:/orgtree-build/rig-sol/<round>/rainbow-red
node tools/rig/rainbow-toggle-check.mjs green <dependency-root> C:/orgtree-build/rig-sol/<round>/rainbow-green
```

The runner uses tip tests in both runs and substitutes exact base `themes.tsx`
in the red bundle, leaving source and dependencies in place. Including the
existing picker control, expected red is nine failures/four passes and green
is thirteen passes. Expected counts are not measured results. Outputs use C,
and dependencies resolve without source copies or junctions.

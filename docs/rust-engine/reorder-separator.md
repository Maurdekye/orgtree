# Reorder insertion separator

Sibling drag preview uses an accent separator instead of a circle (user
2026-10-13 18:58UTC). Tree rows show a vertical line in the insertion gap,
16 world pixels outside the end card for first/last insertion. Ring previews
keep the existing angular slot and orient the separator through the eye centre.
The separator is one node height long and uses the existing two-screen-pixel
accent stroke; it never receives pointer events.

`reorderpreview.tsx` owns marker geometry and the tree's visual-only slot. Ring
request selection remains `ringReorderSlot`; tree drop selection, op/animation
and Undo remain unchanged. The tree preview mirrors the drop's current x rule.
Source scope is only drag-preview preparation/presentation, not the engine.

## Ring endpoint gutter (2026-10-16)

Ring ends use the coordinator's 16-world-pixel end gutter, measured beyond
the axis-aligned card's extent projected onto the endpoint tangent. This
applies before the first and after the last remaining sibling on any ring,
including a singleton. The marker stays at the endpoint's radius. Its angular
offset is `asin((tangentExtent + 16) / radius)`, bounded to a quarter turn for
degenerate undersized geometry. The direction follows the selected end.

The open arc still selects the canonical before/after request, but never
determines the endpoint marker distance. Between-sibling midpoints and row
geometry remain unchanged. The original unused-arc midpoint placed the marker
155-415 world pixels outside the fixture cards instead of 16.

Independent RED at `0436016` executed 16 tests: eight endpoint gutter failures
and eight preservation passes, no skipped/cancelled tests, exit 1 in one
second. The request assertions passed before every gutter failure. Fixtures
cover both ends at radii 260 and 490, singletons, unequal occupied gaps and
the angle seam.

Independent GREEN at `7cc3729` passed all 16 tests, no skipped/cancelled tests,
exit 0 in two seconds. Root typecheck exited 0 in two seconds. The source
and test files in this final receipt commit are byte-identical to that tip.
Between-agent, row, radial and canonical request controls passed.

The native Electron visual phase exited 0 in ten seconds, with successful
JSON and four nonempty 1000x700 PNGs. Both rig-sol-b and the author opened
every image: the separator sits just outside the correct endpoint card for
inner/outer rings, before first and after last. The measured tangent gutters
range from 15.999999999999957 to 16.000000000000057 world pixels. The receipt
is `ring-end/visual1/visual.json` and images `captures/ring-end-0.png` through
`ring-end-3.png` in rig-sol-b's owned output. The synthetic page retained
Electron's missing-CSP warning in the receipt. These schematic fixtures use
the production slot and marker; they do not verify an assembled/installed app
or physical dragging. No app build or live operation was performed.

The contained rig phase uses `tools/rig/ring-end-preview-check.mjs` with
`tests` or `visual` and the caller's owned C: output directory. Run it only
under the shared FIFO lock and a kernel Job. The visual mode uses production
slot/marker helpers on schematic cards and captures both ends of both radii.

Historical separator verification: typecheck and all 58 focused tests passed across the geometry/component suite,
existing move/Undo regression and retired display checks. Synthetic Electron44.2.0
rendering passes: 12 inspected charcoal/light screenshots show first, middle
and last markers in both layouts, with no console errors. These use production
marker/slot helpers on schematic cards; no assembled/installed/native-input
acceptance is claimed. The initial visual harness's nonzero-width visibility
predicate was corrected for vertical SVG lines; product source stayed unchanged.

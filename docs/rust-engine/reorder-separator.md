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

Typecheck and all 58 focused tests pass across the geometry/component suite,
existing move/Undo regression and retired display checks. Synthetic Electron44.2.0
rendering passes: 12 inspected charcoal/light screenshots show first, middle
and last markers in both layouts, with no console errors. These use production
marker/slot helpers on schematic cards; no assembled/installed/native-input
acceptance is claimed. The initial visual harness's nonzero-width visibility
predicate was corrected for vertical SVG lines; product source stayed unchanged.

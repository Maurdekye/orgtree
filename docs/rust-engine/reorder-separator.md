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

Focused geometry/component tests and tree/ring light/dark synthetic rendering
are prepared; execution is pending the shared proof queue. No installed/native
acceptance is claimed.

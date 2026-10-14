# Superior picker root row

The shared Quick chat superior picker places the filter first, then the
selectable `top level` eye row inside the same Agents List. Its root has
depth zero; every agent retains its host ordering and gains one visual
depth, so top-level agents appear below the root. Existing row contents,
live-agent eligibility and selection callbacks remain the shared tray's.
This applies to every window/position hosting Quick chat.

Filtering trims whitespace and matches names without case sensitivity.
The root is a matching choice when its label matches (including an empty
filter). Agent matches retain their existing ghost ancestor chain, with a
ghost root added above it when the root label does not match. Arrow keys
skip ghosts; Enter selects only a matching choice. With no matches there
is no root row or keyboard choice, and Enter leaves the picker open.
Mouse activation follows the existing row-selection behavior.

`AgentTray.leadingRows` supplies this host-owned root after the filter;
ordinary Agents Lists do not supply it and retain their existing depths.
No engine, hierarchy, funding or account behavior changes.

The user requested this on 2026-10-14 at 10:54:49Z. Five added cases in
`apps/desktop/renderer/tests/quickchat.test.tsx` cover DOM row placement,
depths and current highlight, root-only label filtering, filtered ancestor
context, empty results, and keyboard/mouse root selection. The existing
host-order/ghost-agent case remains. Red control is test-only commit
`b8cae04` on `2e3d287`; green is the final picker branch. Test execution
and rendered appearance remain pending the assigned rig-opus batch.

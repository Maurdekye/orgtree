# Streaming thought height

The live thought ribbon could collapse to an unreadable sliver when the
transcript filled. The user reported this on 2026-10-15 in the installed
67e811f Wonder Full build. Rig reproduced it on the requested base b77512f
without EPIC: crowded short, multiline and long thoughts all measured 8px
high in both themes. Their capped natural heights were 25.390625px,
60.171875px and 320px. The short and multiline roomy controls were readable.

The thought's `.reply-event` wrapper uses `display: contents`, so the
`.thoughtbody.live` element participates directly in the `.msgs` flex
column. Its `overflow-y: auto` removes the automatic minimum height. The
default flex shrink then crushes its content box to zero, leaving 8px of
padding. The fix sets `flex-shrink: 0` on `.thoughtbody.live` only.

Dim italic text, left border, font/line height, padding/margins, the 320px
border-box cap and internal scrolling remain unchanged. Sealed thinking
pulse, collapsed thought line and expanded non-live body do not match the
new selector. No feed behavior, store, sizing code or thought content changes.

## Verification

Test-only289740a was committed before the product fix. The native Electron
test renders the existing private ThoughtBody/ThoughtLine components (exposed
only by an in-memory test bundle) under real transcript CSS and reply wrapper.
It is a focused component/layout fixture, not the entire running desk/store.
Two themes × crowded/roomy × three live sizes and three other thought states
give 24 captures and geometry records. The hidden offscreen window uses an
actual 1000×700 content area; every capture waits two rAFs and 80ms.
Only generated local files are reachable; the profile is isolated in C.

Initial base red: EXIT1, all24 cases executed/captured. Owner inspected
crowded/roomy dark short PNGs and raw geometry; rig independently inspected
them too. Original receipts are retained under
`D:/orgtree-work/rig/rig-sol-b/evidence/streaming-thought-red`.
That initial harness also incorrectly expected a 328px outer long body
(the app uses border-box) and selected the expanded heading before its body.
Test-only6d4e7c7 corrects both; no product/assertion weakening. A corrected
base red and fixed green, plus control-geometry comparison, are required.
At this source hand-in those reruns remain pending.

Rig commands, from the source worktree under its shared lock/kernel Job:

```text
node tools/streaming-thought-verify.mjs red DEPS_ROOT C_OUTPUT_RED D_EVIDENCE_RED ELECTRON_EXE
node tools/streaming-thought-verify.mjs green DEPS_ROOT C_OUTPUT_GREEN D_EVIDENCE_GREEN ELECTRON_EXE
```

DEPS_ROOT is the existing real dependency checkout; no copies or junctions.
All generated bundle/profile outputs must be in the rig's authorized
`C:/orgtree-build/rig-sol-b/...` scope; evidence in `D:/orgtree-work/...`.
Red substitutes the exact b77512f stylesheet; green uses current CSS.
Expect corrected red to fail only the six crowded live cases, with all18
remaining controls passing, and green all24 passing. Compare all12 non-live
control measurements across red/green to establish unchanged geometry.

Source/whitespace and script syntax checks pass. No app build, install, push
or packaged-app observation is claimed. Final rig receipt must be recorded
on `streaming-thought-block-renders-squashed-to-a-sl` before coordinator hand-in.

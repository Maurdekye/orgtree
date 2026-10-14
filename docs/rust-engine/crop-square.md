# Logo crop square

User 2026-10-14 requested a crop square over the full fitted image, replacing
three sliders. `SquareCrop` is presentation only: it consumes the existing
oriented native PNG preview; original file bytes remain with `OrgPictureEditor`.
Save still sends the original bytes and `OrgPictureCrop`. Decoder, limits,
ownership, cancellation, removal and revision semantics are unchanged.

The square moves by pointer capture (mouse, touch or pen). Each corner resizes
against its opposite corner, projecting the drag onto a square and clamping to
the image and the existing 10% short-side minimum. Outside the square is dimmed.
The small 192 px live preview remains. Arrow keys move by 1% of the short image
axis; Shift + left/up shrinks, Shift + right/down grows around the center, bounded
by the image. Instructions and focusable, labeled handles provide keyboard
access. A cancelled pointer keeps its last visible crop and ends the gesture;
the existing Cancel button discards the entire edit. Other simultaneous pointers
are ignored (pinch is not implemented). Busy state and replacement previews end
the gesture. Touch handles have 44 px targets.

Native x/y are fractions of available top-left travel, not image coordinates.
`cropmath` converts those to image-pixel squares and back. Hubchat's desktop and
Android shared editor carries matching component/math/CSS in its own repository;
there is no cross-repository runtime dependency.

## Verification handoff (source only)

No author execution: all checks and captures are delegated to rig-opus under
the shared build lock and kernel Job. `cropmath.test.tsx` covers coordinate
round-trip, clamping, four opposite-corner anchors and keyboard bounds.
`cropeditor.test.tsx` mounts the actual Logo editor: four cases, including
pointer cancellation and unchanged save/cancel contracts. Same new file against
base 0f8638f should fail the first three tests and pass Cancel. Keep existing
`orgpicture.test.tsx` (preview selector now names the preview, since the full
image is also present). No base test source is replaced to manufacture a red.

`tools/crop-visual.mjs` takes explicit dependency/CDP/output environment paths,
requires CROP_JOB_CONTAINED=1 and C output. It loads the base editor via git show
for before captures, then the actual changed editor. Both themes have real
keyboard and pointer interaction assertions. Hubchat additionally captures a
390 px mobile layout and dispatches touch events. Synthetic native/HTTP replies,
not installed-app, OS chooser, native decoding or Android WebView acceptance.

# Responsive lists in moved windows

User report 2026-10-16: resizing a popped-out presentations or inbox window
through a Windows snap-group divider leaves its sidebar in the old state.
The shared `CollapsibleMailer` already observes its own reading box, rather
than a window resize event. The defect was the observation's document lifetime.

`MovableSurface` adopts the same DOM node into a new document and publishes
that document through `useSurfaceDocument`. `useNarrow` originally created a
global/main-window `ResizeObserver` and subscribed only to the unchanged
element, enabled flag and threshold. After adoption its observer was still
associated with the opener's rendering lifecycle. Real Electron reproduction
at baseline 705a12b with the same adopted node measured an 800px popout viewport
and reading box but no narrow state; content-only changes to 896px and 650px
also left the list wide. This establishes the cross-document observation gap;
it does not establish which Windows events the user's snap divider emits.

The hook now subscribes to the current surface document, constructs the
observer from that document's window, disconnects the old one and measures
immediately on transfer. The same path rebinds on return. This also means
width changes caused by snap/unsnap, maximize/restore or DPI changes do not
depend on the opener receiving a window event. The inclusive 896 CSS-pixel
threshold and inline opt-out remain. The list stays mounted: filters,
selection, paging, focus/overlay behavior and scroll storage are untouched.

Call-site inventory: organization gallery, modal agent gallery and modal
mailbox use `CollapsibleMailer`; inline gallery/mail opt out. No separate
width mechanism was found among these sidebar surfaces.

## Verification

`narrowlistowner.test.tsx` models adoption between two documents with distinct
observer delivery, no window resize events, both list labels, both crossing
directions, exact 896/897px boundary, zero boxes, observer cleanup, return and
retention of the same list/input/filter/scroll. The existing gallery suite
additionally covers actual org/agent gallery callers and inline opt-outs.

Author measurement: baseline 36 pass / 2 fail out of 38 tests; fixed 38 pass.
Real Electron `tools/proof-popout-sidebar.mjs` uses production `MovableSurface`
and `CollapsibleMailer` with a synthetic reading surface, real DOM adoption,
native `setContentBounds`, content-only width changes and redock. Baseline
24 pass / 3 fail out of 27 checks; fixed 27 pass. It checks measured widths
and list input identity/filter separately from the sidebar assertions and
saves PNGs only after two animation frames plus a short settling delay.

Run under the shared FIFO/kernel Job, with `BATCH_NODE_MODULES` naming real
dependencies read in place, `ORGTREE_AGENT` set by the wrapper and
`POPOUT_SIDEBAR_OUT` inside the assigned `C:/orgtree-build/<agent>` scope.
No dependency copies or links, engine, live application data, application
build or Cargo target is needed. The Electron runner uses its own user-data
directory and loopback fixture server and closes both before finishing.

Root TypeScript passes. Strict renderer/test configurations have existing
diagnostics; `tools/proof-popout-sidebar-types.mjs` compares diagnostics with
a separate clean owned baseline worktree and rejects any diagnostic in
the edited hook or new fixtures. Final counts and receipts live on docket
`popped-out-panels-don-t-update-sidebar-visibilit`.

## Limits

The fixture exercises a synthetic shared reading surface, not live inbox or
presentation data. Real Windows snap-divider interaction, actual snap/unsnap,
maximize/restore and monitor DPI changes remain unmeasured. Programmatic
native bounds changes and content-only deliveries demonstrate the shared
mechanism. An early ESM Electron bootstrap deadlocked before ready, and
intermediate fixtures had selector/hidden-rendering/closure issues; only
the complete 27-check baseline and green runs count as browser evidence.

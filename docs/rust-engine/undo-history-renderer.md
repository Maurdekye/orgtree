# Durable user undo and redo — renderer

The canonical engine contract is [undo-history.md](undo-history.md). User
2026-10-14 chose per-org history across restarts, redo, and confirmation before
undoing a hire whose agent has started a turn. The engine retains at most100
entries/org; windows read only entry summaries, never journal payloads.

`useUserHistory` binds a per-org controller while the current tree exposes
`undo_history`. The feed's `undo` revision and existing mutation notifications
refresh it. Effect cleanup ignores old reads and commands; setup supports
React's StrictMode remount. The App and its window mirrors share that controller,
while separate app windows rely on the engine's target-ID transaction guards.

`HistorySurface` lives before the transient ToastStack in every presentation.
Ctrl/Cmd+Z, Ctrl+Y and Ctrl/Cmd+Shift+Z therefore work after a toast disappears.
`undokeys.ts` preserves editing in the event's own document, including popped
windows, selects, editable content and embedded editors. Pending commands and
confirmation block shortcut fallthrough to an older transient inverse. Toast
buttons carry the committed entry ID and are available only at that undo head.

Worked-hire confirmation opens in the presentation's own document. Cancel sends
nothing. Confirm retains the token through the dialog's close-before-act path;
another started turn produces a fresh confirmation. Refusal reports the engine's
reason; only the next deliberate shortcut reaches an older entry. Oversized
retire entries use this ordinary refusal path.

Canvas side hires use a single gesture with a `$0.node` placement reference;
superior hires use `hire_type:superior`. Multi-member reorders and agent settings
Save (model/account plus scope) are each one gesture. No-op answers carry no
Undo action. Queued-account disclosures and existing provider-reset confirmation
remain. Old engines without the header retain the preceding UI paths.

Prepared proofs cover controller races/refusals, four action-kind shortcuts,
StrictMode, worked-hire cancellation/reconfirmation, mirrored native editing,
structured transport errors, request IDs, actual settings Save/retire and canvas
side/superior hires. Red controls disable the durable surface and restore the
pre-change composite UI paths. Engine proofs cover exact inverses, redo clearing,
conflicts, scope cascades and scratch restart durability. Runtime and typecheck
results are still pending the combined rig phase; this document claims no pass.

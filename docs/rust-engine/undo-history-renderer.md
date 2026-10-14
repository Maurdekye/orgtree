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

`HistorySurface` lives before the transient ToastStack in every presentation
and handles shortcuts in window capture, before transient bubbling listeners.
Owner-document discovery can install its listener after the toast listener;
capture priority makes arbitration independent of effect and mount order.
Ctrl/Cmd+Z, Ctrl+Y and Ctrl/Cmd+Shift+Z therefore work after a toast disappears.
`undokeys.ts` preserves editing in the event's own document, including popped
windows, selects, editable content and embedded editors. Pending commands and
confirmation block shortcut fallthrough to an older transient inverse. Toast
buttons carry the committed entry ID and are available only at that undo head.
The keyboard explainer lists persistent undo and both redo chords. Its source
scanner follows the normalized classifier and its actual keydown consumers;
the transient toast consumer binds undo only.

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
conflicts, scope cascades and scratch restart durability.

Round440 measured the renderer at `5c5e363` (author listener fix `0a2bc9c`,
typing fix `e1a00f9` picked as `424aee0`). The focused seven-suite runner passed
41/41 green tests, with zero skipped or cancelled. Its controlled red produced
29 passed/12 failed, including all eight required feature targets and the
pending-key case. The first green run had 40/41: owner discovery registered
history after the toast listener, letting the first shortcut undo the transient
toast. Window capture fixes that priority, and the same test now also checks a
bubbled body key, pending state and a second consumed key. The tests-config
diagnostic count returned from 832 to its 830 baseline after constructor reuse
through the harness; that is not a globally clean tests typecheck.

The final composed batch `55433a0` passes the impacted undo/shortcut union
49/49 and focused shortcuts 8/8, with zero skipped or cancelled. Registry and
scanner updates follow the normalized classifier and both consumers, while
the transient consumer remains undo-only. Full renderer results are from the
earlier `5c5e363`: 3,564 tests, 3,469 passed, 91 failed, 4 skipped, against the
base's 3,543/3,450/89/4. Its two new shortcut failures are resolved by the final
focused checks; the full suite was not rerun at the final tip. A known baseline
allocation failure appeared under a different test name. Typecheck diagnostic
counts are root 0, strict renderer 29, tests 830, matching baseline; root/tests
were rechecked after the registry fix, before the glyph-only test correction.

Inherited engine receipts at `5e84973` include 9/9 unit tests and two 57/57
undo proof runs. The author inspected their raw logs, including exact raised
ancestor/org grant restoration, clamped descendant restoration, refusal after
a side row changes, and undo after scratch-engine restart. The base red reached
the scratch database and stopped on the missing `ot.undo_entries` table before
assertions; it is an expected pre-journal failure, not a completed red proof.
The over-2,000-member retire boundary has no runtime fixture. Earlier Android
and unrelated regression receipts precede the final refusal-only engine fix;
their continued validity is inferred. No installed or live behavior is claimed.

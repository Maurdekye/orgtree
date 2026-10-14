# Durable user undo and redo

Renderer companion; the engine owner maintains the canonical contract in
`undo-history.md`. Published v1 transport and controller preparation follows
that contract; API routes are not activated in the app until full wiring.

User 2026-10-14 chose per-org history across restarts, redo (Ctrl+Y and
Ctrl/Cmd+Shift+Z), and confirmation before undoing a hire that has taken a turn.
Engine foundation belongs to `undo-history-engine-foundation-durable-journal-a`;
renderer and integrated proofs belong to its parent ticket
`persistent-undo-history-undo-several-move-hire-r`.

Contract-independent preparation only: `undokeys.ts` shares chord and editor
classification with the existing toast handler, which still handles Undo only.
Inputs, editable text, select controls and embedded editors keep native undo
and redo in their own document. Classification does not consume the event;
the caller must first establish that its action can be handled.

The durable engine API, grouped user gestures, toast journal-entry targeting,
worked-hire confirmation and per-kind restart/red-control proofs are not yet
implemented here. This commit does not enable durable history or redo.
Focused helper and existing toast regression cases are prepared; runtime and
typecheck evidence are pending the combined rig phase.

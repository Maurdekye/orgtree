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

`historyapi.ts` consumes the engine's published v1 history and gesture shapes.
Expected history404/409 replies preserve their structured state; unrelated
requests retain the existing transport failure behavior. `historycontroller.ts`
guards concurrent commands, stale reads, disposed-org completions and in-flight
feed refreshes, with worked-hire confirmation and refusal states.

Grouped user gestures, actual app shortcut/listener wiring, toast journal-entry
targeting and the confirmation dialog are not yet connected. The preparation
does not enable durable history or redo. Per-kind restart/red controls remain
pending the engine implementation. No runtime or typecheck pass is claimed.

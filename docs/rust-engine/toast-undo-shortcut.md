# Toast Undo keyboard shortcut

Ctrl+Z or Cmd+Z runs the newest visible toast's existing Undo callback in the
window receiving the key (user 2026-10-13 18:14UTC). Every toast carrying an
Undo participates, including callbacks with a custom button label. There is
no history beyond the visible 12-second toast lifetime and no redo shortcut.

`toasts.tsx` owns the shared presentation and callback consumption. Clicking
Undo and pressing its shortcut consume the same record before calling the
original function, so rapid keys/clicks and mirrored popout windows cannot
invoke it twice before React removes it. Dismissal consumes it too; checking
the deadline refuses expired records even if their timer/DOM is delayed.
`App.tsx` keeps its existing queue and expiry timer and renders this component
in main and through `WindowMirrors`.

Each stack binds its own document's window. Only an on-screen button in that
stack qualifies; hidden documents/stacks and buttons outside the viewport do
not. Newer plain notices do not hide an older available Undo. Input, textarea,
select, contenteditable (including shadow descendants), textbox roles and
editor containers retain text undo. Already-handled keys, repeated keys,
composition, Alt+Z and Shift+Ctrl/Cmd+Z are left alone.

Focused verification is `toastundo.test.tsx`; typecheck and measured evidence
are pending at the initial source commit. No engine/provider behavior changes.

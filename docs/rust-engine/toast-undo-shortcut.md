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

Measured 2026-10-13: `toastundo.test.tsx` passes 19/19, no failures or skips;
typecheck exits 0. Both ran under a 4096 MB / 150 s kernel Job; the focused
renderer bundle/test phase also held the shared machine build lock. Checks use
the actual `ToastStack` and `createToast`, including separate portal documents
and simultaneous mirror events, with explicit visible/invisible rectangles.
jsdom does not implement layout or native text undo: these checks prove keys
are left unhandled inside editors, not that an OS editor restores its text.
Real OS shortcuts, native popout focus, installed behavior and backend reverse
operations were not exercised. No engine/provider behavior changes.

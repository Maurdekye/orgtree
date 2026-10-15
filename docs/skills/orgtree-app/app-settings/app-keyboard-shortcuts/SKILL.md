---
name: orgtree-app-keyboard-shortcuts
description: Find the app's keyboard bindings, their focus conditions and the effect of the Enter-key preference.
---

Up: [orgtree-app-settings](../SKILL.md)

# Keyboard shortcuts

The Keyboard shortcuts settings tab is a reference, not a key-rebinding editor. It groups the app's bindings and reflects the current Display → Typing → Enter key preference. No setting is saved by reading it. Suggest this page when the user wants faster navigation or needs to understand a key's focus-dependent action. Agents explain these actions; they do not operate the user's settings.

`Mod` means Ctrl on Windows/Linux and Command on macOS. Alt appears as Option on macOS. Function keys below work even while typing in the main app document; Ctrl, Alt or Command modifiers prevent a function-key match, and key-repeat does not repeat the action. A panel action with no available handler has no effect.

| Key | Main-window action |
| --- | --- |
| F1 | Toggle app Settings. |
| F2 | Toggle Usage. |
| F3 | Toggle Usage History. |
| F4 | Toggle Canvas/Attention; return to Canvas from an open panel. |
| F5 | Refresh app view, using the header button's action. |
| F6 | Toggle the current org Inbox. |
| F7 | Toggle the current org Docket. |
| F8 | Toggle the current org Presentations. |
| F9 | Toggle the current org Settings. |
| F10 | Unlatch Halt all; this neither halts agents nor releases an org that is halted. |
| Shift+F10 | Halt all immediately, whether armed or not. |
| Shift+F1 | Open a new Homepage window. |
| Shift+F2 | Toggle the app menu focused on Open organization. |
| Shift+F3 | Open the create-organization window. |

## Focus-dependent bindings

| Location | Binding and effect |
| --- | --- |
| Anywhere | Esc closes the topmost menu, popup or dialog one at a time. Mod+Z undoes persistent action history; Ctrl+Y or Mod+Shift+Z redoes. The app undo bindings defer while typing in a text field. |
| Message composer, Enter set to Send | Enter or Mod+Enter sends; Shift+Enter inserts a newline. |
| Message composer, Enter set to Newline | Mod+Enter sends; Enter inserts a newline. |
| Desk composer | Up/Down recalls previous/next sent messages when the caret is on the first/last line. Alt+N toggles sending as a passive notice. Esc cancels the reply being prepared. |
| Inbox | Alt+Up/Down moves to the previous/next message. |
| Focused Presentations or Docket panel | Alt+Up/Down selects the previous/next eligible item in its rendered order, including desk, modal and detached hosts. Opening gives the list panel focus once, so navigation starts from its auto-selected item without a row click; an already focused child editor keeps focus. Later list polls do not reclaim focus. Folded or filtered rows are skipped; the ends clamp. Editing controls, question cards, consumed chords and unsent/staged reply or answer state keep their event or block switching. |
| Questions and requests | Mod+Enter submits an answer; Alt+Left/Right changes question; Alt+Up/Down raises/lowers a credit offer. |
| Docket | Enter opens the top search result; Esc clears the search or closes view options. Letters jump to an agent in the reply-recipient list; Space chooses a recipient. |
| Canvas | Esc cancels an agent, pin or window drag, or cancels a drafted hire. Holding Shift while dragging places a pinned window without snapping. Enter hires a drafted agent; Shift+Enter adds a charter newline. |
| Attention | Left/Right switches Canvas/Attention on the view switch. Up/Down/Home/End navigates the queue or agent list. Left/Right/Home/End on the divider resizes the split; Shift uses larger steps. |
| Quick chat | Enter hires and sends; Shift+Enter inserts a newline. Up/Down/Enter chooses a superior in its list; Esc closes the picker. This hire composer has its own Enter behavior. |
| Menus | Up/Down/Home/End moves through items; Right opens a submenu; Left/Esc backs out. Enter runs the item's own action rather than its submenu. Down opens the Orgtree menu button; Esc closes the tray popup. |
| Logo crop | Arrows move the focused square or corner handle; Shift+Left/Up shrinks and Shift+Right/Down enlarges it. |
| Settings tabs | Arrows/Home/End changes the active tab. |
| Effort control | Left/Right/Home/End changes the level; vertical arrows mirror horizontal ones. Backspace/Delete clears an explicitly set effort. |
| Credit grant | Left/Right/Home/End adjusts the grant; vertical arrows mirror horizontal ones. Esc cancels the edit. |
| Text fields | Mod+X/C/V cuts/copies/pastes; Mod+A selects all. Enter saves participating single-line fields. |
| Standard widgets | Enter/Space activates focused button-like items. Tab moves focus, remains inside modal dialogs, or leaves/closes menus. Up/Down/Page Up/Page Down/Home/End/Space scrolls a conversation when focus allows native scrolling. |

Undo is durable action history and can require confirmation; it is distinct from editing text. See [orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md) for its scope and the resulting state changes. The source catalog is `shortcuts.ts` plus `shell/appshortcuts.ts`; if a newly added binding differs, use that source and update this page in the same landing.

## See also

- [orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md).

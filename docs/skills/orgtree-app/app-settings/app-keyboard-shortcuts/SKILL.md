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
| Shift+F4 | Go to the newest recorded @user mention in the current org, across agent transcripts, mail and tickets. Separate presses step backward, including seen mentions; no wrap. A newer mention resets the position. |
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
| Shift+F7 | Focus the last live agent desk and bring it into view. |

## Organization navigation

In the main org window, use these outside text fields, code editors, dropdowns,
sliders and IME composition. Open dialogs, menus and pointer gestures keep their
keys. Separate presses act once; holding a key does not repeat navigation.
Navigation resumes after a pointer gesture ends. If its release happened
outside the document, returning/moving that pointer with no buttons held
clears its stale gesture guard; other active pointers still keep their keys.
An org-navigation move may autofocus the destination's composer. Further org
navigation chords continue from that automatically focused composer, so several
desk moves can be made in a row while direct typing still works. Clicking,
Tab or another non-navigation key, typing/input, composition, or window blur
returns normal editor key ownership. Ordinary desk autofocus and intentionally
focused editors retain their existing shortcut protection.

| Key | Action |
| --- | --- |
| Shift+Alt+Up | Visible canvas parent; from a top-level node, the switchboard. |
| Shift+Alt+Down | Centre-most visible direct child; an even tie uses the earlier child in canvas order. |
| Shift+Alt+Left / Right | Previous/next visible sibling in canvas order, wrapping. Projects are stops. |
| Shift+Alt+Space | Fit the whole org in view. |
| Shift+Alt+Backspace | Walk back through earlier focused agents, one at a time, per org. |
| Shift+Alt+S | Focus the switchboard, using the physical S key even on a Hebrew or other non-Latin layout. |

No available target leaves the view unchanged. Navigation uses the existing
desk destination: pinned/detached desks are revealed; Attention selects its desk.
When no desk is focused, Shift+Alt arrows start from the last live agent or
project desk focused in this org, if it still exists in the visible layout.
A focus/jump intent, settled camera focus (including manual pan/zoom), or an
interaction with a pinned/Attention desk counts. Selection, hover and desks
passed during a glide do not. Overview/fit keeps this memory. The switchboard
remains its own origin and does not erase the remembered desk. A missing,
retired or hidden remembered node leaves the existing behavior unchanged.
This memory is separate from Shift+F7's last-agent shortcut.
History lasts for this window's session, retains up to 256 agent visits, skips
agents no longer in the loaded tree, and is preserved by project/switchboard/fit
visits. Shift+F6 and Shift+F8 are unbound; Shift+F7 remains the last-desk shortcut.

On Windows, Shift+Alt+Space now cancels only its native system-menu request,
then uses the ordinary renderer navigation guards. Plain Alt+Space and titlebar
right-click keep the Windows menu. Each native Orgtree window, including a
pop-out, keeps separate modifier state and clears it on blur; org actions keep
their existing main-canvas scope. No global shortcut or OS setting is changed.
Navigation command tooltips show the shared binding in parentheses on the
same line, without an action caption; arrow directions use ← ↑ → ↓. Agent and
project links, including neighbour and superior/subordinate jump cards, keep
their ordinary identity tooltips without shortcut hints. Switchboard commands
and the generic Focus last desk command retain their hints.
Windows may still intercept Alt+Shift for input-language switching. On macOS, Option-arrow selection/word movement and deletion remain with editors.

## Focus-dependent bindings

| Location | Binding and effect |
| --- | --- |
| Anywhere | Esc closes the topmost menu, popup or dialog one at a time. Mod+Z undoes persistent action history; Ctrl+Y or Mod+Shift+Z redoes. The app undo bindings defer while typing in a text field. |
| Message composer, Enter set to Send | Enter or Mod+Enter sends; Shift+Enter inserts a newline. |
| Message composer, Enter set to Newline | Mod+Enter sends; Enter inserts a newline. |
| Desk composer | Up/Down recalls previous/next sent messages when the caret is on the first/last line. Alt+N toggles sending as a passive notice. Esc cancels the reply being prepared. |
| Agent or project desk | Alt+Left/Right cycles the displayed tabs with wrapping, including conditional project tabs. It uses the normal tab action and prevents Chromium back/forward when it acts. Editors/widgets keep their keys; inside a question card, Alt+Left/Right continues to change questions. Works in detached desk documents too. |
| Inbox | Alt+Up/Down moves to the previous/next message. |
| Focused Presentations or Docket panel | Alt+Up/Down selects the previous/next eligible item in its rendered order, including desk, modal and detached hosts. Opening gives the list panel focus once, so navigation starts from its auto-selected item without a row click; an already focused child editor keeps focus. Later list polls do not reclaim focus. Folded or filtered rows are skipped; the ends clamp. Editing controls, question cards, consumed chords and unsent/staged reply or answer state keep their event or block switching. |
| Questions and requests | Mod+Enter submits an answer; Alt+Left/Right changes question; Alt+Up/Down raises/lowers a credit offer. |
| Docket | Enter opens the top search result; Esc clears the search or closes view options. Letters jump to an agent in the reply-recipient list; Space chooses a recipient. |
| Canvas | Esc cancels an agent, pin or window drag, or cancels a drafted hire. Holding Shift while dragging places a pinned window without snapping. Enter hires a drafted agent; Shift+Enter adds a charter newline. |
| Attention | Left/Right switches Canvas/Attention on the view switch. Up/Down/Home/End navigates the queue or agent list. Left/Right/Home/End on the divider resizes the split; Shift uses larger steps. |
| Quick chat | Single-line input: Enter hires and sends; Shift+Enter does not submit or insert a newline. Up/Down/Enter chooses a superior in its list; Esc closes the picker or cancels a prepared reply. This hire composer has its own Enter behavior. |
| Menus | Up/Down/Home/End moves through items; Right opens a submenu; Left/Esc backs out. Enter runs the item's own action rather than its submenu. Down opens the Orgtree menu button; Esc closes the tray popup. |
| Logo crop | Arrows move the focused square or corner handle; Shift+Left/Up shrinks and Shift+Right/Down enlarges it. |
| Settings tabs | Arrows/Home/End changes the active tab. |
| Effort control | Left/Right/Home/End changes the level; vertical arrows mirror horizontal ones. Backspace/Delete clears an explicitly set effort. |
| Credit grant | Left/Right/Home/End adjusts the grant; vertical arrows mirror horizontal ones. Esc cancels the edit. |
| Text fields | Mod+Z undoes text edits; Ctrl+Y on Windows or Mod+Shift+Z redoes. Mod+X/C/V cuts/copies/pastes; Mod+A selects all; Delete removes selected text. Rich editors offer Paste as plain text (Ctrl+Shift+V, or Option+Shift+Command+V on macOS). Enter saves participating single-line fields. |

Editable text context menus show the corresponding platform shortcut hints,
including disabled commands when Chromium reports they are unavailable. A
misspelled word offers the default Electron/OS spelling suggestions and **Add
to dictionary**; replacing a suggestion or adding the word uses the window and
session that received the press. There is no separate language selector here.
Read-only selections offer **Copy** and **Select All**; exact-passage menus keep
**Reply to selection**. These are local text-editing/clipboard actions, with no
new agent tool or message send. Agents use their existing file/edit tools and
the selection read/send contracts when working with equivalent source content.
| Standard widgets | Enter/Space activates focused button-like items. Tab moves focus, remains inside modal dialogs, or leaves/closes menus. Up/Down/Page Up/Page Down/Home/End/Space scrolls a conversation when focus allows native scrolling. |

Undo is durable action history and can require confirmation; it is distinct from editing text. See [orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md) for its scope and the resulting state changes. The source catalog is `shortcuts.ts` plus `shell/appshortcuts.ts`; if a newly added binding differs, use that source and update this page in the same landing.

Mention history starts at **4.4.2**, seeded once from a bounded set of still-pending markers at upgrade. It retains the newest **2,000 mentions per org**, including seen entries recorded since then; older handled history is not backfilled. A jump opens the desk, mail or ticket reader and highlights the mention. If a ticket edit removed the original prose, its labelled recorded excerpt remains available. No mentions gives **No @user mentions yet**; past the oldest gives **No older @user mentions**, leaving the current view in place. Holding the key does not step repeatedly.

Shift+F4 is UI navigation. Agents reach source content with `orgtree_read_transcript`, `orgtree_inbox` and `orgtree_work get` within their existing permissions.

Organization and desk-tab shortcuts are also UI navigation, with no new agent
tool or authority. Agents read the organization using `orgtree_chart` and use
the existing scoped transcript, inbox, docket and presentation tools for content.

## See also

- [orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md).

// shortcuts.ts — every keyboard shortcut Orgtree binds, as data.
//
// User 2026-10-14: "we need a keyboard shortcuts explainer somewhere in the
// app"; ruled a "Keyboard shortcuts" section in App settings only (no
// overlay, no tray or menu entry). The section renders this list.
//
// ⚠ THIS LIST IS CHECKED AGAINST THE SOURCE (tests/shortcuts.test.tsx). The
// test scans renderer/src and main for key literals (`e.key === 'Escape'`,
// `[...].includes(e.key)`, menu `accelerator:`) and fails both ways: a key a
// file binds with no entry naming that file, and an entry whose key its
// listed files no longer bind. A new binding therefore lands with its entry,
// or as a BUILTIN below with the reason it is not worth showing.
//
// Keys are written as combos: `Mod` is Ctrl (⌘ on macOS), then `Alt`,
// `Shift`, and the KeyboardEvent key name ('Escape', 'ArrowUp', 'N', 'Space').
// `A-Z` is "type a letter" (typeahead). `sources` are paths from
// apps/desktop.

import type { EnterKeyBehavior } from './composerkeys'
import { APP_FKEYS } from './shell/appshortcuts'

export interface Shortcut {
  /** alternatives; each is one combo, e.g. 'Alt+ArrowUp' */
  keys: string[]
  action: string
  /** a short condition, e.g. "on the first line" */
  note?: string
  sources: string[]
}

export interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

const R = (file: string) => `renderer/src/${file}`

/** Keyboard literals that the inventory scanner sees but that are not app
 * commands. EPIC Mode only turns these events into optional audiovisual cues;
 * it does not consume them or change the focused control. Keep these explicit
 * so future real shortcuts in the same file still need a user-facing entry. */
export const NON_SHORTCUT_BINDINGS = [{
  source: R('epic/director.ts'),
  keys: ['Tab', 'Enter', 'Backspace', 'Delete', 'z', 'y', 'c', 'v', 'x'],
  reason: 'EPIC Mode visual and sound cues only; no app command or key behavior is bound.',
}] as const

/** The composer rows follow Display → Typing → Enter key, so the list shows
 *  what Enter does on this machine rather than both readings at once. */
export function shortcutGroups(enter: EnterKeyBehavior = 'send'): ShortcutGroup[] {
  const composer = R('composerkeys.ts')
  return [
    { title: 'Anywhere', items: [
      { keys: ['Escape'], action: 'Close the topmost menu, pop-up or dialog',
        note: 'one at a time',
        sources: [R('canvas/shared.ts'), R('App.tsx'), R('canvas/OrgCanvas.tsx'),
          R('shell/menu.tsx'), R('canvas/lightbox.ts'), R('picker.tsx'),
          R('canvas/desk.tsx')] },
      { keys: ['Mod+Z'], action: 'Undo the latest action',
        note: 'persistent move, hire, retire and settings history; not while typing in a field',
        sources: [R('undokeys.ts'), R('historyui.tsx'), R('toasts.tsx')] },
      { keys: ['Ctrl+Y', 'Mod+Shift+Z'], action: 'Redo the last undone action',
        note: 'not while typing in a field', sources: [R('undokeys.ts'), R('historyui.tsx')] },
    ] },
    // F1-F10 and assigned Shift+F keys, the main window's function keys (usage-query-sol's
    // shell/appshortcuts.ts); its matcher reads the same table
    { title: 'Function keys', items: APP_FKEYS.map(({ keys, action }) =>
      ({ keys, action, sources: [R('shell/appshortcuts.ts')] })) },
    { title: 'Writing a message', items: [
      enter === 'send'
        ? { keys: ['Enter', 'Mod+Enter'], action: 'Send', sources: [composer] }
        : { keys: ['Mod+Enter'], action: 'Send', sources: [composer] },
      { keys: enter === 'send' ? ['Shift+Enter'] : ['Enter'], action: 'New line',
        note: 'change in Display → Typing', sources: [composer] },
      { keys: ['ArrowUp', 'ArrowDown'], action: 'Previous or next message you sent',
        note: 'caret on the first or last line', sources: [R('canvas/desk.tsx')] },
      { keys: ['Alt+N'], action: 'Send as a notice (does not wake the agent)',
        note: 'toggles', sources: [R('canvas/desk.tsx'), R('canvas/mail.tsx')] },
      { keys: ['Escape'], action: 'Cancel the reply you are preparing',
        sources: [R('canvas/desk.tsx')] },
    ] },
    { title: 'Inbox', items: [
      { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], action: 'Previous or next message',
        sources: [R('canvas/mail.tsx')] },
    ] },
    { title: 'Presentations and tickets', items: [
      { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], action: 'Open the previous or next entry',
        note: 'in the focused panel; leaves editors and unfinished drafts alone',
        sources: [R('canvas/panelsteps.ts')] },
    ] },
    { title: 'Questions and requests', items: [
      { keys: ['Mod+Enter'], action: 'Submit the answer', sources: [R('canvas/asks.tsx')] },
      { keys: ['Alt+ArrowLeft', 'Alt+ArrowRight'], action: 'Previous or next question',
        sources: [R('canvas/asks.tsx')] },
      { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], action: 'Raise or lower a credit offer',
        sources: [R('canvas/asks.tsx')] },
    ] },
    { title: 'Docket', items: [
      { keys: ['Enter'], action: 'Open the top result', note: 'in the search box',
        sources: [R('canvas/docket.tsx')] },
      { keys: ['Escape'], action: 'Clear the search, or close view options',
        sources: [R('canvas/docket.tsx')] },
      { keys: ['A-Z'], action: 'Jump to an agent', note: 'in the reply recipient list',
        sources: [R('canvas/docket.tsx')] },
    ] },
    { title: 'Canvas', items: [
      { keys: ['Escape'], action: 'Cancel a drag', note: 'agent, pin or window',
        sources: [R('canvas/OrgCanvas.tsx'), R('canvas/pins.tsx'), R('canvas/modalpin.tsx')] },
      { keys: ['Shift'], action: 'Place a pinned window freely, without snapping',
        note: 'hold while dragging', sources: [R('canvas/pins.tsx'), R('canvas/modalpin.tsx')] },
      { keys: ['Escape'], action: 'Cancel a new agent you are drafting',
        sources: [R('canvas/cards.tsx')] },
      { keys: ['Enter'], action: 'Hire the drafted agent', note: 'Shift+Enter: new line in the charter',
        sources: [R('canvas/cards.tsx')] },
    ] },
    { title: 'Attention view', items: [
      { keys: ['ArrowLeft', 'ArrowRight'], action: 'Switch between Canvas and Attention',
        note: 'on the view switch', sources: [R('shell/modetoggle.tsx')] },
      { keys: ['ArrowUp', 'ArrowDown', 'Home', 'End'], action: 'Move through the queue or agent list',
        sources: [R('attention/AttentionQueue.tsx'), R('attention/AgentDeskPanel.tsx')] },
      { keys: ['ArrowLeft', 'ArrowRight', 'Home', 'End'], action: 'Resize the split',
        note: 'on the divider; hold Shift for bigger steps', sources: [R('attention/AttentionView.tsx')] },
    ] },
    { title: 'Quick chat', items: [
      { keys: ['Enter'], action: 'Hire a new agent and send', note: 'Shift+Enter: new line',
        sources: [R('QuickChatBox.tsx')] },
      { keys: ['ArrowUp', 'ArrowDown', 'Enter'], action: 'Pick the superior', note: 'in the superior list',
        sources: [R('QuickChatBox.tsx')] },
      { keys: ['Escape'], action: 'Close the open picker', sources: [R('QuickChatBox.tsx')] },
    ] },
    { title: 'Menus', items: [
      { keys: ['ArrowUp', 'ArrowDown', 'Home', 'End'], action: 'Move through the items',
        sources: [R('shell/menu.tsx'), R('canvas/contextmenu.tsx')] },
      { keys: ['ArrowRight'], action: 'Open a submenu',
        sources: [R('shell/menu.tsx'), R('canvas/contextmenu.tsx')] },
      { keys: ['Enter'], action: 'Run the item itself, not its submenu',
        note: 'on an item with a submenu', sources: [R('canvas/contextmenu.tsx')] },
      { keys: ['ArrowLeft', 'Escape'], action: 'Back out of a submenu',
        sources: [R('shell/menu.tsx'), R('canvas/contextmenu.tsx')] },
      { keys: ['Escape'], action: 'Close the tray pop-up', sources: ['main/index.ts'] },
    ] },
    { title: 'Controls', items: [
      { keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], action: 'Move the logo crop square',
        note: 'with the crop square or a corner handle focused', sources: [R('canvas/SquareCrop.tsx')] },
      { keys: ['Shift+ArrowLeft', 'Shift+ArrowUp'], action: 'Shrink the logo crop square',
        note: 'with the crop square or a corner handle focused', sources: [R('canvas/SquareCrop.tsx')] },
      { keys: ['Shift+ArrowRight', 'Shift+ArrowDown'], action: 'Enlarge the logo crop square',
        note: 'with the crop square or a corner handle focused', sources: [R('canvas/SquareCrop.tsx')] },
      { keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'],
        action: 'Switch settings tabs', sources: [R('canvas/settingskit.tsx')] },
      { keys: ['ArrowLeft', 'ArrowRight', 'Home', 'End'], action: 'Change the effort level',
        sources: [R('canvas/effortbar.tsx')] },
      { keys: ['Backspace', 'Delete'], action: 'Clear a set effort level',
        sources: [R('canvas/effortbar.tsx')] },
      { keys: ['ArrowLeft', 'ArrowRight', 'Home', 'End'], action: 'Adjust a credit grant',
        note: 'Escape cancels', sources: [R('canvas/creditgrant.tsx')] },
    ] },
    { title: 'Text fields', items: [
      { keys: ['Mod+X', 'Mod+C', 'Mod+V'], action: 'Cut, copy, paste',
        note: 'also on the right-click menu', sources: ['main/editmenu.ts'] },
      { keys: ['Mod+A'], action: 'Select all', sources: ['main/editmenu.ts'] },
    ] },
  ]
}

/** Bindings the scan finds that are not shown: each only gives a widget the
 *  keyboard behaviour any button, form or scroller already has. Listed so the
 *  test can tell them from a forgotten shortcut. */
export const BUILTIN: (Shortcut & { why: string })[] = [
  { keys: ['Enter', 'Space'], action: 'Activate a focused button-like item',
    why: 'role="button" elements answer Enter/Space like a <button>',
    sources: [R('App.tsx'), R('shell/statusbar.tsx'), R('shell/orgrows.tsx'),
      R('canvas/pins.tsx'), R('canvas/desk.tsx'), R('shell/menu.tsx')] },
  { keys: ['Enter'], action: 'Save a single-line field',
    why: 'Enter submits a one-line form field',
    sources: [R('canvas/accounts.tsx'), R('canvas/chartersettings.tsx'),
      R('canvas/openrouterkeys.tsx'), R('canvas/templates.tsx'), R('canvas/turnlimitssetting.tsx'),
      R('canvas/lsbrowser.tsx')] },
  { keys: ['Tab'], action: 'Move focus',
    why: 'keeps Tab inside a dialog, or closes a menu as focus leaves it',
    sources: [R('canvas/modals.tsx'), R('canvas/tempdesk.tsx'), R('shell/menu.tsx'),
      R('canvas/contextmenu.tsx')] },
  { keys: ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'],
    action: 'Scroll a conversation',
    why: 'native scrolling; the desk only notes which way you scrolled',
    sources: [R('canvas/desk.tsx')] },
  { keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'],
    action: 'Arrow keys on a credit grant', why: 'same control as the Controls row; vertical arrows mirror horizontal',
    sources: [R('canvas/creditgrant.tsx')] },
  { keys: ['ArrowUp', 'ArrowDown'], action: 'Vertical arrows on the effort level',
    why: 'mirror the horizontal arrows of the Controls row', sources: [R('canvas/effortbar.tsx')] },
  { keys: ['Space'], action: 'Choose a recipient',
    why: 'typeahead leaves Space to the list, where it picks the option', sources: [R('canvas/docket.tsx')] },
  { keys: ['ArrowDown'], action: 'Open the Orgtree menu', why: 'standard menu-button behaviour',
    sources: [R('shell/menu.tsx')] },
]

const MAC_NAMES: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
const NAMES: Record<string, string> = {
  Mod: 'Ctrl', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: 'Page Up', PageDown: 'Page Down', Delete: 'Del',
}

/** One combo as the keycaps to draw, with platform-correct modifier names. */
export function keyCaps(combo: string, mac: boolean): string[] {
  return combo.split('+').map(k => (mac && MAC_NAMES[k]) || NAMES[k] || k)
}

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined
  = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return /Mac/i.test(nav?.platform || nav?.userAgent || '')
}

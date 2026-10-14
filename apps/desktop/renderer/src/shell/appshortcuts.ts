import { useLayoutEffect, useRef } from 'react'
import type { OrgView } from '../attention/mode'

export type AppShortcutAction = 'settings' | 'usage' | 'usageHistory' | 'view'
  | 'refresh' | 'inbox' | 'docket' | 'presentations' | 'orgSettings' | 'unlatch' | 'halt'
  | 'newWindow' | 'openOrganizations' | 'createWindow'

/** Used both by the matcher and Settings' keyboard shortcut list. */
export const APP_FKEYS: { keys: string[]; action: string; id: AppShortcutAction }[] = [
  { keys: ['F1'], action: 'Toggle app Settings', id: 'settings' },
  { keys: ['F2'], action: 'Toggle Usage', id: 'usage' },
  { keys: ['F3'], action: 'Toggle Usage History', id: 'usageHistory' },
  { keys: ['F4'], action: 'Toggle Canvas / Attention; from a panel, return to Canvas', id: 'view' },
  { keys: ['F5'], action: 'Refresh app view (same as the header button)', id: 'refresh' },
  { keys: ['F6'], action: 'Toggle current organization Inbox', id: 'inbox' },
  { keys: ['F7'], action: 'Toggle current organization Docket', id: 'docket' },
  { keys: ['F8'], action: 'Toggle current organization Presentations', id: 'presentations' },
  { keys: ['F9'], action: 'Toggle current organization Settings', id: 'orgSettings' },
  { keys: ['F10'], action: 'Unlatch Halt all (does not halt or release a halted organization)', id: 'unlatch' },
  { keys: ['Shift+F10'], action: 'Halt all immediately, whether armed or not', id: 'halt' },
  { keys: ['Shift+F1'], action: 'Open a new window (Homepage)', id: 'newWindow' },
  { keys: ['Shift+F2'], action: 'Toggle the app menu with its Open organization submenu focused', id: 'openOrganizations' },
  { keys: ['Shift+F3'], action: 'Open the create-organization window', id: 'createWindow' },
]

export type AppShortcutActions = Partial<Record<AppShortcutAction, () => void>>

export function matchAppShortcut(event: KeyboardEvent): AppShortcutAction | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const key = (event.shiftKey ? 'Shift+' : '') + event.key
  return APP_FKEYS.find(row => row.keys.includes(key))?.id
}

/** Main document only. Capture precedes focused inputs, menu handlers and
 * native edit-context defaults. Function keys work while typing by explicit
 * user ruling; no toast-Undo editor exclusion applies here. */
export function installAppShortcuts(win: Window, actions: () => AppShortcutActions): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = matchAppShortcut(event)
    if (!action) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.repeat) actions()[action]?.()
  }
  win.addEventListener('keydown', onKey, true)
  return () => win.removeEventListener('keydown', onKey, true)
}

export function useAppShortcuts(actions: AppShortcutActions): void {
  const current = useRef(actions)
  useLayoutEffect(() => { current.current = actions })
  useLayoutEffect(() => installAppShortcuts(window, () => current.current), [])
}

/** Clicking keeps custom onRefresh, availability, and sender custody intact. */
export function refreshFromHeader(doc: Document): void {
  doc.querySelector<HTMLButtonElement>(
    'header button[aria-label="Refresh app view"], header button[aria-label="refresh app view"]')?.click()
}

export function nextMainView(mode: OrgView, panelOpen: boolean): OrgView {
  return panelOpen || mode === 'attention' ? 'canvas' : 'attention'
}

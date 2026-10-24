import { ORG_NAV_KEYS, LAST_DESK_KEY } from './orgnavigationbindings'
export { ORG_NAV_KEYS } from './orgnavigationbindings'
import { useLayoutEffect, useRef } from 'react'
import type { OrgView } from '../attention/mode'
import { installNavigationKeys } from './navigationkeys'
import { beginKeyboardNavigation, endKeyboardNavigation, navigationAutofocusedEditor } from '../composerfocus'

export type AppShortcutAction = 'settings' | 'usage' | 'usageHistory' | 'view'
  | 'refresh' | 'inbox' | 'docket' | 'presentations' | 'orgSettings' | 'unlatch' | 'halt'
  | 'newWindow' | 'openOrganizations' | 'createWindow'
  | 'fitOrg' | 'lastDesk' | 'switchboard' | 'latestMention'
  | 'parentNode' | 'childNode' | 'previousNode' | 'nextNode' | 'previousAgent'

export interface CanvasShortcutActions {
  fitOrg: () => void
  lastDesk: () => void
  switchboard: () => void
  parentNode: () => void
  childNode: () => void
  previousNode: () => void
  nextNode: () => void
  previousAgent: () => void
}
export interface CanvasShortcutRef { current: CanvasShortcutActions | null }

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
  { keys: ['Shift+F4'], action: 'Go to the latest @user mention; press again for older mentions', id: 'latestMention' },
  { keys: [LAST_DESK_KEY], action: 'Focus the last desk', id: 'lastDesk' },
]


export function matchOrgNavigation(event: KeyboardEvent): AppShortcutAction | undefined {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
  if (event.key.toLowerCase() === 's' && event.code !== 'KeyS') return
  const key = event.code === 'KeyS' ? 'S' : event.key === ' ' ? 'Space' : event.key
  return ORG_NAV_KEYS.find(row => row.keys.includes('Shift+Alt+' + key))?.id
}

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
  const clearNavigationFocus = () => endKeyboardNavigation(win.document)
  const onKey = (event: KeyboardEvent) => {
    if (!matchOrgNavigation(event) && event.key !== 'Alt' && event.key !== 'Shift') clearNavigationFocus()
    const action = matchAppShortcut(event)
    if (!action) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.repeat) actions()[action]?.()
  }
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('blur', clearNavigationFocus)
  for (const type of ['pointerdown', 'beforeinput', 'compositionstart'])
    win.document.addEventListener(type, clearNavigationFocus, true)
  const stopNavigation = installNavigationKeys(win.document, event => {
    const action = matchOrgNavigation(event)
    const run = action && actions()[action]
    if (!run) return
    event.preventDefault()
    beginKeyboardNavigation(win.document)
    run()
  }, event => matchOrgNavigation(event) ? navigationAutofocusedEditor(win.document) : null)
  return () => {
    win.removeEventListener('keydown', onKey, true)
    win.removeEventListener('blur', clearNavigationFocus)
    for (const type of ['pointerdown', 'beforeinput', 'compositionstart'])
      win.document.removeEventListener(type, clearNavigationFocus, true)
    clearNavigationFocus()
    stopNavigation()
  }
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

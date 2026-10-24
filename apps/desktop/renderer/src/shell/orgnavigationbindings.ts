/** One binding catalog for matching, shortcut help and navigation tooltips. */
export type OrgNavigationAction = 'parentNode' | 'childNode' | 'previousNode' | 'nextNode' | 'fitOrg' | 'previousAgent' | 'switchboard'
export const LAST_DESK_KEY = 'Shift+F7'
export const ORG_NAV_KEYS: { keys: string[]; action: string; id: OrgNavigationAction }[] = [
  { keys: ['Shift+Alt+ArrowUp'], action: 'Focus the visible parent; top-level nodes go to the switchboard', id: 'parentNode' },
  { keys: ['Shift+Alt+ArrowDown'], action: 'Focus the centre-most visible direct child', id: 'childNode' },
  { keys: ['Shift+Alt+ArrowLeft'], action: 'Focus the previous visible sibling, wrapping', id: 'previousNode' },
  { keys: ['Shift+Alt+ArrowRight'], action: 'Focus the next visible sibling, wrapping', id: 'nextNode' },
  { keys: ['Shift+Alt+Space'], action: 'Fit the whole org in view', id: 'fitOrg' },
  { keys: ['Shift+Alt+Backspace'], action: 'Go back through earlier focused agents in this org', id: 'previousAgent' },
  { keys: ['Shift+Alt+S'], action: 'Focus the switchboard', id: 'switchboard' },
]

export function orgNavigationTooltip(title: string, action?: string | null): string {
  const row = action === 'lastDesk' ? { keys: [LAST_DESK_KEY], action: 'Focus the last desk' }
    : ORG_NAV_KEYS.find(row => row.id === action)
  const arrows: Record<string, string> = { ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓' }
  return row ? `${title} (${row.keys.join(' / ').replace(/Arrow(?:Left|Up|Right|Down)/g, key => arrows[key]!)})` : title
}

import { copyToClipboard } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import type { ToastFn } from '../types'

export const orgTitle = (slug: string) => `Open organization ${slug} in a new window`
/** Delete is supplied only by an existing confirmation owner. */
export function orgMenuEntries(anchor: Element, slug: string, open: () => void, remove?: () => void, toast?: ToastFn): MenuEntry[] {
  const identity = `@org:${slug}`
  return [{ label: 'Open', onSelect: open }, { label: 'Copy identity', title: identity,
    onSelect: () => { void copyToClipboard(anchor, identity).then(ok => toast?.([ok ? 'Copied!' : 'Clipboard unavailable'])) } },
    ...(remove ? ['sep' as const, { label: 'Delete', danger: true, onSelect: remove }] : [])]
}

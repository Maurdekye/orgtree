import { getWorkItem, watchdogAction } from '../api'
import type { ToastFn, Watchdog } from '../types'
import { copyToClipboard } from './contextmenu'
import { ticketActions, watchdogActions } from './objectactions'
import { useProvideObjectNav } from './objectnav'
import { quickStaffEntry, quickStaffPath } from './quickstaff'
import type { QuickStaffPreview } from './quickstaff'
import { peekQuickStaff, prefetchQuickStaff } from './staffingoptions'

/** The current org's existing routes, shared by links and direct object menus. */
export function ObjectNavHost({ org, dogs, openDog, openTicket, focusAgent, toast }:
  { org: string; dogs: Watchdog[]; openDog: (id: string) => void;
    openTicket?: (id: string) => void; focusAgent?: (id: string) => void; toast: ToastFn }) {
  useProvideObjectNav((kind, id, targetOrg, anchor) => {
    if (targetOrg !== org) return []
    if (!id || /[\\?#\u0000]/.test(id) || id === '.' || id === '..') return []
    const copy = (text: string) => { void copyToClipboard(anchor, text).then(ok => toast([ok ? 'Copied!' : 'Clipboard unavailable'])) }
    if (kind === 'watchdog') {
      const dog = dogs.find(d => d.id === id && !d.spent)
      if (!dog) return []
      return [{ label: 'Open details', onSelect: () => openDog(dog.id) },
        ...watchdogActions(dog, action => {
          void watchdogAction(org, dog.id, action).then(r => toast([`${dog.name}: ${r.state}`]))
            .catch((error: Error) => toast([`error: ${error.message}`]))
        }), 'sep', { label: 'Copy watchdog name', onSelect: () => copy(dog.name) },
        { label: 'Copy watchdog id', onSelect: () => copy(dog.id) }]
    }
    if (!openTicket || id.includes('/')) return []
    return getWorkItem(org, id).then(async ({ item }) => {
      const entries = ticketActions({ item, open: () => openTicket(item.slug),
        owner: item.owner?.node && focusAgent ? { open: () => focusAgent(item.owner!.node) } : undefined,
        copySlug: () => copy(item.slug), copyReference: () => copy(`@item:${org}/${item.slug}`) })
      entries.unshift({ label: 'Copy ticket title', onSelect: () => copy(item.title) }, 'sep')
      if (!item.archived && item.status === 'backlogged') {
        const path = quickStaffPath(org, item.slug)
        try {
          const preview = peekQuickStaff<QuickStaffPreview>(path) ?? await prefetchQuickStaff<QuickStaffPreview>(path)
          entries.push(quickStaffEntry(org, item.slug, preview, message => toast([message])))
        } catch (error) {
          entries.push({ label: 'Staff…', disabled: true, title: String(error), onSelect: () => {} })
        }
      }
      return entries
    })
  }, org)
  return null
}

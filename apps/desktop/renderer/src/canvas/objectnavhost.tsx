import { getWorkItem, getWatchdog, watchdogAction } from '../api'
import type { ToastFn, Watchdog } from '../types'
import { copyToClipboard } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { nodeMenuAction, watchdogActions } from './objectactions'
import { ticketMenuEntries, ticketStaffable } from './ticketmenu'
import { quickStaffPath } from './quickstaff'
import type { QuickStaffPreview } from './quickstaff'
import { peekQuickStaff, prefetchQuickStaff } from './staffingoptions'
import { useAgentNavRegistry } from './agentnav'
import { useProvideObjectNav } from './objectnav'

/** The current org's existing routes, shared by links and direct object menus. */
export function ObjectNavHost({ org, dogs, openDog, openTicket, focusAgent, toast, isProject }:
  { org: string; dogs: Watchdog[]; openDog: (id: string) => void;
    openTicket?: (id: string) => void; focusAgent?: (id: string) => void; toast: ToastFn; isProject?: (id:string)=>boolean }) {
  const agents = useAgentNavRegistry()
  useProvideObjectNav((kind, id, targetOrg, anchor) => {
    if (targetOrg !== org) return []
    if (!id || /[\\?#\u0000]/.test(id) || id === '.' || id === '..') return []
    const copy = (text: string) => { void copyToClipboard(anchor, text).then(ok => toast([ok ? 'Copied!' : 'Clipboard unavailable'])) }
    if (kind === 'watchdog') {
      const dog = dogs.find(d => d.id === id)
      const menu = (dog:Watchdog|undefined): MenuEntry[] => {
      if (!dog || dog.spent || dog.state === 'spent') {
        if (anchor.getAttribute('data-object-stale') !== 'true') return []
        const name = anchor.getAttribute('data-object-name') || dog?.name || id.split('/').pop() || id
        return [{ label: 'Watchdog no longer exists', disabled: true, onSelect: () => {} }, 'sep',
          { label: 'Copy watchdog name', onSelect: () => copy(name) },
          { label: 'Copy watchdog id', onSelect: () => copy(id) }]
      }
      const project=typeof dog.target==='string'?dog.target.replace(/^@/,''):''
      const projectEntry=isProject?.(project)?nodeMenuAction('Project…',anchor,project,agents?.current?.(project,anchor)??[],toast):undefined
      return [{ label: 'Open details', onSelect: () => openDog(dog.id) },
        ...(projectEntry?[projectEntry]:[]),
        ...watchdogActions(dog, action => {
          void watchdogAction(org, dog.id, action).then(r => toast([`${dog.name}: ${r.state}`]))
            .catch((error: Error) => toast([`error: ${error.message}`]))
        }), 'sep', { label: 'Copy watchdog name', onSelect: () => copy(dog.name) },
        { label: 'Copy watchdog id', onSelect: () => copy(dog.id) }]
      }
      return !dog && anchor.getAttribute('data-object-stale') !== 'true'
        ? getWatchdog(org,id).then(page=>menu(page.watchdogs.find(w=>w.id===id))) : menu(dog)
    }
    if (!openTicket || id.includes('/')) return []
    return getWorkItem(org, id).then(async ({ item }) => {
      const name = item.owner?.node
      const entries = name ? agents?.current?.(name) ?? [] : []
      let staffing: QuickStaffPreview | undefined, staffError: string | undefined
      if (ticketStaffable(org, item)) {
        const path = quickStaffPath(org, item.slug)
        staffing = peekQuickStaff<QuickStaffPreview>(path)
        if (!staffing) {
          try { staffing = await prefetchQuickStaff<QuickStaffPreview>(path) }
          catch (error) { staffError = error instanceof Error ? error.message : String(error) }
        }
      }
      return ticketMenuEntries({ org, item, anchor, ownerEntries: entries,
        open: () => openTicket(item.slug), toast, staffing, staffError })
    })
  }, org)
  return null
}

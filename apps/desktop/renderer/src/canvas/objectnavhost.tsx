import { getWorkItem, watchdogAction } from '../api'
import type { ToastFn, Watchdog } from '../types'
import { agentCopyEntry, copyToClipboard } from './contextmenu'
import { ticketReferenceActions, watchdogActions } from './objectactions'
import { useAgentNavRegistry } from './agentnav'
import { useProvideObjectNav } from './objectnav'

/** The current org's existing routes, shared by links and direct object menus. */
export function ObjectNavHost({ org, dogs, openDog, openTicket, focusAgent, toast }:
  { org: string; dogs: Watchdog[]; openDog: (id: string) => void;
    openTicket?: (id: string) => void; focusAgent?: (id: string) => void; toast: ToastFn }) {
  const agents = useAgentNavRegistry()
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
    return getWorkItem(org, id).then(({ item }) => {
      const name = item.owner?.node
      const entries = name ? agents?.current?.(name) ?? [] : []
      const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
      return ticketReferenceActions({ open: () => openTicket(item.slug),
        owner: name ? { label: 'Owner…',
          children: [agentCopyEntry(anchor, name, toast), ...(entries.length ? ['sep' as const, ...entries] : [])],
          actionDisabled: !focus || focus === 'sep' || focus.disabled || focus.actionDisabled,
          onSelect: () => { if (focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled) focus.onSelect() },
        } : undefined,
        copyTitle: () => copy(item.title), copySlug: () => copy(item.slug),
        copyReference: () => copy('@item:' + org + '/' + item.slug) })
    })
  }, org)
  return null
}

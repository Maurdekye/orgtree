import type { MenuEntry } from './contextmenu'
import { agentCopyEntry } from './contextmenu'
import type { ToastFn, Watchdog } from '../types'

/** Identical owner submenu and Focus gate for ticket rows and transcript cards. */
export function ticketOwnerAction(anchor: Element, name: string | undefined,
  entries: MenuEntry[], toast?: ToastFn): Exclude<MenuEntry, 'sep'> | undefined {
  if (!name) return undefined
  const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
  return { label: 'Owner…', agentTooltipId: name,
    children: [agentCopyEntry(anchor, name, toast), ...(entries.length ? ['sep' as const, ...entries] : [])],
    actionDisabled: !focus || focus === 'sep' || focus.disabled || focus.actionDisabled,
    onSelect: () => { if (focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled) focus.onSelect() },
  }
}

/** Transcript order is canonical; docket-only extras follow its own separator. */
export function ticketReferenceActions({ open, owner, copyTitle, copySlug, copyReference, extras = [] }: {
  open: () => void; owner?: Exclude<MenuEntry, 'sep'>;
  copyTitle: () => void; copySlug: () => void; copyReference?: () => void; extras?: MenuEntry[]
}): MenuEntry[] {
  return [{ label: 'Open details', onSelect: open }, ...(owner ? [owner] : []), 'sep',
    { label: 'Copy ticket title', onSelect: copyTitle }, { label: 'Copy slug', onSelect: copySlug },
    ...(copyReference ? [{ label: 'Copy reference', onSelect: copyReference }] : []),
    ...(extras.length ? ['sep' as const, ...extras] : [])]
}

/** The same state gates and commands used by the watchdog detail buttons. */
export function watchdogActions(dog: Watchdog, act: (action: 'pause' | 'resume' | 'remove') => void): MenuEntry[] {
  if (dog.spent) return []
  return [dog.state === 'armed' ? { label: 'Pause', onSelect: () => act('pause') }
    : { label: dog.state === 'exited' ? 'Resume (re-spawn)' : 'Resume', onSelect: () => act('resume') },
    { label: 'Remove', danger: true, onSelect: () => act('remove') }]
}

import type { MenuEntry } from './contextmenu'
import { agentCopyEntry } from './contextmenu'
import { captureDeskMentionAt } from './agentmentions'
import type { ToastFn, Watchdog } from '../types'

/** Canonical node-link submenu, primary Focus action and tooltip, shared by
 * tickets, presentations and generic agent/project links. */
export function nodeMenuAction(label: string, anchor: Element | null, name: string | undefined,
  entries: MenuEntry[], toast?: ToastFn): Exclude<MenuEntry, 'sep'> | undefined {
  if (!name) return undefined
  const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
  return { label, agentTooltipId: name,
    children: [agentCopyEntry(anchor ?? document.body, name, toast), ...(entries.length ? ['sep' as const, ...entries] : [])],
    actionDisabled: !focus || focus === 'sep' || focus.disabled || focus.actionDisabled,
    onSelect: () => { if (focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled) focus.onSelect() },
  }
}

export const nodeMenuEntry = nodeMenuAction

/** Identical owner submenu and Focus gate for ticket rows and transcript cards. */
export function ticketOwnerAction(anchor: Element, name: string | undefined,
  entries: MenuEntry[], toast?: ToastFn): Exclude<MenuEntry, 'sep'> | undefined {
  return nodeMenuAction('Owner…', anchor, name, entries, toast)
}

/** Canonical sender submenu and hover tooltip for reply links. Reuses the
 * sending agent/project/user's normal context menu (including Mention when
 * inside a desk composer scope) and native link hover tooltip. */
export function senderMenuAction(anchor: Element | null, sender: string | undefined,
  entries: MenuEntry[], toast?: ToastFn): Exclude<MenuEntry, 'sep'> | undefined {
  const raw = sender?.trim()
  if (!raw || raw === 'system' || raw === 'SYSTEM' || raw === '@system') return undefined
  const isUser = raw === 'user' || raw === '@user'
  const isExternal = raw.startsWith('@net:') || raw.startsWith('@org:')
  const name = isUser ? '@user' : raw
  const mention = captureDeskMentionAt(anchor, name)
  const mentionItems: MenuEntry[] = mention ? [{ label: 'Mention', onSelect: mention }] : []
  const copyItem = agentCopyEntry(anchor ?? document.body, name, toast)
  const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
  const hasFocus = Boolean(focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled)
  return {
    label: 'Sender…',
    agentTooltipId: !isUser && !isExternal ? name.replace(/^@/, '') : undefined,
    children: [
      ...mentionItems,
      copyItem,
      ...(entries.length ? ['sep' as const, ...entries] : []),
    ],
    actionDisabled: !hasFocus,
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

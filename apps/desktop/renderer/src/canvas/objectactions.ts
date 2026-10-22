import { resolveHubAddressAction, triggerHubAddress, hubAddressMenuEntries } from './agentmentions'
import { USER_IDENTITY_TITLE, userMenuEntries } from './useridentity'
import type { MenuEntry } from './contextmenu'
import { agentLinkMenuEntries } from './contextmenu'
import type { ToastFn, Watchdog } from '../types'

/** Canonical node-link submenu, primary Focus action and tooltip, shared by
 * tickets, presentations and generic agent/project links. */
export function nodeMenuAction(label: string, anchor: Element | null, name: string | undefined,
  entries: MenuEntry[], toast?: ToastFn): Exclude<MenuEntry, 'sep'> | undefined {
  if (!name) return undefined
  const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
  return { label, agentTooltipId: name,
    children: agentLinkMenuEntries(anchor ?? document.body, name, entries, toast),
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
  entries: MenuEntry[], toast?: ToastFn, openUserInbox?: () => void): Exclude<MenuEntry, 'sep'> | undefined {
  const raw = sender?.trim()
  if (!raw || raw === 'system' || raw === 'SYSTEM' || raw === '@system') return undefined
  const isUser = raw === 'user' || raw === '@user'
  if (isUser) return { label: 'Sender…', title: USER_IDENTITY_TITLE, children: userMenuEntries(anchor ?? document.body, openUserInbox, toast),
    actionDisabled: !openUserInbox, onSelect: () => openUserInbox?.() }
  const isExternal = raw.startsWith('@net:') || raw.startsWith('@org:')
  if (isExternal) {
    const action = resolveHubAddressAction(raw)
    return { label: 'Sender…', title: action.title,
      children: hubAddressMenuEntries(anchor ?? document.body, raw), actionDisabled: action.kind === 'inert',
      onSelect: () => { triggerHubAddress(raw) } }
  }
  const name = isUser ? '@user' : raw
  const focus = entries.find(entry => entry !== 'sep' && entry.label === 'Focus')
  const hasFocus = Boolean(focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled)
  return {
    label: 'Sender…',
    agentTooltipId: !isUser && !isExternal ? name.replace(/^@/, '') : undefined,
    children: agentLinkMenuEntries(anchor ?? document.body, name, entries, toast),
    actionDisabled: !hasFocus,
    onSelect: () => { if (focus && focus !== 'sep' && !focus.disabled && !focus.actionDisabled) focus.onSelect() },
  }
}

/** Transcript order is canonical; docket-only extras follow its own separator.
 *  Mention, offered only inside a desk with a live message box, comes first,
 *  as it does on every identity link. */
export function ticketReferenceActions({ open, owner, copyTitle, copySlug, copyReference, mention, extras = [] }: {
  open: () => void; owner?: Exclude<MenuEntry, 'sep'>;
  copyTitle: () => void; copySlug: () => void; copyReference?: () => void; mention?: (() => void) | null;
  extras?: MenuEntry[]
}): MenuEntry[] {
  return [...(mention ? [{ label: 'Mention', onSelect: mention }] : []),
    { label: 'Open details', onSelect: open }, ...(owner ? [owner] : []), 'sep',
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

import type { ToastFn, WorkItem } from '../types'
import { copyToClipboard } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { ticketOwnerAction, ticketReferenceActions } from './objectactions'
import { quickStaffEntry, quickStaffPath } from './quickstaff'
import type { QuickStaffPreview } from './quickstaff'
import { peekQuickStaff } from './staffingoptions'
import { refToken } from './reflinks'

/** The row's existing eligibility gate, shared by every ticket reference. The
 * preview and commit still decide current staffing authority/availability. */
export const ticketStaffable = (org: string | undefined, item: WorkItem): boolean =>
  !!org && !item.archived && item.status === 'backlogged'

export function ticketStaffEntry(org: string | undefined, item: WorkItem, feedback: (text: string) => void,
  preview?: QuickStaffPreview, error?: string): MenuEntry | undefined {
  if (!ticketStaffable(org, item)) return undefined
  if (error) return { label: 'Staff…', disabled: true, title: error, description: error, onSelect: () => {} }
  const held = preview ?? peekQuickStaff<QuickStaffPreview>(quickStaffPath(org!, item.slug))
  return held ? quickStaffEntry(org!, item.slug, held, feedback)
    : { label: 'Staff…', disabled: true, title: 'Loading current staffing choices…', onSelect: () => {} }
}

/** The one complete item menu, used by docket rows and every ticket-link
 * surface. Only a real list can supply its local Show/Hide sub-items action. */
export function ticketMenuEntries({ org, item, anchor, ownerEntries, open, toast, copySlug,
  fold, staffing, staffError, feedback = message => toast?.([message]) }: {
  org?: string; item: WorkItem; anchor: Element; ownerEntries: MenuEntry[]; open: () => void;
  toast?: ToastFn; copySlug?: () => void; fold?: MenuEntry; staffing?: QuickStaffPreview;
  staffError?: string; feedback?: (message: string) => void;
}): MenuEntry[] {
  const copy = (text: string, message = 'Copied!') => {
    void copyToClipboard(anchor, text).then(ok => toast?.([ok ? message : 'Clipboard unavailable']))
  }
  const staff = ticketStaffEntry(org, item, feedback, staffing, staffError)
  return ticketReferenceActions({ open,
    owner: ticketOwnerAction(anchor, item.owner?.node, ownerEntries, toast),
    copyTitle: () => copy(item.title), copySlug: copySlug ?? (() => copy(item.slug)),
    copyReference: org ? () => {
      const ref = refToken({ kind: 'item', org, id: item.slug })
      copy(ref, `copied the reference ${ref}`)
    } : undefined,
    extras: [...(fold ? [fold] : []), ...(staff ? [staff] : [])],
  })
}

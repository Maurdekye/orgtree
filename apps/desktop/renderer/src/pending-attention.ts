import { useSyncExternalStore } from 'react'
import type { DesktopNotification } from '../../../../packages/contracts'

/** WHAT IS STILL WAITING ON THE USER, across every organization.
 *
 *  User ruling 2026-09-12: while any attached question, attention ticket or
 *  urgent mail remains present, the Windows taskbar icon pulses and the
 *  matching in-app toolbar icon carries a small bright dot. Both indicators
 *  read THIS one aggregate, so they can never disagree: resolving one item
 *  leaves both standing while another qualifying item remains, and they clear
 *  together when none do.
 *
 *  The source is the cross-organization attention projection the desktop
 *  notification poll already reads, so no second poller exists and an item in
 *  another organization counts exactly as much as one in the open org.
 *
 *  Notification PREFERENCES are deliberately not consulted. They decide what
 *  interrupts the user through the operating system's notification centre;
 *  these indicators only report that something is waiting, which is the same
 *  claim the existing header badges already make. */
export type PendingKind = Extract<DesktopNotification['kind'], 'question' | 'urgent-mail' | 'work-attention'>
const PENDING_KINDS: readonly PendingKind[] = ['question', 'urgent-mail', 'work-attention']

export interface PendingAttention {
  /** questions and urgent mail — the inbox bell's claim */
  mail: number
  /** tickets flagged for the user — the docket button's claim */
  docket: number
  /** every qualifying identity, so the native pulse can tell a NEW arrival
   *  from the same set seen again on the next poll */
  ids: string[]
}

const EMPTY: PendingAttention = { mail: 0, docket: 0, ids: [] }
let current: PendingAttention = EMPTY
const listeners = new Set<() => void>()

export function pendingAttention(): PendingAttention { return current }

/** Reduce one projection page to the aggregate. Exported for the poll and for
 *  tests; it takes the rows rather than reading anything itself. */
export function summarizePending(rows: readonly DesktopNotification[]): PendingAttention {
  let mail = 0, docket = 0
  const ids: string[] = []
  for (const row of rows) {
    if (!PENDING_KINDS.includes(row.kind as PendingKind)) continue
    ids.push(JSON.stringify([row.org, row.id]))
    if (row.kind === 'work-attention') docket++
    else mail++
  }
  ids.sort()
  return { mail, docket, ids }
}

function same(a: PendingAttention, b: PendingAttention): boolean {
  return a.mail === b.mail && a.docket === b.docket
    && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i])
}

/** Publish the aggregate. An unchanged aggregate notifies nobody, so a poll
 *  that finds the same items again re-renders nothing and — via the native
 *  bridge below — cannot restart the taskbar pulse. */
export function publishPending(next: PendingAttention): boolean {
  if (same(current, next)) return false
  current = next
  for (const listener of [...listeners]) listener()
  return true
}

export function resetPending(): void { current = EMPTY }

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePendingAttention(): PendingAttention {
  return useSyncExternalStore(subscribe, pendingAttention, pendingAttention)
}

import { useSyncExternalStore } from 'react'
import type { DesktopNotification } from '../../../../packages/contracts'

/** WHAT IS STILL WAITING ON THE USER, across every organization.
 *
 *  User ruling 2026-09-12: while any attached question, attention ticket or
 *  urgent mail or terminal failure remains present, the Windows taskbar icon pulses and the
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
export type PendingKind = Extract<DesktopNotification['kind'], 'question' | 'urgent-mail' | 'terminal-failure' | 'work-attention'>
const PENDING_KINDS: readonly PendingKind[] = ['question', 'urgent-mail', 'terminal-failure', 'work-attention']

export interface PendingAttention {
  /** questions, urgent mail and terminal failures — the inbox bell's claim */
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

// ------------------------------------------------- the cross-window mirror
//
// The aggregate is produced by the app-wide notification poll, and in v3 that
// poll runs in EXACTLY ONE window (`notifications.ts`). Every other window
// still renders the standing dot, which claims "something is waiting on you in
// ANY organization" — so without a mirror that dot would be permanently dark
// in every window but one, which is a worse lie than the one it was added to
// remove.
//
// ⚠ localStorage AND ITS `storage` EVENT, NOT A SECOND POLLER OR A NATIVE
// REBROADCAST. Every main window is the same origin, so the owner's write
// reaches the others for free and cannot disagree with what the owner
// published: there is one producer and the followers only ever copy. A second
// poller in each window would be exactly the racing all-org read the single
// owner exists to prevent.
const MIRROR_KEY = 'orgtree-pending-attention-v1'

const parsePending = (raw: string | null): PendingAttention | null => {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const { mail, docket, ids } = v as Partial<PendingAttention>
    if (typeof mail !== 'number' || typeof docket !== 'number') return null
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return null
    return { mail, docket, ids: ids as string[] }
  } catch { return null }
}

/** Keep this window's aggregate in step with the app's.
 *
 *  The OWNER writes what it publishes. A FOLLOWER seeds from the last write
 *  and then tracks it. Returns a teardown, and is a no-op without a DOM. */
export function startPendingMirror(owner: boolean): () => void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return () => {}
  if (owner) {
    const write = () => {
      try { localStorage.setItem(MIRROR_KEY, JSON.stringify(current)) } catch { /* the dot is still live in this window */ }
    }
    write()
    return subscribe(write)
  }
  const seed = parsePending(localStorage.getItem(MIRROR_KEY))
  if (seed) publishPending(seed)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== MIRROR_KEY) return
    const next = parsePending(localStorage.getItem(MIRROR_KEY))
    // a cleared store (key === null) means someone wiped storage; fall back to
    // empty rather than freezing on the last value we happened to see
    publishPending(next ?? EMPTY)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

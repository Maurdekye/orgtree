// Dismissed attention flags (user 2026-09-30: "the dismissal should stop the
// glow immediately, same as how answering a question makes the mail icon stop
// glowing immediately").
//
// The Work button's glow counts the open organization's flagged tickets from
// the tree payload (`work_items_summary.attention`), and its dot counts the
// flagged-ticket rows of the notification aggregate. Both are polled, so a
// dismissal used to leave the glow on until the next read. Every dismiss
// control now goes through `dismissAttention`, which records the dismissed
// RAISE here on the click, and the Work button leaves it out of both, so the
// glow and the dot drop in the same render. A refused dismissal takes the
// record out again: the glow comes back, and the caller shows the error.
//
// ⚠ BY THE RAISE'S OWN IDENTITY, NEVER BY TIMING (coordinator ruling after
// five review rounds of count- and arrival-based guesses). A raise is
// (ticket, `manual_attention.set_rev`): the backend bumps `set_rev` on every
// raise, keeps it on an amendment, and a dismissal must echo it. The tree
// serves every open raise beside its count (`work_items_summary.raises`), and
// each flag notice carries its raise's `rev`. So:
//   • the glow is the tree's count less the dismissed raises THE TREE STILL
//     LISTS — a stale tree keeps listing the dismissed raise and it stays off;
//     a fresh tree no longer lists it and nothing is taken off; a new raise,
//     on any ticket or on the same one, has another identity and counts;
//   • the dot hides exactly the notice rows of dismissed raises, whenever a
//     read delivers them (before the click, in flight, late or stale).
// No record expires on a clock. A dismissed raise never comes back, so its
// record can never hide anything but itself; they are a few bytes each and
// live as long as the window.
//
// The same shape as asksubmitted.ts (a card the user just answered leaves the
// inbox dot on the click): one module-level store, in memory only, so every
// view in this window agrees; after a reload the server is the truth again.
import { useSyncExternalStore } from 'react'
import { dismissWorkItemAttention } from './api'
import { pendingAttention, type FlaggedRow } from './pending-attention'
import type { DismissAttentionResult } from './types'

interface Entry {
  /** does taking this raise down lower the glow's count? Not when an open
   *  question keeps the ticket flagged (ledger `_work_attention`) */
  glow: boolean
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0
const key = (org: string, slug: string, rev: number) => JSON.stringify([org, slug, rev])
function emit() {
  version += 1
  for (const l of [...listeners]) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Re-render on any change to the store. Returns a change counter. */
export function useDismissedAttention(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** Has the user dismissed THIS notice row's raise? A row from an engine that
 *  sends no `rev` cannot be matched, and shows. */
export function attentionDismissed(org: string, row: Pick<FlaggedRow, 'slug' | 'rev'>): boolean {
  return row.rev !== undefined && entries.has(key(org, row.slug, row.rev))
}

/** The organization's flag rows the user has not dismissed — the dot's rows. */
export function flaggedNow(org: string): FlaggedRow[] {
  return pendingAttention().flagged.filter((f) => f.org === org && !attentionDismissed(org, f))
}

/** The Work button's glow count: the tree's count less the dismissed raises
 *  the tree still lists. Without `raises` (an older engine) nothing can be
 *  matched and the count is shown as served. */
export function attentionNow(org: string, served: number,
  raises: readonly (readonly [string, number])[] | undefined): number {
  if (!raises) return served
  const off = raises.filter(([slug, rev]) => entries.get(key(org, slug, rev))?.glow).length
  return Math.max(0, served - off)
}

/** Dismiss a ticket's attention flag. Every dismiss control calls this rather
 *  than the API, so the Work button hears of it on the click. Resolves or
 *  rejects exactly as the API call does. */
export function dismissAttention(org: string, item: {
  slug: string
  manual_attention: { set_rev: number }
  attention_sources?: readonly string[]
}): Promise<DismissAttentionResult> {
  const { slug } = item
  const rev = item.manual_attention.set_rev
  const k = key(org, slug, rev)
  const mine: Entry = { glow: !(item.attention_sources ?? []).includes('question') }
  if (!entries.has(k)) {
    entries.set(k, mine)
    emit()
  }
  return dismissWorkItemAttention(org, slug, rev).then((r) => r, (err: unknown) => {
    // refused: the raise is still up, so the glow comes back with it. Only
    // this call's own record — an earlier accepted click keeps its own.
    if (entries.get(k) === mine && entries.delete(k)) emit()
    throw err
  })
}

/** tests only */
export function resetDismissedAttention(): void {
  entries.clear()
  version += 1
}

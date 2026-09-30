// Dismissed attention flags (user 2026-09-30: "the dismissal should stop the
// glow immediately, same as how answering a question makes the mail icon stop
// glowing immediately").
//
// The Work button's glow counts the open organization's flagged tickets from
// the tree payload (`work_items_summary.attention`), and its dot counts the
// flagged-ticket rows of the notification aggregate. Both are polled, so a
// dismissal used to leave the glow on until the next read. Every dismiss
// control now goes through `dismissAttention`, which records the ticket here
// on the click. The Work button subtracts what is recorded, so the glow and
// the dot drop in the same render. A refused dismissal takes the record out
// again: the glow comes back, and the caller shows the error.
//
// The same shape as asksubmitted.ts (a card the user just answered leaves the
// inbox dot on the click): one module-level store, in memory only, so every
// view in this window agrees; after a reload the server is the truth again.
//
// ⚠ WHEN A RECORD STOPS COUNTING — BY THE TICKET, NOT BY THE COUNT. The
// glow's source is a count, and a count cannot tell "the old flag is still
// counted" from "the old flag went and a new one came" (review-sol: a new
// flag raised elsewhere kept the glow off). So a record stops counting when
// EITHER
//   • the notification list — which names every manually flagged ticket
//     (pending-attention `flagged`) — in a copy published AFTER the dismissal
//     succeeded no longer names this ticket: the server has taken it down,
//     so any count the tree still shows is somebody else's flag; or
//   • the tree's count has come down to what it would be with this and every
//     earlier outstanding dismissal applied (`expect`) — the tree reflects it.
// A ticket the notification list never named (so nothing can say by name
// that it went) falls back to the count, and stops counting SETTLE_MS after
// the dismissal succeeded at the latest.
import { useSyncExternalStore } from 'react'
import { dismissWorkItemAttention } from './api'
import { pendingAttention, pendingVersion } from './pending-attention'
import type { DismissAttentionResult } from './types'

interface Entry {
  org: string
  slug: string
  /** the tree's attention count once this dismissal is applied */
  expect: number
  /** does taking this flag down lower the glow's count? Not when an open
   *  question keeps the ticket flagged (ledger `_work_attention`) */
  glow: boolean
  state: 'sent' | 'done'
  /** the notification list named this ticket when it was dismissed, so its
   *  absence from a later list is proof the flag is down */
  named: boolean
  /** pendingVersion() when the dismissal succeeded */
  doneAt?: number
}

export const SETTLE_MS = 30_000

const entries = new Map<string, Entry>()
/** the latest tree count per organization, as the Work button last read it */
const seen = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
const key = (org: string, slug: string) => JSON.stringify([org, slug])
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

/** the flag is down by name: see the header */
const gone = (e: Entry) => e.named && e.doneAt !== undefined && pendingVersion() > e.doneAt
  && !listed(e.org, e.slug)
const outstanding = (org: string, raw: number) =>
  [...entries.values()].filter((e) => e.org === org && e.glow && raw > e.expect && !gone(e))

/** The Work button's glow count: the tree's count less the dismissals it does
 *  not reflect yet. Also remembers `raw` as this organization's latest count,
 *  which is what the next dismissal's `expect` is measured from. */
export function attentionNow(org: string, raw: number): number {
  seen.set(org, raw)
  return Math.max(0, raw - outstanding(org, raw).length)
}

const listed = (org: string, slug: string) =>
  pendingAttention().flagged.some((f) => f.org === org && f.slug === slug)

/** Forget the records whose flag is known to be down and reflected (see the
 *  header). Called by the Work button after it renders — never during
 *  render, since this changes the store — and whenever either source moves. */
export function settleAttention(org: string, raw: number): void {
  let changed = false
  for (const [k, e] of entries) {
    if (e.org !== org) continue
    if (gone(e) || (e.glow && raw <= e.expect)) { entries.delete(k); changed = true }
  }
  if (changed) emit()
}

/** Is this ticket's flag being (or just been) dismissed? The dot's rows and any
 *  list may hide it on this. */
export function attentionDismissed(org: string, slug: string): boolean {
  return entries.has(key(org, slug))
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
  const k = key(org, slug)
  if (!entries.has(k)) {
    const raw = seen.get(org)
    // measured from the count the button shows, less the dismissals already
    // in flight; an organization the button has not rendered yet has no
    // count to measure from, and its record simply waits for SETTLE_MS
    const expect = raw === undefined ? -1
      : raw - outstanding(org, raw).length - 1
    const glow = !(item.attention_sources ?? []).includes('question')
    entries.set(k, { org, slug, expect, glow, state: 'sent', named: listed(org, slug) })
    emit()
  }
  return dismissWorkItemAttention(org, slug, item.manual_attention.set_rev).then((r) => {
    const e = entries.get(k)
    if (e) {
      e.state = 'done'
      e.doneAt = pendingVersion()
      // only a ticket nothing can name needs the clock
      if (!e.named) {
        setTimeout(() => { if (entries.get(k) === e) { entries.delete(k); emit() } }, SETTLE_MS)
      }
    }
    return r
  }, (err: unknown) => {
    // refused: the flag is still up, so the glow comes back with it
    if (entries.delete(k)) emit()
    throw err
  })
}

/** tests only */
export function resetDismissedAttention(): void {
  entries.clear()
  seen.clear()
  version += 1
}

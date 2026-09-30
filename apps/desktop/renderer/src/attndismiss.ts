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
// ⚠ WHEN A RECORD STOPS COUNTING. The glow's source is a COUNT, not a list,
// so "the tree now reflects this dismissal" is read off the count: each
// record keeps the count it expects once the server has applied it and every
// earlier outstanding dismissal (`expect`), and it stops counting as soon as
// the tree's count is at or below that. A record whose dismissal succeeded
// also stops counting after SETTLE_MS whatever the count says, so a new flag
// raised in the meantime cannot keep a stale subtraction alive for long.
import { useSyncExternalStore } from 'react'
import { dismissWorkItemAttention } from './api'
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

const outstanding = (org: string, raw: number) =>
  [...entries.values()].filter((e) => e.org === org && e.glow && raw > e.expect)

/** The Work button's glow count: the tree's count less the dismissals it does
 *  not reflect yet. Also remembers `raw` as this organization's latest count,
 *  which is what the next dismissal's `expect` is measured from. */
export function attentionNow(org: string, raw: number): number {
  seen.set(org, raw)
  return Math.max(0, raw - outstanding(org, raw).length)
}

/** Forget the records the tree now reflects. Called by the Work button after
 *  it renders (never during render: this changes the store). */
export function settleAttention(org: string, raw: number): void {
  let changed = false
  for (const [k, e] of entries) {
    if (e.org === org && e.glow && raw <= e.expect) { entries.delete(k); changed = true }
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
    entries.set(k, { org, slug, expect, glow, state: 'sent' })
    emit()
  }
  return dismissWorkItemAttention(org, slug, item.manual_attention.set_rev).then((r) => {
    const e = entries.get(k)
    if (e) {
      e.state = 'done'
      setTimeout(() => { if (entries.get(k) === e) { entries.delete(k); emit() } }, SETTLE_MS)
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

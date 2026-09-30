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
// ⚠ TWO SOURCES, EACH TRUSTED FOR WHAT IT CAN SAY (review-sol, twice).
//   • The tree gives only a COUNT, and it may lag. A record keeps subtracting
//     until the tree's count comes down to what it would be with this and
//     every earlier outstanding dismissal applied (`expect`) — the tree then
//     reflects it — or SETTLE_MS after the dismissal succeeded at the latest.
//     The notification list dropping the ticket does NOT end it: a list can be
//     newer than the tree, and the tree would still count the old flag.
//   • The notification list names every manual flag BY INSTANCE (its notice
//     id, `work:<slug>:<epoch>`). A record remembers the ids the list showed
//     for the ticket at the click — the raise the user dismissed — so the
//     list's rows under any OTHER id — another ticket, or the same ticket
//     flagged again, even while the request is in flight — are flags the user
//     has not dismissed.
//     While any record is outstanding, the glow never shows fewer than those:
//     a count cannot tell "the old flag is still counted" from "the old flag
//     went and a new one came", but the list can.
//   • A record is one flag INSTANCE (ticket + `set_rev`), so the new flag can
//     itself be dismissed at once; since the tree counts a ticket once, the
//     newer dismissal takes over the older one's subtraction.
import { useSyncExternalStore } from 'react'
import { dismissWorkItemAttention } from './api'
import { pendingAttention, type FlaggedRow } from './pending-attention'
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
  /** the notice ids the list carried for THIS flag: those rows are hidden,
   *  and a row for the ticket under any other id is a new flag */
  ids: Set<string>
  /** the tree reflects it: it no longer subtracts, but its rows stay hidden
   *  until the record expires, in case the list is the one lagging */
  reflected: boolean
}

export const SETTLE_MS = 30_000

const entries = new Map<string, Entry>()
/** the latest tree count per organization, as the Work button last read it */
const seen = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
/** one record per flag INSTANCE: a flag raised again on the same ticket has a
 *  new `set_rev`, and dismissing it is a new dismissal (review-sol) */
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

/** The rows the list shows for this ticket AT THE CLICK — exactly the raise
 *  the user dismissed, and nothing adopted later (review-sol: the server may
 *  apply the dismissal and take a new raise before its answer arrives, so a
 *  row first seen after the click can be a new flag). A dismissal the list had
 *  not caught up with yet therefore hides no row; if the list then shows it,
 *  the button errs toward showing it until the list drops it. */
function listedAtClick(org: string, slug: string): Set<string> {
  return new Set(pendingAttention().flagged
    .filter((f) => f.org === org && f.slug === slug).map((f) => f.id))
}

const outstanding = (org: string, raw: number) =>
  [...entries.values()].filter((e) => e.org === org && e.glow && !e.reflected && raw > e.expect)

/** Has the user dismissed THIS notice row (this flag instance)? */
export function attentionDismissed(org: string, row: Pick<FlaggedRow, 'slug' | 'id'>): boolean {
  for (const e of entries.values()) {
    if (e.org === org && e.slug === row.slug && e.ids.has(row.id)) return true
  }
  return false
}

/** The organization's flag rows the user has not dismissed — the dot's rows. */
export function flaggedNow(org: string): FlaggedRow[] {
  return pendingAttention().flagged.filter((f) => f.org === org && !attentionDismissed(org, f))
}

/** The Work button's glow count: the tree's count less the dismissals it does
 *  not reflect yet, and never less than the flags the list names that were not
 *  dismissed (see the header). Also remembers `raw` as this organization's
 *  latest count, which is what the next dismissal's `expect` is measured from. */
export function attentionNow(org: string, raw: number): number {
  seen.set(org, raw)
  const out = outstanding(org, raw).length
  if (out === 0) return raw
  return Math.max(0, raw - out, flaggedNow(org).length)
}

/** Stop subtracting the records the tree now reflects. Called by the Work
 *  button after it renders — never during render, since this changes the
 *  store. */
export function settleAttention(org: string, raw: number): void {
  let changed = false
  for (const e of entries.values()) {
    if (e.org === org && e.glow && !e.reflected && raw <= e.expect) { e.reflected = true; changed = true }
  }
  if (changed) emit()
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
  const k = key(org, slug, item.manual_attention.set_rev)
  if (!entries.has(k)) {
    // an EARLIER flag on this ticket, dismissed before: the tree counts a
    // ticket once, so this dismissal takes over its subtraction. The old
    // record keeps hiding its own notice rows until it expires.
    for (const e of entries.values()) {
      if (e.org === org && e.slug === slug) e.reflected = true
    }
    const raw = seen.get(org)
    // measured from the count the button shows, less the dismissals already
    // in flight; an organization the button has not rendered yet has no
    // count to measure from, and its record simply waits for SETTLE_MS
    const expect = raw === undefined ? -1
      : raw - outstanding(org, raw).length - 1
    const glow = !(item.attention_sources ?? []).includes('question')
    const e: Entry = { org, slug, expect, glow, state: 'sent',
      ids: listedAtClick(org, slug), reflected: false }
    entries.set(k, e)
    emit()
  }
  return dismissWorkItemAttention(org, slug, item.manual_attention.set_rev).then((r) => {
    const e = entries.get(k)
    if (e && e.state === 'sent') {
      e.state = 'done'
      // the tree normally reflects it well before this; the bound is for a
      // count that never comes down to `expect` (a new flag arrived meanwhile)
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

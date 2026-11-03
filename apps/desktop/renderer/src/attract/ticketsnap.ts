/* attract/ticketsnap.ts - what changed in a ticket since this window last showed it.

   USER 2026-11-03 11:15:07Z m73037cb0a404 "when attract mode opens a ticket
   that's changed, it should expand the relevant sections & scroll down to the
   content that's changed", refined 11:15:22Z m472583486fbb "should observe the
   diff to locate where exactly that occurred at, first position". Decision
   @coordinator-opus mf102bc2f510a: NO new engine storage. The engine keeps
   only the NAMES of the fields each revision changed (docket.rs
   record_changes, not on the wire) and no per-user last-seen marker, and no
   old text. So this window remembers, in memory only, the text of every ticket
   it has shown (the docket pane records it, and attract records it after its
   own showing), with the rev. The fallback chain when there is nothing to
   diff against:
     1. a text snapshot older than the item: the FIRST differing position, in
        the order the pane draws the text (this file's `firstTextChange`);
     2. no snapshot (first sight since the window opened, or a restart): the
        item's history rows since the window's last input - an evidence row
        points at EVIDENCE NOTES (`historySection`); a plain update row names
        no field;
     3. nothing determinable: the top of the ticket, as before.

   The text fields are exactly the ones the pane draws through DocketSelection
   (canvas/docketselection.tsx), named the way it names them, so the DOM can be
   found again from a `field` + `entry`. */
import type { WorkItem } from '../types'

export interface TicketField {
  /** `field` or `field#entry` - the pane's `data-docket-field` / `data-docket-entry` */
  id: string
  field: string
  entry?: number
  /** the pane's section title (the state reason's section is called STATE here) */
  section: string
  text: string
}

export type TicketChange =
  | { kind: 'text'; field: string; section: string; offset: number; length: number
      /** the changed characters (at most 2000), or for a pure deletion the text next to the cut: what the DOM is searched for */
      snippet: string }
  | { kind: 'section'; section: string }

/** the item's text, in the order the ticket pane draws it */
export function ticketFields(item: Pick<WorkItem, 'objective' | 'blocked_reason' | 'dropped_reason' | 'status'
  | 'done_so_far' | 'working_on_next' | 'evidence'>): TicketField[] {
  const out: TicketField[] = []
  const add = (field: string, section: string, text: unknown, entry?: number) => {
    if (typeof text !== 'string' || !text) return
    out.push({ id: entry === undefined ? field : `${field}#${entry}`, field, ...(entry === undefined ? {} : { entry }), section, text })
  }
  add('objective', 'DESCRIPTION', item.objective)
  if (item.status === 'blocked') add('blocked_reason', 'STATE', item.blocked_reason)
  else if (item.status === 'dropped') add('dropped_reason', 'STATE', item.dropped_reason)
  ;(item.done_so_far ?? []).forEach((t, i) => add('done_so_far', 'DONE SO FAR', t, i))
  ;(item.working_on_next ?? []).forEach((t, i) => add('working_on_next', 'WORKING ON / NEXT', t, i))
  ;(item.evidence ?? []).forEach((e, i) => add('evidence.note', 'EVIDENCE NOTES', e?.note, i))
  return out
}

/** The first change, in the pane's order. A new field or entry points at the
 *  whole of it; an edit at the span between the common beginning and the common
 *  end of the old and new text (length 0 = text was only removed there); an entry
 *  that only disappeared points at its section. Null when no text differs. */
export function firstTextChange(before: TicketField[], after: TicketField[]): TicketChange | null {
  const old = new Map(before.map(f => [f.id, f]))
  for (const f of after) {
    const b = old.get(f.id)
    if (!b) return { kind: 'text', field: f.id, section: f.section, offset: 0, length: f.text.length, snippet: f.text.slice(0, 2000) }
    if (b.text === f.text) continue
    const limit = Math.min(b.text.length, f.text.length)
    let p = 0
    while (p < limit && b.text[p] === f.text[p]) p++
    let s = 0
    while (s < limit - p && b.text[b.text.length - 1 - s] === f.text[f.text.length - 1 - s]) s++
    const length = f.text.length - s - p
    const snippet = length > 0 ? f.text.slice(p, p + Math.min(length, 2000))
      : f.text.slice(p, p + 40) || f.text.slice(Math.max(0, p - 40), p)
    return { kind: 'text', field: f.id, section: f.section, offset: p, length, snippet }
  }
  const kept = new Set(after.map(f => f.id))
  const gone = before.find(f => !kept.has(f.id))
  return gone ? { kind: 'section', section: gone.section } : null
}

/** Without a snapshot: the history rows since the window's last input. Only an
 *  evidence row names its place; an update row does not say which field moved. */
export function historySection(item: Pick<WorkItem, 'history'>, sinceMs: number): string | null {
  if (!Array.isArray(item.history)) return null
  for (const row of item.history as Array<{ op?: unknown; at?: unknown }>) {
    if (!row || row.op !== 'evidence' || typeof row.at !== 'string') continue
    if (Date.parse(row.at) > sinceMs) return 'EVIDENCE NOTES'
  }
  return null
}

/** Where the change is, by the fallback chain above; null shows the top. */
export function locateChange(snapshot: TicketSnapshot | null, item: WorkItem, sinceMs: number): TicketChange | null {
  if (snapshot) {
    if (item.rev <= snapshot.rev) return null
    return firstTextChange(snapshot.fields, ticketFields(item))
  }
  const section = historySection(item, sinceMs)
  return section ? { kind: 'section', section } : null
}

// ---------------------------------------------------------------- the store
export interface TicketSnapshot { rev: number; fields: TicketField[] }

/** @coordinator-opus mf102bc2f510a: LRU at 200 items and about 2 MB of text */
export const SNAPSHOT_MAX_ITEMS = 200
export const SNAPSHOT_MAX_BYTES = 2_000_000

const store = new Map<string, TicketSnapshot & { bytes: number }>()
let total = 0
const keyOf = (org: string, slug: string) => `${org}\u0000${slug}`

/** Remember what this window shows of `item` now (replaces the older copy). */
export function recordTicketSnapshot(org: string, item: WorkItem): void {
  const fields = ticketFields(item)
  const bytes = fields.reduce((n, f) => n + f.text.length, 0)
  const key = keyOf(org, item.slug)
  const had = store.get(key)
  if (had) { total -= had.bytes; store.delete(key) }
  store.set(key, { rev: item.rev, fields, bytes })
  total += bytes
  for (const [k, v] of store) {
    if (store.size <= SNAPSHOT_MAX_ITEMS && total <= SNAPSHOT_MAX_BYTES) break
    if (k === key) continue
    total -= v.bytes
    store.delete(k)
  }
}

/** What this window last showed of the ticket; a read counts as use. */
export function ticketSnapshot(org: string, slug: string): TicketSnapshot | null {
  const key = keyOf(org, slug)
  const v = store.get(key)
  if (!v) return null
  store.delete(key); store.set(key, v)
  return v
}

export function clearTicketSnapshots(): void { store.clear(); total = 0 }

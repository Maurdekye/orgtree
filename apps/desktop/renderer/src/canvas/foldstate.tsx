// canvas/foldstate.tsx — WHERE "I OPENED THIS" LIVES.
//
// USER BUG 2026-09-12: a transcript message the operator had expanded collapsed
// itself as soon as the next event arrived, in the middle of being read.
//
// THE MECHANISM. Every foldable part of a transcript row — a tool chip's
// result, a thought, a compaction summary — used to keep its open/closed flag
// in its OWN `useState`. That is state tied to the component instance, and a
// component instance lives exactly as long as its React key stays the same.
// The transcript row's key is `assistant_id ?? native_event_id ?? row_id ??
// event_id ?? seq ?? index` (desk.tsx), and those are not one identity: a row
// that arrives as a streaming assistant snapshot is keyed by its assistant_id,
// and when the durable projection replaces it the key becomes its
// native_event_id. Different key, so React unmounts the old subtree and mounts
// a new one — and every open fold inside it goes back to closed. A row with no
// id at all falls all the way through to the INDEX, which renames every row
// below any prepend.
//
// THE FIX is not a better row key (there is no single field every producer
// sets, and the key also has to keep rows distinct, which is a different job).
// It is to stop storing the flag somewhere a remount can destroy: the set of
// open folds lives in the DESK, above every row, keyed by the part's own
// DURABLE id — the tool_use_id, the thinking record's event id, the compaction
// row's event id. Those are the same ids the render-boundary dedup pass keys
// on, and they do not change when a row is re-projected, re-ordered, paged or
// re-rendered mid-stream.
//
// WHAT STAYS LOCAL. A part with no durable id of its own (a legacy row, a chip
// the producer gave no tool_use_id) keeps the old per-instance state: there is
// nothing honest to key it by, and inventing a positional key would move one
// row's expansion onto another the first time the list shifted. Same for a
// surface that renders rows without a provider — the read-only lineage
// transcript, which has no live updates to survive in the first place.
//
// STALE STATE IS SWEPT. `prune` is given the keys that actually rendered and
// drops everything else, so a message that genuinely left the transcript
// leaves nothing behind. It is a no-op when nothing needs dropping, so it can
// be called from an effect on every render without looping.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ChatMessage, LiveRowPayload, ToolChip } from '../types'

export interface FoldStore {
  /** the keys currently open — a NEW set on every change, so consumers behind
   *  `memo` still re-render (React propagates a changed context value through
   *  a memoized boundary; an unchanged one it may skip) */
  open: ReadonlySet<string>
  toggle(key: string): void
}

const FoldContext = createContext<FoldStore | null>(null)
export const FoldProvider = FoldContext.Provider

/** the chip's durable name. `id` is the tool_use_id — the same id the desk's
 *  dedup pass claims for this chip, and the one a live row and its settled
 *  twin have always shared. The event ids behind it cover a producer that
 *  wrote no tool_use_id. */
export function toolFoldKey(t: ToolChip | string | null | undefined): string | undefined {
  if (!t || typeof t === 'string') return undefined
  const id = t.id ?? t.event_id ?? t.result_event_id
  return id ? 'tool:' + id : undefined
}

/** a thought's own event id — its own right-click target, so its own fold */
export function thoughtFoldKey(id: string | null | undefined): string | undefined {
  return id ? 'think:' + id : undefined
}

/** a system row (today: the compaction boundary and its summary) */
export function sysFoldKey(m: ChatMessage): string | undefined {
  const id = m.native_event_id ?? m.event_id
  return id ? 'sys:' + id : undefined
}

/** every fold key the given rows would render. The desk hands this to `prune`,
 *  so "still on screen" is decided by what was actually drawn rather than by
 *  what some other list happens to still remember. */
export function foldKeysOf(
  messages: readonly ChatMessage[], live: readonly LiveRowPayload[] = [],
): Set<string> {
  const out = new Set<string>()
  const add = (k: string | undefined) => { if (k) out.add(k) }
  for (const m of messages) {
    add(sysFoldKey(m))
    add(thoughtFoldKey(m.thinking_event_id))
    for (const t of m.tools ?? []) add(toolFoldKey(t))
  }
  for (const r of live) add(thoughtFoldKey(r.event_id))
  return out
}

/** Read and flip one fold. `key` absent (no durable id) or no provider above
 *  → the old per-instance behaviour, unchanged. */
export function useFold(key: string | undefined): [boolean, () => void] {
  const store = useContext(FoldContext)
  const [local, setLocal] = useState(false)
  const flipLocal = useCallback(() => setLocal((o) => !o), [])
  const flipShared = useCallback(() => { if (key) store?.toggle(key) }, [store, key])
  if (!store || !key) return [local, flipLocal]
  return [store.open.has(key), flipShared]
}

export interface FoldState {
  store: FoldStore
  /** drop every open key that is not in `live` — no-op when there is nothing
   *  to drop, so an effect may call it on every render */
  prune(live: ReadonlySet<string>): void
}

export function useFoldState(): FoldState {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  // `toggle` must not change identity when the set does, or every chip's
  // onClick would be a new function on every fold
  const toggle = useCallback((key: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(key)) next.add(key)
    return next
  }), [])
  const prune = useCallback((live: ReadonlySet<string>) => setOpen((prev) => {
    if (!prev.size) return prev
    let stale = false
    for (const k of prev) if (!live.has(k)) { stale = true; break }
    if (!stale) return prev                       // the common case: no render
    const next = new Set<string>()
    for (const k of prev) if (live.has(k)) next.add(k)
    return next
  }), [])
  const store = useMemo<FoldStore>(() => ({ open, toggle }), [open, toggle])
  return { store, prune }
}

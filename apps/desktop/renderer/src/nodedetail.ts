/** §4.8 — resolve a summarised (archived) seat back to a whole node.
 *
 *  Lives apart from `archived.ts` only to keep the import graph acyclic:
 *  `api.ts` imports the hydrator from `archived.ts`, so `archived.ts` cannot
 *  import `api.ts` back.
 *
 *  ⚠ RETURNS THE NODE UNCHANGED for a live seat and for any seat an older
 *  engine sent whole, so a call site can use it unconditionally. That is the
 *  point: a surface that needs `scope` or the full `charter` should not have to
 *  ask whether this particular card happens to be archived.
 */
import { useEffect, useState } from 'react'

import { getNodeDetail } from './api'
import { isSummary, nodeDetail } from './archived'
import type { NodeDetail, Summarisable } from './archived'

export interface Resolved<T> {
  /** the whole node once detail has landed; the summary until then */
  node: T
  /** false while a summarised seat is still being fetched */
  ready: boolean
  /** the fetch failed — the seat may have been deleted since the tree listed it */
  error: Error | null
}

export function useNodeDetail<T extends Summarisable>(
  slug: string, node: T,
): Resolved<T> {
  const summary = isSummary(node)
  const [got, setGot] = useState<NodeDetail | null>(null)
  const [error, setError] = useState<Error | null>(null)
  // ⚠ `detail_rev` IS IN THE STAMP, not just in the cache key, and that is
  // what makes a REMOTE edit reach a panel that is already open. The cache key
  // alone only helps the next caller; a mounted consumer would sit on the
  // detail it fetched once and never ask again. With the revision here, the
  // tree refresh that carries a new one re-runs this effect, and the panel
  // updates in place — it keeps showing what it has while the new answer is in
  // flight rather than dropping back through the gate. (The generation is here
  // for the same reason at a coarser grain: rehiring mints a new one, and a
  // charter cached from the seat's previous life looks perfectly correct.)
  const stamp = JSON.stringify(
    [slug, node.id, node.generation ?? null, node.detail_rev ?? null, summary])
  useEffect(() => {
    setError(null)
    if (!summary) { setGot(null); return }
    let live = true
    nodeDetail(slug, node, getNodeDetail)
      .then((d) => { if (live) setGot(d) })
      .catch((e: Error) => { if (live) setError(e) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])
  if (!summary) return { node, ready: true, error: null }
  // ⚠ the SUMMARY's children win: the detail answer carries none by design
  // (fetching one seat must not rebuild the pile it was opened from)
  return got
    ? { node: { ...node, ...got,
                children: (node as { children?: unknown }).children } as T,
        ready: true, error }
    : { node, ready: false, error }
}

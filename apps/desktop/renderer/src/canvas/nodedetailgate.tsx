/** §4.8 — hold a panel until a summarised (archived) seat is whole.
 *
 *  Most surfaces can render from the summary and upgrade when detail lands.
 *  Two cannot: the config panel dereferences `node.scope!` and the lineage
 *  panel walks `node.lineage`, and neither field is on an archived summary —
 *  rendering early would not look stale, it would throw.
 *
 *  So this gate exists for the panels that REQUIRE a field the summary omits.
 *  Do not reach for it when a blank line for a moment would do; a spinner in
 *  front of a live seat that never needed fetching is a regression.
 */
import type { ReactNode } from 'react'

import type { Summarisable } from '../archived'
import { useNodeDetail } from '../nodedetail'

export function NodeDetailGate<T extends Summarisable>({ slug, node, children }: {
  slug: string
  node: T
  children: (node: T) => ReactNode
}) {
  const { node: resolved, ready, error } = useNodeDetail(slug, node)
  if (error) {
    // the seat can be deleted between the tree that listed it and this click
    return (
      <div className="detail-missing" role="alert">
        This agent’s details could not be loaded — it may have been deleted.
        <div className="dim">{error.message}</div>
      </div>
    )
  }
  if (!ready) return <div className="detail-loading dim">Loading agent…</div>
  return <>{children(resolved)}</>
}

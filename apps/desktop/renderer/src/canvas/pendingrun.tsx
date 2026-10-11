import { useState } from 'react'
import type { ReactNode } from 'react'

/** A local disclosure only: callers supply rows AFTER their normal dedup pass.
 * Keep cards mounted so their own folds, reply anchors and actions survive. */
export function PendingRun({ count, children, onToggle }: {
  count: number; children: ReactNode; onToggle: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = count >= 6
  return <details className="pending-run" open={!collapsible || expanded}
    onToggle={e => {
      if (e.target !== e.currentTarget) return
      if (collapsible) setExpanded(e.currentTarget.open)
      onToggle()
    }}>
    <summary hidden={!collapsible}>
      {count} queued / undelivered — {expanded ? 'Hide' : 'Show'}
    </summary>
    <div className="pending-run-rows">{children}</div>
  </details>
}

/** Native disclosure opens synchronously, before the caller measures/scrolls. */
export function revealPendingRun(element: HTMLElement): void {
  const run = element.closest<HTMLDetailsElement>('details.pending-run')
  if (run) run.open = true
}

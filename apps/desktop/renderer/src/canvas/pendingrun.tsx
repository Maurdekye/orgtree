import { useState } from 'react'
import type { ReactNode } from 'react'

/** A local disclosure only: callers supply rows AFTER their normal dedup pass.
 * Keep cards mounted so their own folds, reply anchors and actions survive. */
export function PendingRun({ count, children, onToggle }: {
  count: number; children: ReactNode; onToggle: () => void
}) {
  // null follows the six-row default. An explicit choice wins until this
  // visible run unmounts, including when its count crosses the threshold.
  const [choice, setChoice] = useState<boolean | null>(null)
  const expanded = choice ?? count < 6
  return <details className="pending-run" open={expanded}
    onToggle={e => {
      if (e.target !== e.currentTarget) return
      // Native/programmatic reveal is also a deliberate opening. Do not
      // mistake an initial or count-driven open-attribute change for a choice.
      if (e.currentTarget.open !== expanded) setChoice(e.currentTarget.open)
      onToggle()
    }}>
    <summary>
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

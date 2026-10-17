import type { ReactNode } from 'react'
import { TierChip } from './identity'
import { tierLabel } from './shared'

/** Historical models use recorded tiers, while the agent link keeps its
 * current model. Omit the redundant NEW card only when that current fact is
 * known to equal it. Never bind old cards to a current agent tooltip. */
export function ModelChange({ change, currentTier, children }: {
  change?: { from?: string | null; to: string }
  currentTier?: string | null
  children: ReactNode
}) {
  const to = typeof change?.to === 'string' ? change.to.trim() : ''
  const from = typeof change?.from === 'string' ? change.from.trim() : ''
  if (!to || from === to || (!from && currentTier === to)) return <>{children}</>
  return <span className="tool-model-transition"
    aria-label={from ? `Model changed: ${tierLabel(from)} → ${tierLabel(to)}` : `Model changed to ${tierLabel(to)}`}
    onClick={e => e.stopPropagation()}>
    {from && <TierChip tier={from} />}
    <span className="dim tool-model-arrow" aria-hidden="true">→</span>
    {currentTier !== to && <TierChip tier={to} />}
    {children}
  </span>
}

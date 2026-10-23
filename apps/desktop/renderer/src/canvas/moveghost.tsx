import type { TreePayload } from '../types'
import type { NewHirePosition } from '../hireposition'
import { withPendingOrder, type PendingOrder } from './pendingorder'
import { canonPiles, pruneRetiredView, viewPiles, viewHidden, canvasTargets } from './canvaslayout'
import { USER, DRAFT, INBOX, NODE_W, NODE_H, flatten, withDraftTree, withPendingMoves, treeParents } from './shared'
import type { Pt, ChartLayout, DraftState, PendingMoves } from './shared'

export type MoveGhostOptions = {
  draft: DraftState | null
  newHirePosition?: NewHirePosition
  seats: Record<string, number>
  pileFront: Record<string, string>
  crowdPiles: boolean
  hideRetired: boolean
  shownRetired: ReadonlySet<string>
  chartLayout: ChartLayout
  inboxPxc: number
  draftCredits?: number
  bunchProjects?: boolean
}

/** Project moveShown's final layout, then return the moved node's offset
 * from its new superior. The canvas anchors this to the superior's current
 * spring position without rerunning the projection on animation frames. */
export function moveGhostOffset(tree: TreePayload, moves: PendingMoves,
  orders: ReadonlyMap<string, PendingOrder>, id: string, drop: string | null,
  options: MoveGhostOptions): Pt | undefined {
  if (!drop || drop === DRAFT || drop === INBOX || id === USER || id === DRAFT) return undefined
  let current = withPendingMoves(tree, moves)
  for (const entry of orders.values()) current = withPendingOrder(current, entry)
  if (drop !== USER && flatten(withDraftTree(current, null), options.seats).get(drop)?.state !== 'live') return undefined
  const parent = drop === USER ? null : drop
  if (treeParents(current).get(id) === parent) return undefined
  // The projection itself rejects unknown, non-live sources and cycles.
  if (withPendingMoves(current, new Map([[id, parent]])) === current) return undefined
  let projected = withPendingMoves(tree, new Map(moves).set(id, parent))
  for (const entry of orders.values())
    if (!entry.block.includes(id)) projected = withPendingOrder(projected, entry)
  const full = canonPiles(withDraftTree(projected, options.draft, options.newHirePosition))
  const root = pruneRetiredView(full, options.hideRetired, options.shownRetired).root
  const map = flatten(full, options.seats)
  const piles = viewPiles(root, options.pileFront, options.crowdPiles, options.hideRetired, options.shownRetired)
  const hidden = viewHidden(root, piles)
  const targets = canvasTargets(root, map, hidden, options.chartLayout, tree, options.inboxPxc, options.draftCredits, options.bunchProjects, options.hideRetired)
  const moved = targets.get(id), superior = targets.get(drop)
  return moved && superior ? { x: moved.x - superior.x, y: moved.y - superior.y } : undefined
}

export function MoveGhost({ point, zoom }: { point: Pt; zoom: number }) {
  return <rect data-move-ghost="" x={point.x} y={point.y} width={NODE_W} height={NODE_H}
    rx={8} fill="none" stroke="var(--accent)" strokeWidth={2 / zoom}
    strokeDasharray={`${6 / zoom} ${4 / zoom}`} pointerEvents="none" />
}

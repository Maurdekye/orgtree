import { peerOrder, USER } from './shared'
import type { CanvasNode, Pt } from './shared'

export type OrgDirection = 'up' | 'down' | 'previous' | 'next'

/** Physical visible placement: projects are stops, lineage/drafts are not. */
export function orgNavigationTarget(direction: OrgDirection, current: string | null,
  map: Map<string, CanvasNode>, positions: Map<string, Pt>, hidden: { has(id: string): boolean }, circular: boolean): string | null {
  const visible = (id: string) => id === USER || !!map.get(id)
    && !map.get(id)!.isBearerOf && map.get(id)!.state !== 'draft'
    && positions.has(id) && !hidden.has(id)
  if (!current || !visible(current)) return null
  const node = map.get(current)
  if (direction === 'up') {
    if (current === USER) return null
    const parent = node?.parent ?? USER
    return visible(parent) ? parent : null
  }
  const candidates = direction === 'down'
    ? (node?.children ?? []).map(child => child.id)
    : [...map.values()].filter(other => other.parent === node?.parent).map(other => other.id)
  const order = peerOrder(candidates.filter(id => id !== USER && visible(id)), positions, circular)
  if (!order.length) return null
  if (direction === 'down') return order[Math.floor((order.length - 1) / 2)]!
  const at = order.indexOf(current)
  if (at < 0) return null
  return order[(at + (direction === 'next' ? 1 : -1) + order.length) % order.length]!
}

/** Session-only, bounded per-org agent history. Projects and overview preserve it. */
export class AgentFocusHistory {
  private visits: string[] = []
  record(id: string): void {
    if (this.visits.at(-1) === id) return
    this.visits.push(id)
    if (this.visits.length > 256) this.visits.shift()
  }
  back(current: string | null, exists: (id: string) => boolean): string | null {
    let index = this.visits.length - 1
    if (this.visits[index] === current) index--
    while (index >= 0 && !exists(this.visits[index]!)) index--
    if (index < 0) return null
    this.visits.length = index + 1
    return this.visits[index]!
  }
}
const histories = new Map<string, AgentFocusHistory>()
export function agentFocusHistory(org: string): AgentFocusHistory {
  let history = histories.get(org)
  if (!history) { history = new AgentFocusHistory(); histories.set(org, history) }
  return history
}

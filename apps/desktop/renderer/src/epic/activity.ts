import type { TreeNode, TreePayload } from '../types'

export const ACTIVITY_LAYERS = ['hum', 'thinking', 'writing', 'toolWriting', 'tool', 'waiting', 'compacting'] as const
export type ActivityLayer = typeof ACTIVITY_LAYERS[number]
export type ActivityCounts = Record<ActivityLayer, number>
export interface ActivitySource { id: string; layer: Exclude<ActivityLayer, 'hum'> | null }
export const emptyActivity = (): ActivityCounts =>
  ({ hum: 0, thinking: 0, writing: 0, toolWriting: 0, tool: 0, waiting: 0, compacting: 0 })

/** Same live state as the desks. A status of "working" alone is not a turn. */
export function activitySources(tree: TreePayload | null): ActivitySource[] {
  if (!tree || tree.killswitch) return []
  const sources: ActivitySource[] = []
  const visit = (node: TreeNode) => {
    if (node.kind !== 'project' && node.state === 'live' && node.busy && !node.frozen
        && node.halt?.phase !== 'halted' && !node.limit_locked) {
      const phase = node.activity?.phase
      const layer = node.mcp_readiness_waiting || node.waiting || phase === 'waiting' ? 'waiting'
        : node.phase === 'compacting' ? 'compacting'
        : phase === 'thinking' || phase === 'writing' || phase === 'tool' ? phase
        : phase === 'tool_writing' ? 'toolWriting' : null
      sources.push({ id: node.id, layer })
    }
    for (const child of node.children ?? []) visit(child)
  }
  for (const root of tree.roots ?? []) visit(root)
  return sources
}

export function countActivity(sources: readonly ActivitySource[]): ActivityCounts {
  const counts = emptyActivity()
  for (const source of sources) { counts.hum++; if (source.layer) counts[source.layer]++ }
  return counts
}

/** Fourfold rise from one to fifteen agents (12 dB), then capped. */
export function activityScale(count: number): number {
  return Number.isFinite(count) ? Math.min(1, Math.log2(1 + Math.max(0, count)) / 4) : 0
}

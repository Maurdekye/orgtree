import type { ChatPayload, ToolTokenCount, TreeNode } from './types'

export function readToolTokens(value: unknown): Record<string, ToolTokenCount> {
  const counts: Record<string, ToolTokenCount> = Object.create(null)
  if (!Array.isArray(value)) return counts
  for (const v of value.slice(0, 64)) {
    if (v && typeof v.id === 'string' && v.id.length <= 256
        && Number.isSafeInteger(v.output_tokens) && v.output_tokens >= 0
        && typeof v.output_tokens_estimated === 'boolean') {
      counts[v.id] = { id: v.id, output_tokens: v.output_tokens,
        output_tokens_estimated: v.output_tokens_estimated, output_tokens_sampled: v.output_tokens_sampled === true }
    }
  }
  return counts
}

/** A stale transcript poll cannot hide the current turn's agent runtime reading. */
export function contextReading(node: Partial<Pick<TreeNode, 'busy' | 'context_live' | 'occupancy' | 'occupancy_est' | 'context_window'>>,
  chat?: Pick<ChatPayload, 'occupancy' | 'occupancy_estimated' | 'context_window'> | null) {
  if (node.busy && node.context_live && typeof node.occupancy === 'number') {
    return { used: node.occupancy, estimated: false, window: node.context_window }
  }
  return { used: chat?.occupancy ?? node.occupancy,
    estimated: chat?.occupancy != null ? chat.occupancy_estimated : node.occupancy_est,
    window: chat?.context_window ?? node.context_window }
}

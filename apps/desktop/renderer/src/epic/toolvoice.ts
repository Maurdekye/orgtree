export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^mcp__.*?__/, '')
    .replace(/^(?:functions|tools|tool)\./, '').replace(/^mcp[.:/][^.:/]+[.:/]/, '') || 'tool'
}

/** Stable FNV-1a identity; no family table or random sound decisions. */
export function toolVoice(name: string) {
  let hash = 2166136261
  for (const ch of normalizeToolName(name)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
  const scale = [0, 2, 4, 7, 9]
  const degree = hash % 20
  const midi = 48 + 12 * Math.floor(degree / 5) + scale[degree % 5]!
  return {
    hz: 440 * 2 ** ((midi - 69) / 12),
    interval: [3, 4, 5, 7, 9, 12][(hash >>> 5) % 6]!,
    type: (['sine', 'triangle', 'square'] as const)[(hash >>> 9) % 3]!,
    attack: 0.004 + ((hash >>> 12) & 255) / 255 * 0.035,
    duration: 0.14 + ((hash >>> 20) & 255) / 255 * 0.22,
    filter: 650 + ((hash >>> 16) & 255) / 255 * 1800,
  }
}

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^mcp__.*?__/, '')
    .replace(/^(?:functions|tools|tool)\./, '').replace(/^mcp[.:/][^.:/]+[.:/]/, '') || 'tool'
}

/** Stable FNV-1a identity; no family table or random sound decisions. */
export function toolVoice(name: string) {
  let hash = 2166136261
  for (const ch of normalizeToolName(name)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0
  return {
    family: (['thunk', 'clunk', 'clank', 'stamp'] as const)[hash % 4]!,
    hz: 72 + ((hash >>> 2) & 255) / 255 * 228,
    interval: [5, 7, 12][(hash >>> 5) % 3]!,
    resonance: [1.42, 1.73, 2.08, 2.71][(hash >>> 7) % 4]!,
    type: (['sine', 'triangle', 'square'] as const)[(hash >>> 9) % 3]!,
    attack: 0.001 + ((hash >>> 12) & 255) / 255 * 0.005,
    duration: 0.14 + ((hash >>> 20) & 255) / 255 * 0.22,
    filter: 650 + ((hash >>> 16) & 255) / 255 * 1800,
  }
}

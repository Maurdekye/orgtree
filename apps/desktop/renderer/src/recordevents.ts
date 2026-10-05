/** Agent-scoped invalidation for disk-backed panels. No global changed wake. */
export interface AgentPanelEvent { org: string; node: string; type: 'node_event' | 'node_stream'; event?: string }
const listeners = new Set<(event: AgentPanelEvent) => void>()
export function publishAgentPanelEvent(event: AgentPanelEvent): void {
  for (const listener of [...listeners]) listener(event)
}
export function onAgentPanelEvent(listener: (event: AgentPanelEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
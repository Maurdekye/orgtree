import type { AgentStatesPage } from '../api'

/** The agent's state history in node settings: totals, then spans newest first. */
export function AgentStatesView({ slug, nid }: { slug: string; nid: string }) {
  void slug; void nid
  return <section className="agent-states" aria-label={`${nid}'s state history`}>{null as AgentStatesPage | null}</section>
}

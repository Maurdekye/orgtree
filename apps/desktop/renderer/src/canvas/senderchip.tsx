// canvas/senderchip.tsx — the user inbox's sender identity: the tier chip and
// the name, and a jump to the agent's desk when the tree holds it. Shared by
// the inbox (App.tsx) and the Attention view, which shows the same mail with
// the same chip (user 2026-09-29: bodies identical to their own detail views).

import { agentNavProps } from './agentnav'
import { SYSTEM, TIER_LETTER, tierLabel, USER } from './shared'
import type { TreeNode } from '../types'

export function SenderChip({ id, nodes, onFocusAgent }: {
  id: string
  nodes: Map<string, TreeNode>
  onFocusAgent?: (agentId: string) => void
}) {
  if (id === SYSTEM || id === 'system') return <b className="dim">system</b>
  if (id === USER) return <b>you</b>
  const n = nodes.get(id)
  // ⚠ ONLY AN ESTABLISHED LOCAL NODE NAVIGATES: a name this tree does not hold
  // stays readable and loses a route that was never there.
  if (!n) return <b>{id}</b>
  const chip = (
    <span data-copy-agent-name={id} className={'sender ' + (n?.state ?? '')} title={n ? `${tierLabel(n.tier)} · ${n.state}` : id}>
      {n && <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier] ?? '?'}</span>}
      <b>{id}</b>
    </span>
  )
  if (onFocusAgent) {
    return (
      /* ⚠ stopPropagation is load-bearing since this chip moved into the mail
         LIST ROW as well as the reading pane: the row's own onClick toggles
         selection, so without it clicking a sender's name would jump AND
         select (or, on the open mail, deselect the thing you were reading).
         `AgentName` stops it for the same reason; the two must not drift.
         type="button" for the same reason `AgentName` carries one — this is
         rendered inside forms, where the default submit would be wrong. */
      <button type="button" {...agentNavProps(id)}
        className="cc-name cc-name-jump" title={`focus ${id}'s desk`}
        onClick={(e) => { e.stopPropagation(); onFocusAgent(id) }}>
        {chip}
      </button>
    )
  }
  return chip
}

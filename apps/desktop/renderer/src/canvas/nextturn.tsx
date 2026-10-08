import type { CanvasNode } from './shared'
import { tierLabel } from './shared'

/** The requested target is separate from the value serving this turn. */
export function NextTurnBadge({ agent, kind, current, next }: {
  agent: string; kind: 'account' | 'model' | 'effort'; current: string; next: string
}) {
  const detail = `${agent}'s ${kind} will change from ${current} to ${next} next turn`
  return <span className="badge queued next-turn" data-next-turn={kind}
    title={detail} aria-label={detail}>{`next turn \u2192 ${next}`}</span>
}

const accountName = (id?: string | null): string =>
  !id || id === 'primary' || id === 'default' || id.endsWith('/primary') ? 'default' : id

export function QueuedAccountBadge({ node }: {
  node: Pick<CanvasNode, 'id' | 'account' | 'pending_account' | 'serving_account'>
}) {
  if (!node.pending_account) return null
  const current = node.serving_account?.display || node.serving_account?.id || node.account
  return <NextTurnBadge agent={node.id} kind="account" current={accountName(current)}
    next={accountName(node.pending_account.account)} />
}

export function QueuedModelBadge({ node }: {
  node: Pick<CanvasNode, 'id' | 'tier' | 'pending_switch'>
}) {
  if (!node.pending_switch) return null
  return <NextTurnBadge agent={node.id} kind="model" current={tierLabel(node.tier ?? '?')}
    next={tierLabel(node.pending_switch.tier)} />
}

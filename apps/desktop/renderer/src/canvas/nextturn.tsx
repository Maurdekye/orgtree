import type { CanvasNode } from './shared'
import { tierLabel } from './shared'
import { useFastMode } from './fastmode'
import { fmtStamp } from '../timefmt'

/** One engine fact, shared by the desk header and zoom-card state row. */
export function SessionZeroBadge({ node }: { node: Pick<CanvasNode, 'session_placement'> }) {
  const placement = node.session_placement
  if (placement?.session !== 'session0') return null
  const reasons = {
    'signed-out': 'The user is signed out of Windows',
    'helper-unreachable': "Orgtree's sign-in helper did not connect in time",
    preference: "This agent's own choice (its session preference or a one-turn pick)",
    'background-work': 'Its CLI is still running background work',
  }
  const description = (placement.reason && reasons[placement.reason]) || 'Runs in Windows Session 0'
  const since = fmtStamp(placement.at)
  const detail = description + (since ? `\nSince ${since}` : '')
  return <span className="badge session-0" tabIndex={0} title={detail} aria-label={detail}>Session 0</span>
}

/** The requested target is separate from the value serving this turn. */
export function NextTurnBadge({ agent, kind, current, next }: {
  agent: string; kind: 'account' | 'model' | 'effort' | 'fast'; current: string; next: string
}) {
  const detail = `${agent}'s ${kind} will change from ${current} to ${next} next turn`
  return <span className="badge queued next-turn" data-next-turn={kind}
    title={detail} aria-label={detail}>{`next turn: ${next}`}</span>
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

/** Saved intent only becomes queued when a known running request differs. */
export function QueuedFastBadge({ node }: { node: CanvasNode }) {
  const supported = useFastMode(node.tier, node.scope?.model_version)
  const current = node.fast_mode_current
  const next = node.scope?.fast_mode === true
  if (!supported || node.state !== 'live' || node.busy !== true
    || typeof current !== 'boolean' || current === next) return null
  return <NextTurnBadge agent={node.id} kind="fast" current={`fast ${current ? 'on' : 'off'}`}
    next={`fast ${next ? 'on' : 'off'}`} />
}

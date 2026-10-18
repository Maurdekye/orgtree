import { useEffect, useState } from 'react'
import { compactCapability, compactNode } from '../api'
import type { CompactCapability } from '../api'
import { useCurrentOrg } from '../popout'
import type { ToastFn } from '../types'
import { ConfirmModal } from './modals'
import type { CanvasNode, OpFn } from './shared'

/** One choice dialog for the context menu and the desk's context control. */
export function AgentCompactConfirm({ node, slug: explicitSlug, op, toast, close, onCheap }: {
  node: CanvasNode; slug?: string; op: OpFn; toast: ToastFn; close: () => void
  onCheap?: () => void
}) {
  const currentOrg = useCurrentOrg()
  const slug = explicitSlug ?? currentOrg
  const [cap, setCap] = useState<CompactCapability | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setCap(null); setError(null)
    if (!slug) { setError('The organization is unavailable.'); return }
    compactCapability(slug, node.id).then(result => { if (live) setCap(result) })
      .catch((e: Error) => { if (live) setError(`Could not check normal compaction: ${e.message}`) })
    return () => { live = false }
  }, [slug, node.id])
  const gate = node.state !== 'live' || node.isBearerOf || node.bearer_state
    ? 'Only live agents can be compacted.'
    : node.busy ? 'Wait until this agent finishes its turn.'
    : !node.session_id ? 'No conversation to compact yet.' : null
  const reason = gate ?? error ?? (!cap ? 'Checking harness support…'
    : !cap.supported ? cap.reason ?? 'Normal compaction is unavailable for this harness.' : null)
  // Only backend evidence can call the next turn known-cold. An old turn
  // alone supplies neither a cache receipt nor the provider lane's TTL.
  const forecast = node.cache_forecast
  const cold = forecast?.state === 'known_incompatible' || forecast?.state === 'expired_known_entry'
  const coldLabel = forecast?.state === 'known_incompatible'
    ? 'incompatible with the last observed cache entry' : 'past the derived cache TTL'
  return <ConfirmModal title={`Compact ${node.id}?`}
    body={<>
      <p>Normal compact: the harness compacts the existing conversation.</p>
      <p>Cheap compact: start a fresh session with a summary handoff; keep this agent’s settings and team.</p>
      {cold && <p className="compact-cache-warning">The next-turn cache forecast is {coldLabel}
        {forecast?.reason ? `: ${forecast.reason}` : ''}.</p>}
      {reason && <p role="status">{reason}</p>}
    </>}
    confirmLabel="Normal compact" confirmDisabled={!!reason} confirmTitle={reason ?? undefined}
    onConfirm={() => {
      if (!slug || reason) return
      compactNode(slug, node.id).then(result => {
        toast([result.started ? `compaction of ${node.id} started`
          : `Could not compact ${node.id}: ${result.reason ?? 'the request was not admitted'}`])
      }).catch((e: Error) => toast([`error: ${e.message}`]))
    }}
    altLabel="Cheap compact" altDisabled={!!gate}
    onAlt={() => {
      if (gate) return
      op({ op: 'cheap_compact', node: node.id }).then(() => {
        onCheap?.()
        toast([`${node.id} cheap-compacted — fresh session ready`])
      }).catch((e: Error) => toast([`error: ${e.message}`]))
    }} close={close}/>
}

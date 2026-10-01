import { useMemo, useState } from 'react'
import { useWorkItems } from './useworkitems'
import type { ToastFn, TreePayload } from '../types'
import { DocketIcon } from '../icons'
import { AgentDocketView, agentItems, itemActorIds, useNodeFacts } from './docket'
import { PinFrame, closeIfCentred } from './modalpin'
import { flatten, withDraftTree } from './shared'
import type { RefRoutes } from './reflinks'
import { resolveRef } from './reflinks'

/** The desk's existing agent docket, opened from the overview card. */
export function AgentDocketModal({ slug, nid, tree, toast, close, refs }: {
  slug: string; nid: string; tree: TreePayload; toast: ToastFn
  close: () => void; refs: RefRoutes
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const work = useWorkItems(slug, showArchived, showBacklog, 15000, bump).value
  const mine = useMemo(() => agentItems(work, nid, showArchived), [work, nid, showArchived])
  const actorIds = useMemo(() => itemActorIds(mine), [mine])
  const facts = useNodeFacts(slug, tree, actorIds)
  const routes: RefRoutes = { world: refs.world, onOpen: r => {
    closeIfCentred('agent-docket', close, slug)
    refs.onOpen(r)
  } }
  return <PinFrame kind="agent-docket" restore={{ agent: nid, generation: flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.generation }} title={`${nid} · Docket`} panel="settings wide" close={close}>
    <h3 data-copy-agent-name={nid}><DocketIcon fontSize="inherit" /> {nid} <span className="dim">· Docket</span></h3>
    <AgentDocketView slug={slug} nid={nid} mine={mine} facts={facts} toast={toast}
      showArchived={showArchived} onShowArchived={setShowArchived}
      onShowBacklog={setShowBacklog}
      references={work?.references} boundedReferences workRevision={work?.revision}
      onChanged={() => setBump(n => n + 1)} refs={routes}
      onFocusAgent={id => routes.onOpen(resolveRef({ kind: 'agent', org: slug, id }, refs.world))} />
    <div className="row"><button className="primary" onClick={close}>Close</button></div>
  </PinFrame>
}

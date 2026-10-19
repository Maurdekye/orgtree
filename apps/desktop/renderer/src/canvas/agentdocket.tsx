import { useEffect, useMemo, useRef, useState } from 'react'
import { treeSelections } from '../treeselection'
import { useWorkItems } from './useworkitems'
import type { ToastFn, TreePayload } from '../types'
import { DocketIcon } from '../icons'
import { AgentDocketView, agentItems, itemActorIds, teamItems, useNodeFacts } from './docket'
import { PinFrame, closeIfCentred } from './modalpin'
import { flatten, withDraftTree } from './shared'
import type { RefRoutes } from './reflinks'
import { resolveRef } from './reflinks'

/** The desk's agent and team docket modal (user 2026-10-18 10:57Z: the agent
 *  and team dockets are the SAME modal with the "Team" checkbox unchecked or
 *  checked). */
export function AgentDocketModal({ slug, nid, tree, toast, close, refs,
  team, onTeamChange, pinKind = 'agent-docket' }: {
  slug: string; nid: string; tree: TreePayload; toast: ToastFn
  close: () => void; refs: RefRoutes
  team?: boolean; onTeamChange?: (team: boolean) => void
  pinKind?: string
}) {
  const [localTeam, setLocalTeam] = useState(!!team)
  useEffect(() => { setLocalTeam(!!team) }, [team])
  const isTeam = onTeamChange ? !!team : localTeam
  const setTeam = (next: boolean) => { setLocalTeam(next); onTeamChange?.(next) }
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const [pageFilter, setPageFilter] = useState<import('../workpages').WorkPageOptions>({})
  // a project's docket: the items owned by agents under it (user 2026-10-17 22:21Z)
  const isProject = useMemo(() => flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.kind === 'project', [tree, nid])
  const useSubtree = isTeam || isProject
  const workFeed = useWorkItems(slug, showArchived, showBacklog, 15000, bump,
    { ...pageFilter, ...(useSubtree ? { team: nid } : { agent: nid }) })
  const work = workFeed.value
  const mine = useMemo(() => useSubtree ? teamItems(work, nid, tree.roots, showArchived)
    : agentItems(work, nid, showArchived), [useSubtree, work, nid, tree.roots, showArchived])
  const actorIds = useMemo(() => itemActorIds(mine), [mine])
  const facts = useNodeFacts(slug, tree, actorIds)
  // A SELECTED tree may omit retired owners, and team membership needs their
  // ancestry. Ask the tree selection for those owners while in team mode.
  const unplaced = useMemo(() => {
    const view = tree.foreground
    if (!useSubtree || !view || !work) return []
    const known = new Set([...view.present, ...view.missing])
    const owners = [...(work.items ?? []), ...(work.backlogged ?? []),
      ...(showArchived ? (work.archived ?? []) : [])].map(it => it.owner?.node)
    return [...new Set(owners)].filter((id): id is string => !!id && !known.has(id)).sort()
  }, [useSubtree, tree.foreground, work, showArchived])
  const held = useRef<{ slug: string; ids: string[] }>({ slug, ids: [] })
  if (held.current.slug !== slug || !useSubtree) held.current = { slug, ids: [] }
  if (useSubtree && tree.foreground && work) held.current = { slug, ids: unplaced }
  const registered = held.current.ids
  const registeredKey = JSON.stringify(registered)
  useEffect(() => {
    if (!registered.length) return
    const owner = {}
    treeSelections.set(slug, owner, { include: registered })
    return () => treeSelections.release(slug, owner)
  }, [slug, registeredKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const routes: RefRoutes = { world: refs.world, onOpen: r => {
    closeIfCentred(pinKind, close, slug)
    refs.onOpen(r)
  } }
  const titleText = isTeam ? `${nid} · Team docket` : `${nid} · Docket`
  return <PinFrame kind={pinKind}
    restore={{ agent: nid, generation: flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.generation, ...(isTeam ? { team: true } : {}) }}
    title={titleText} panel="settings wide" close={close}>
    <h3 data-copy-agent-name={nid}><DocketIcon fontSize="inherit" /> {nid} <span className="dim">· {isTeam ? 'Team docket' : 'Docket'}</span></h3>
    {unplaced.length > 0 && <div role="status" className="hint">
      Checking team membership for {unplaced.length} retired {unplaced.length === 1 ? 'owner' : 'owners'}…</div>}
    <AgentDocketView slug={slug} nid={nid} mine={mine} facts={facts} toast={toast}
      team={!isProject ? isTeam : undefined}
      onTeam={!isProject ? setTeam : undefined}
      showArchived={showArchived} onShowArchived={setShowArchived}
      onShowBacklog={setShowBacklog}
      references={work?.references} boundedReferences workRevision={work?.revision}
      paging={{...workFeed.paging, setFilter:setPageFilter}}
      onChanged={() => setBump(n => n + 1)} refs={routes}
      emptyText={useSubtree && unplaced.length ? <>checking whether retired owners belong to this team…</> : undefined}
      onFocusAgent={id => routes.onOpen(resolveRef({ kind: 'agent', org: slug, id }, refs.world))} />
  </PinFrame>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { treeSelections } from '../treeselection'
import { useWorkItems } from './useworkitems'
import type { ToastFn, TreePayload } from '../types'
import { DocketIcon } from '../icons'
import { AgentDocketView, agentItems, itemActorIds, teamItems, useNodeFacts } from './docket'
import { PinFrame, closeIfCentred } from './modalpin'
import { readerScope, resumedReaderItem, useReaderSelection } from './readeropening'
import { instanceKind } from '../modalkinds'
import { useSurfaceDocument } from '../popout'
import { flatten, withDraftTree } from './shared'
import type { RefRoutes } from './reflinks'
import { resolveRef } from './reflinks'

/** The desk's agent and team docket modal (user 2026-10-18 10:57Z: the agent
 *  and team dockets are the SAME modal with the "Team" checkbox unchecked or
 *  checked). */
export function AgentDocketModal({ slug, nid, tree, toast, close, refs,
  team, onTeamChange, pinKind = instanceKind('agent-docket', nid) }: {
  slug: string; nid: string; tree: TreePayload; toast: ToastFn
  close: () => void; refs: RefRoutes
  team?: boolean; onTeamChange?: (team: boolean) => void
  /** the window's identity; by default this agent's docket instance (docket
   *  several-instances-of-the-same-modal-team-slots-i), its own and its team
   *  docket being the one modal with the Team box unticked or ticked */
  pinKind?: string
}) {
  const [localTeam, setLocalTeam] = useState(!!team)
  useEffect(() => { setLocalTeam(!!team) }, [team])
  const isTeam = onTeamChange ? !!team : localTeam
  const setTeam = (next: boolean) => { setLocalTeam(next); onTeamChange?.(next) }
  const [continued]=useState(() => resumedReaderItem(slug,pinKind))
  const [continuedTeam]=useState(isTeam)
  const selectionScope=readerScope('work',slug,nid,isTeam)
  const [shown,setShown]=useReaderSelection(selectionScope,continued ?? null)
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const [pageFilter, setPageFilter] = useState<import('../workpages').WorkPageOptions>({})
  // a project's docket: the items owned by agents under it (user 2026-10-17 22:21Z)
  const isProject = useMemo(() => flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.kind === 'project', [tree, nid])
  const useSubtree = isTeam || isProject
  const workFeed = useWorkItems(slug, showArchived, showBacklog, 15000, bump,
    { ...pageFilter, ...(useSubtree ? { team: nid } : { agent: nid }) },selectionScope,
    shown ?? (isTeam===continuedTeam ? continued : undefined))
  const work = workFeed.value
  const mine = useMemo(() => useSubtree ? teamItems(work, nid, tree.roots, showArchived)
    : agentItems(work, nid, showArchived), [useSubtree, work, nid, tree.roots, showArchived])
  const actorIds = useMemo(() => itemActorIds(mine), [mine])
  const facts = useNodeFacts(slug, tree, actorIds)
  // A SELECTED tree may omit retired owners, and team membership needs their
  // ancestry. Ask the tree selection for those owners while in team mode.
  const owners = useMemo(() => [...new Set([
    ...(work?.items ?? []), ...(work?.backlogged ?? []),
    ...(showArchived ? (work?.archived ?? []) : []),
  ].map(it => it.owner?.node).filter((id): id is string => !!id))].sort(), [work, showArchived])
  const unplaced = useMemo(() => {
    const view = tree.foreground
    if (!useSubtree || !view || !work) return []
    const known = new Set([...view.present, ...view.missing])
    return owners.filter(id => !known.has(id))
  }, [useSubtree, tree.foreground, work, owners])
  const scope = JSON.stringify([slug, nid, useSubtree])
  const held = useRef<{ scope: string; ids: string[] }>({ scope, ids: [] })
  if (held.current.scope !== scope) held.current = { scope, ids: [] }
  if (useSubtree && work) {
    // A selected-tree answer exists only while its selection is held. Keep
    // found AND missing owners requested until their work leaves this view;
    // dropping a fulfilled request removes the answer and starts a feedback loop.
    // The complete-tree fallback (>128 selections) must retain these too.
    const needed = new Set(owners)
    held.current = { scope, ids: [...new Set([
      ...held.current.ids.filter(id => needed.has(id)), ...unplaced,
    ])].sort() }
  }
  const registered = held.current.ids
  const registeredKey = JSON.stringify(registered)
  const selectionOwner = useRef({})
  useEffect(() => {
    const owner = selectionOwner.current
    return () => treeSelections.release(slug, owner)
  }, [slug])
  useEffect(() => {
    const owner = selectionOwner.current
    if (registered.length) treeSelections.set(slug, owner, { include: registered })
    else treeSelections.release(slug, owner)
  }, [slug, registeredKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const routes: RefRoutes = { world: refs.world, onOpen: r => {
    closeIfCentred(pinKind, close, slug)
    refs.onOpen(r)
  } }
  const titleText = isTeam ? `${nid} · Team docket` : `${nid} · Docket`
  const ownerDocument = useSurfaceDocument()
  const onEsc = useCallback(() => {
    // PinFrame's capture-phase Escape runs before the shared input's handler.
    // Give a focused query the main docket's first-Escape behaviour by invoking
    // its real clear control (which also retains focus); every other Escape
    // keeps the frame's ordinary dismissal.
    const active = ownerDocument.activeElement
    if (active?.matches('input.docket-search-input[type="search"]')
        && (active as HTMLInputElement).value) {
      const clear = active.parentElement?.querySelector<HTMLButtonElement>('.docket-search-clear')
      if (clear) { clear.click(); return }
    }
    close()
  }, [ownerDocument, close])
  return <PinFrame kind={pinKind}
    restore={{ selection:shown ?? '', agent: nid, generation: flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.generation, ...(isTeam ? { team: true } : {}) }}
    title={titleText} panel="settings wide" close={close} onEsc={onEsc}>
    <h3 className="docket-membership-head" data-copy-agent-name={nid}><DocketIcon fontSize="inherit" /> {nid} <span className="dim">· {isTeam ? 'Team docket' : 'Docket'}</span>
      {unplaced.length > 0 && <span role="status" className="hint docket-membership-pending">
        Checking team membership for {unplaced.length} retired {unplaced.length === 1 ? 'owner' : 'owners'}…</span>}
    </h3>
    <AgentDocketView slug={slug} nid={nid} mine={mine} continuedSelection={isTeam===continuedTeam ? continued : undefined} onShown={setShown} facts={facts} toast={toast}
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

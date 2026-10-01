// canvas/teamdocket.tsx — ONE AGENT'S TEAM DOCKET: the work docket reduced to
// the tickets assigned to that agent or to anyone below it, at any depth.
//
// FOR 2.1.5-RC1 THIS HAS EXACTLY ONE DOOR (ticket ruling): the "Open team
// docket" entry in an agent's existing context menu, which uses the agent the
// menu was raised on as the team root and opens this panel directly. There is
// deliberately NO top-level tab, toolbar mode, global agent chooser,
// navigation destination or setting — the restriction is on the ENTRY SURFACE
// only, and every other requirement (filtering, visibility, ticket detail,
// refresh, accessibility) applies here in full.
//
// IT IS THE AGENT DOCKET'S PANEL, FED A DIFFERENT FILTER. `AgentDocketView` is
// already the docket's own rows, detail pane, status vocabulary, nesting,
// grouping and attention handling called with a shorter list — it is what the
// desk tab and the single-agent modal both render — so the team view reuses it
// rather than growing a second list that would drift from the first. What is
// NEW here is one pure function (`teamItems`) and one sentence of empty state.
//
// ⚠ THE FILTER IS SUBTREE OWNERSHIP, AND THE VIEWER'S TREE DECIDES THE
// SUBTREE. `tree` is the payload the canvas is already rendering, which the
// backend has already narrowed to what this viewer may see, so the team docket
// can only ever show a subset of what the full docket would have shown them.
// See `teamNodeIds` in docket.tsx for why an unknown root is a team of one.

import { useEffect, useMemo, useRef, useState } from 'react'
import { treeSelections } from '../treeselection'
import { useWorkItems } from './useworkitems'
import type { ToastFn, TreePayload } from '../types'
import { DocketIcon } from '../icons'
import { AgentDocketView, itemActorIds, useNodeFacts, teamItems } from './docket'
import { PinFrame, closeIfCentred } from './modalpin'
import { flatten, withDraftTree } from './shared'
import type { RefRoutes } from './reflinks'
import { resolveRef } from './reflinks'

/** The reduced docket for `nid`'s team, opened from that agent's context
 *  menu. The selected agent stays named in the frame title and the heading, so
 *  the panel never leaves the reader guessing which team they are looking at,
 *  and it closes the way every other docket panel does. */
export function TeamDocketModal({ slug, nid, tree, toast, close, refs }: {
  slug: string; nid: string; tree: TreePayload; toast: ToastFn
  close: () => void; refs: RefRoutes
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  // the same poll the single-agent docket runs — MEMBERSHIP IS RECOMPUTED ON
  // EVERY RENDER from the current items and the current tree, so a
  // reassignment, a hire, a retirement or a reparent lands in this view at the
  // next refresh without any cache to invalidate
  const work = useWorkItems(slug, showArchived, showBacklog, 15000, bump).value
  const team = useMemo(() => teamItems(work, nid, tree.roots, showArchived),
    [work, nid, tree.roots, showArchived])
  const actorIds = useMemo(() => itemActorIds(team), [team])
  const facts = useNodeFacts(slug, tree, actorIds)
  // A SELECTED tree may omit retired owners, and membership needs their
  // ancestry. This mounted panel asks the tree selection for exactly those
  // owners; until the tree carries them or reports them missing, the panel
  // says it is still checking rather than presenting a shorter team.
  const unplaced = useMemo(() => {
    const view = tree.foreground
    if (!view || !work) return []
    const known = new Set([...view.present, ...view.missing])
    const owners = [...(work.items ?? []), ...(work.backlogged ?? []),
      ...(showArchived ? (work.archived ?? []) : [])].map(it => it.owner?.node)
    return [...new Set(owners)].filter((id): id is string => !!id && !known.has(id)).sort()
  }, [tree.foreground, work, showArchived])
  // ⚠ HELD THROUGH A LEGACY FALLBACK. Past 128 requested IDs the selected
  // tree is answered by the complete legacy tree, which has no `foreground`
  // and so nothing unplaced. Releasing on that answer would make the next
  // read selected again and re-register: an endless flip between the two.
  // Only a selected tree (or closing the panel) may shrink the request.
  const held = useRef<{ slug: string; ids: string[] }>({ slug, ids: [] })
  if (held.current.slug !== slug) held.current = { slug, ids: [] }
  if (tree.foreground && work) held.current = { slug, ids: unplaced }
  const registered = held.current.ids
  const registeredKey = JSON.stringify(registered)
  useEffect(() => {
    if (!registered.length) return
    const owner = {}
    treeSelections.set(slug, owner, { include: registered })
    return () => treeSelections.release(slug, owner)
  }, [slug, registeredKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const routes: RefRoutes = { world: refs.world, onOpen: r => {
    closeIfCentred('team-docket', close, slug)
    refs.onOpen(r)
  } }
  return <PinFrame kind="team-docket" restore={{ agent: nid, generation: flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.generation }} title={`${nid} · Team docket`} panel="settings wide" close={close}>
    <h3 data-copy-agent-name={nid}><DocketIcon fontSize="inherit" /> {nid} <span className="dim">· Team docket</span></h3>
    {unplaced.length > 0 && <div role="status" className="hint">
      Checking team membership for {unplaced.length} retired {unplaced.length === 1 ? 'owner' : 'owners'}…</div>}
    <AgentDocketView slug={slug} nid={nid} mine={team} facts={facts} toast={toast}
      showArchived={showArchived} onShowArchived={setShowArchived}
      onShowBacklog={setShowBacklog}
      references={work?.references} boundedReferences workRevision={work?.revision}
      onChanged={() => setBump(n => n + 1)} refs={routes}
      emptyText={unplaced.length ? <>checking whether retired owners belong to this team…</> : <>
        no docket items are assigned to {nid} or to any agent below it —
        this team has nothing on the docket
      </>}
      onFocusAgent={id => routes.onOpen(resolveRef({ kind: 'agent', org: slug, id }, refs.world))} />
    <div className="row"><button className="primary" onClick={close}>Close</button></div>
  </PinFrame>
}

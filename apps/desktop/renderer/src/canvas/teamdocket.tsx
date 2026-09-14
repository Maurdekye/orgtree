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

import { useMemo, useState } from 'react'
import { getWorkItems } from '../api'
import type { ToastFn, TreePayload } from '../types'
import { DocketIcon } from '../icons'
import { AgentDocketView, buildNodeFacts, teamItems } from './docket'
import { PinFrame, closeIfCentred } from './modalpin'
import { flatten, withDraftTree, usePolled } from './shared'
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
  const [bump, setBump] = useState(0)
  // the same poll the single-agent docket runs — MEMBERSHIP IS RECOMPUTED ON
  // EVERY RENDER from the current items and the current tree, so a
  // reassignment, a hire, a retirement or a reparent lands in this view at the
  // next refresh without any cache to invalidate
  const work = usePolled(() => getWorkItems(slug, true, true), [slug], 15000, bump)
  const team = useMemo(() => teamItems(work, nid, tree.roots, showArchived),
    [work, nid, tree.roots, showArchived])
  const facts = useMemo(() => buildNodeFacts(tree.roots), [tree.roots])
  const routes: RefRoutes = { world: refs.world, onOpen: r => {
    closeIfCentred('team-docket', close, slug)
    refs.onOpen(r)
  } }
  return <PinFrame kind="team-docket" restore={{ agent: nid, generation: flatten(withDraftTree(tree, null), tree.tiers).get(nid)?.generation }} title={`${nid} · Team docket`} panel="settings wide" close={close}>
    <h3 data-copy-agent-name={nid}><DocketIcon fontSize="inherit" /> {nid} <span className="dim">· Team docket</span></h3>
    <AgentDocketView slug={slug} nid={nid} mine={team} facts={facts} toast={toast}
      showArchived={showArchived} onShowArchived={setShowArchived}
      onChanged={() => setBump(n => n + 1)} refs={routes}
      emptyText={<>
        no docket items are assigned to {nid} or to any agent below it —
        this team has nothing on the docket
      </>}
      onFocusAgent={id => routes.onOpen(resolveRef({ kind: 'agent', org: slug, id }, refs.world))} />
    <div className="row"><button className="primary" onClick={close}>Close</button></div>
  </PinFrame>
}

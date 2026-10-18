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

import type { ToastFn, TreePayload } from '../types'
import { AgentDocketModal } from './agentdocket'
import type { RefRoutes } from './reflinks'

/** The reduced docket for `nid`'s team, opened from that agent's context
 *  menu — the same modal as `AgentDocketModal` with its "Team" checkbox
 *  initially checked (user 2026-10-18 10:57Z). */
export function TeamDocketModal(props: {
  slug: string; nid: string; tree: TreePayload; toast: ToastFn
  close: () => void; refs: RefRoutes
}) {
  return <AgentDocketModal {...props} team pinKind="team-docket" />
}

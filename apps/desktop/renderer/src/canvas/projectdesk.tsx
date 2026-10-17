// canvas/projectdesk.tsx — the PROJECT DESK (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-17 19:38Z–20:10Z). A focused project card,
// and a pinned project window, show this desk in the agent desk's frame and
// header. A project takes no turns, so its main tab is not a chat: it holds
// the chat desk's jump cards (up to its parent, down to its members) and a
// large editor for its description, rendered as Markdown until it is focused
// and edited as monospace text (user 20:06Z). Beside it are the agent desk's
// three other tabs with the agent desk's own views, scoped to the project:
// inbox, docket (the items attached to it) and presented (the documents
// presented under it) (user 20:07Z). The header counts its agents, active out
// of hired, with the spinner while any is active (20:08Z), and has halt all,
// dissolve project (20:09Z) and the settings gear (20:09:45Z).

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import type { ToastFn, TreePayload, TurnStat } from '../types'
import { AutorenewIcon, FolderIcon, SettingsIcon } from '../icons'
import { md, subtreeDocCount, USER } from './shared'
export { subtreeDocCount }
import type { CanvasNode, OpFn } from './shared'
import { InboxView } from './mail'
import { useWorkItems } from './useworkitems'
import { AgentDocketView, itemActorIds, teamItems, useNodeFacts } from './docket'
import { AgentGalleryView } from './gallery'
import { PanelCorner } from './panelcorner'
import type { RefRoutes } from './reflinks'
import { LastTurnAge, NavChip } from './desk'
import { subtreeAgents } from './bulkcompact'
import { AgentBatchHaltConfirm, AgentRetireConfirm } from './agentmenu'

export const PROJECT_DESK_TABS = ['desk', 'inbox', 'docket', 'presented'] as const
type Tab = typeof PROJECT_DESK_TABS[number]

export interface ProjectDeskProps {
  node: CanvasNode
  slug: string
  tree: TreePayload
  map: Map<string, CanvasNode>
  op: OpFn
  toast: ToastFn
  refs: RefRoutes
  /** a pinned window's body: the desk unscaled, as DeskChat's `bare` */
  bare?: boolean
  onJump?: (id: string) => void
  /** the gear: the project's settings (ProjectConfig) */
  onConfig?: () => void
  /** pin this desk as a window (absent: no pin button) */
  onPin?: () => void
}

/** The agents under a project, nested projects crossed but not counted:
 *  hired = live agents, active = those with a turn executing — the org list's
 *  n/m rule (shell/orgrows.tsx), for this subtree only. */
export function projectCounts(node: CanvasNode): { active: number; hired: number; agents: CanvasNode[] } {
  const agents = subtreeAgents(node)
  return { active: agents.filter((a) => a.busy).length, hired: agents.length, agents }
}


/** The project's LAST ACTIVITY (user 2026-10-17 22:21Z): active while any
 *  live agent under it runs a turn; otherwise the newest turn end among them,
 *  nested projects included; null when none has ever run one. */
export function projectLastActivity(node: CanvasNode): { active: boolean; turn: TurnStat | null } {
  const agents = subtreeAgents(node)
  if (agents.some((a) => a.busy)) return { active: true, turn: null }
  let newest: TurnStat | null = null
  for (const a of agents) {
    const t = a.turns?.[a.turns.length - 1]
    if (t && (!newest || Date.parse(t.at) > Date.parse(newest.at))) newest = t
  }
  return { active: false, turn: newest }
}

/** "active now" / "quiet for <age>", on the desk header and the middle-zoom
 *  card beside the activity chip; the age is the agent cards' own clock. */
export function ProjectLastActivity({ node }: { node: CanvasNode }) {
  const { active, turn } = projectLastActivity(node)
  if (active) return <span className="project-last-activity active" title="an agent under this project is running a turn">active now</span>
  if (!turn) return null
  return <span className="project-last-activity" title="since the newest turn of any agent under this project ended">
    quiet for <LastTurnAge turn={turn} variant="inline" /></span>
}

/** The project's agents as the app header's activity chip shows an org's
 *  (shell/treeinfo.tsx ActiveAgentSummary): the spinner while any is active,
 *  then active/hired. On the project desk's header and the project card at
 *  middle zoom (user 2026-10-17 20:08Z, 21:21Z). */
export function ProjectActivity({ node }: { node: CanvasNode }) {
  const { active, hired } = projectCounts(node)
  return (
    <span className="chip agents project-activity" title="active / hired agents under this project">
      <span className="org-activity">
        {active > 0 && <span className="working-ct"
          title={`${active} agent${active === 1 ? '' : 's'} under this project active — a turn executing now`}>
          <AutorenewIcon fontSize="inherit" className="cc-spin" /></span>}
      </span>
      <span className="project-counts org-counts dim">{active}/{hired}</span>
    </span>
  )
}

/** The description editor (user 2026-10-17 20:06Z): Markdown while it is not
 *  focused, raw monospace text while it is. Leaving the editor saves a change
 *  with `set_description`; Escape drops the edit. */
function DescriptionEditor({ node, op, toast, editable }: {
  node: CanvasNode; op: OpFn; toast: ToastFn; editable: boolean
}) {
  const saved = node.charter ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(saved)
  const box = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => { if (!editing) setDraft(saved) }, [saved, editing])
  useEffect(() => { if (editing) box.current?.focus({ preventScroll: true }) }, [editing])
  const commit = () => {
    setEditing(false)
    if (draft.trim() === saved.trim()) return
    op({ op: 'set_description', node: node.id, description: draft })
      .then(() => toast([`description of ${node.id} saved`]))
      .catch(() => setDraft(saved))   // `op` toasts the refusal
  }
  if (editing) {
    return <textarea ref={box} className="project-description-edit" value={draft} spellCheck={false}
      aria-label={`description of project ${node.id}`}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(saved); setEditing(false) }
      }} />
  }
  const empty = !saved.trim()
  return <div className={'project-description-md' + (empty ? ' dim' : '')} tabIndex={editable ? 0 : -1}
    role={editable ? 'textbox' : undefined} aria-label={`description of project ${node.id}`}
    title={editable ? 'click to edit; it is the standing charter of every agent under this project' : undefined}
    onFocus={() => { if (editable) setEditing(true) }}
    onClick={() => { if (editable) setEditing(true) }}
    {...(empty ? { children: editable ? 'Describe the project: every agent under it gets this as a standing charter.' : 'No description.' }
      : { dangerouslySetInnerHTML: md(saved) })} />
}

export function ProjectDesk({ node, slug, tree, map, op, toast, refs, bare, onJump, onConfig, onPin }: ProjectDeskProps) {
  const [view, setView] = useState<Tab>('desk')
  const [asking, setAsking] = useState<'halt' | 'unhalt' | 'dissolve' | null>(null)
  // the docket tab: the items attached to this project (slice 2), one poll,
  // as the agent docket modal does
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const [pageFilter, setPageFilter] = useState<import('../workpages').WorkPageOptions>({})
  const workFeed = useWorkItems(slug, view === 'docket' && showArchived, view === 'docket' && showBacklog,
    15000, bump, { ...pageFilter, agent: node.id })
  const work = workFeed.value
  // every item owned by an agent under the project, through nested projects
  // (user 2026-10-17 22:21Z; items no longer attach to projects)
  const mine = useMemo(() => teamItems(work, node.id, tree.roots, showArchived),
    [work, node.id, tree.roots, showArchived])
  const facts = useNodeFacts(slug, tree, useMemo(() => itemActorIds(mine), [mine]))
  const live = node.state === 'live'
  const { agents } = projectCounts(node)
  const allHalted = agents.length > 0 && agents.every((a) => a.halt?.phase === 'halted')
  const parent = node.parent && map.has(node.parent) && !(bare && node.parent === USER) ? map.get(node.parent)! : null
  const members = node.children.filter((c) => c.state === 'live')
  const count = (tab: Tab) => tab === 'inbox' ? node.mail_pending ?? 0
    : tab === 'docket' ? mine?.length ?? 0
      : tab === 'presented' ? subtreeDocCount(node) : 0
  const content = (
    <>
      <div className="cc-head">
        <div className="cc-head-top">
          <span className="cc-head-left" data-copy-agent-name={node.id}>
            <span className="project-mark" title="project node: runs no turns, holds no credits">
              <FolderIcon fontSize="inherit" />
            </span>
            <span className="name">{node.id}</span>
            <ProjectActivity node={node} />
            <ProjectLastActivity node={node} />
            {!live && <span className="badge dim">{node.state}</span>}
          </span>
          <span className="spacer" aria-hidden="true" />
          <span className="cc-head-right">
            <span className="cc-actions">
              {live && agents.length > 0 && (
                <button className={allHalted ? '' : 'danger'} data-action="halt-all"
                  title={`${allHalted ? 'release' : 'halt'} all ${agents.length} live agents under this project`}
                  onClick={() => setAsking(allHalted ? 'unhalt' : 'halt')}>
                  {allHalted ? 'unhalt all' : 'halt all'}</button>
              )}
              {live && <button className="danger" data-action="dissolve"
                title="retire the project and every agent under it; context is kept and rehire brings each back"
                onClick={() => setAsking('dissolve')}>dissolve project</button>}
              {!live && node.state === 'archived' && <button data-action="restore"
                onClick={() => { void op({ op: 'rehire', node: node.id }).catch(() => {}) }}>restore</button>}
            </span>
            <span className="cc-tabs">
              {PROJECT_DESK_TABS.map((v) => (
                <button key={v} data-tab={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                  {v}{count(v) > 0 ? <>{' '}<span className="tab-count">{count(v)}</span></> : ''}
                </button>
              ))}
            </span>
            {onPin && (
              <button className="cc-icon cc-pin" aria-label={`pin project ${node.id}'s desk as a window`}
                title="pin as a window — it stays put while the canvas moves" onClick={onPin}>
                <PushPinIcon fontSize="inherit" />
              </button>
            )}
            {onConfig && (
              <button className="cc-icon" aria-label={`settings for ${node.id}`}
                title={`settings for ${node.id}`} onClick={onConfig}>
                <SettingsIcon fontSize="inherit" />
              </button>
            )}
          </span>
        </div>
      </div>
      {view === 'desk' && <>
        {onJump && parent && <div className="desk-nav"><NavChip n={parent} dir="up" onJump={onJump} /></div>}
        <DescriptionEditor node={node} op={op} toast={toast} editable={live} />
        {onJump && members.length > 0 && <div className="desk-nav">
          {members.map((c) => <NavChip key={c.id} n={c} dir="down" onJump={onJump} />)}
        </div>}
      </>}
      {view === 'inbox' && <div className="desk-tabpanel">
        <PanelCorner kind="node-inbox" slug={slug} nid={node.id} />
        <InboxView slug={slug} nid={node.id} tier={node.tier} unreadCount={node.mail_pending} toast={toast}
          tierOf={(id) => map.get(id)?.tier} hasAgent={(id) => map.has(id)}
          refs={refs} onFocusAgent={onJump} />
      </div>}
      {view === 'docket' && <div className="desk-tabpanel">
        <PanelCorner kind="agent-docket" slug={slug} nid={node.id} />
        <AgentDocketView slug={slug} nid={node.id} mine={mine} facts={facts} toast={toast}
          showArchived={showArchived} onShowArchived={setShowArchived} onShowBacklog={setShowBacklog}
          references={work?.references} boundedReferences workRevision={work?.revision}
          paging={{ ...workFeed.paging, setFilter: setPageFilter }}
          onChanged={() => setBump((n) => n + 1)} refs={refs} onFocusAgent={onJump} />
      </div>}
      {view === 'presented' && <div className="desk-tabpanel">
        <PanelCorner kind="agent-gallery" slug={slug} nid={node.id} />
        {/* nid = the project: the engine widens a project's gallery to its subtree */}
        <AgentGalleryView slug={slug} nid={node.id} node={node} toast={toast} onFocusAgent={onJump} refs={refs} />
      </div>}
    </>
  )
  return (
    <div className={bare ? 'desk-bare project-desk' : 'desk-over project-desk'} onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // as the agent desk: only real controls claim the gesture, so a press
        // on the desk's own chrome still pans the canvas
        if ((e.target as Element).closest('button, input, textarea, select, a, label, .mailrow, .project-description-md')) {
          e.stopPropagation()
        }
      }}>
      <div className={bare ? 'desk-body eye-chat' : 'desk-inner desk-body'}>{content}</div>
      {(asking === 'halt' || asking === 'unhalt') && createPortal(
        <AgentBatchHaltConfirm targets={agents} unhalt={asking === 'unhalt'}
          scope={`all agents under project ${node.id}`} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
      {asking === 'dissolve' && createPortal(
        <AgentRetireConfirm kind={members.length > 0 ? 'dissolve' : 'retire'} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
    </div>
  )
}

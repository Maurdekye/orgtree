// canvas/projectdesk.tsx — the PROJECT DESK (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-17 19:38Z: "give them a zoomed-in desk view,
// similar to agents, with tabs for the various things you can view in them").
// A focused project card, and a pinned project window, show this desk: the
// agent desk's frame and header, with tabs for what a project holds — its
// mail (and the fair-queue watchers it waits for), its docket, its
// presentations, its members and its description. A project takes no turns,
// so there is no chat, composer or turn state. The mail, docket and
// presentation tabs are the agent desk's own views (InboxView,
// AgentDocketView, AgentGalleryView), scoped to the project.

import { useMemo, useState } from 'react'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import type { ToastFn, TreePayload } from '../types'
import { FolderIcon, SettingsIcon } from '../icons'
import type { CanvasNode } from './shared'
import { InboxView } from './mail'
import { useWorkItems } from './useworkitems'
import { AgentDocketView, agentItems, itemActorIds, useNodeFacts } from './docket'
import { AgentGalleryView } from './gallery'
import { PanelCorner } from './panelcorner'
import type { RefRoutes } from './reflinks'
import { scratchFolderAction } from '../scratch-folder'

export const PROJECT_DESK_TABS = ['mail', 'docket', 'presented', 'members', 'about'] as const
type Tab = typeof PROJECT_DESK_TABS[number]

export interface ProjectDeskProps {
  node: CanvasNode
  slug: string
  tree: TreePayload
  map: Map<string, CanvasNode>
  toast: ToastFn
  refs: RefRoutes
  /** a pinned window's body: the desk unscaled, as DeskChat's `bare` */
  bare?: boolean
  onJump?: (id: string) => void
  onSettings?: () => void
  /** pin this desk as a window (absent: no pin button) */
  onPin?: () => void
}

export function ProjectDesk({ node, slug, tree, map, toast, refs, bare, onJump, onSettings, onPin }: ProjectDeskProps) {
  const [view, setView] = useState<Tab>('mail')
  // the docket tab: the items attached to this project (slice 2), one poll
  // while the tab is open, as the agent docket modal does
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const [pageFilter, setPageFilter] = useState<import('../workpages').WorkPageOptions>({})
  const workFeed = useWorkItems(slug, view === 'docket' && showArchived, view === 'docket' && showBacklog,
    15000, bump, { ...pageFilter, agent: node.id })
  const work = workFeed.value
  const mine = useMemo(() => agentItems(work, node.id, showArchived), [work, node.id, showArchived])
  const facts = useNodeFacts(slug, tree, useMemo(() => itemActorIds(mine), [mine]))
  const watchers = (tree.watchdogs ?? []).filter((w) => (w.kind as string) === 'fair_queue' && w.target === node.id)
  const members = node.children.filter((c) => c.state !== 'draft')
  const count = (tab: Tab) => tab === 'mail' ? node.mail_pending ?? 0
    : tab === 'docket' ? mine.length
      : tab === 'presented' ? node.documents_count ?? node.documents?.length ?? 0
        : tab === 'members' ? members.length : 0
  const live = node.state === 'live'
  const folder = scratchFolderAction(slug, node.id, toast)
  const content = (
    <>
      <div className="cc-head">
        <div className="cc-head-top">
          <span className="cc-head-left" data-copy-agent-name={node.id}>
            <span className="project-mark" title="project node: runs no turns, holds no credits">
              <FolderIcon fontSize="inherit" />
            </span>
            <span className="name">{node.id}</span>
            {!live && <span className="badge dim">{node.state}</span>}
          </span>
          <span className="spacer" aria-hidden="true" />
          <span className="cc-head-right">
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
          </span>
        </div>
      </div>
      {view === 'mail' && <div className="desk-tabpanel">
        <PanelCorner kind="node-inbox" slug={slug} nid={node.id} />
        <div className="project-fairqueue">
          <b>{node.mail_pending ?? 0} waiting</b> in the project mailbox{' · '}
          {watchers.length === 0
            ? 'nobody watches it with a fair_queue watchdog yet: mail waits here until one arms'
            : <>fair-queue watchers: {watchers.map((w, i) => (
              <span key={w.id}>{i > 0 ? ', ' : ''}{w.owner}{w.state === 'armed' ? '' : ` (${w.state})`}</span>
            ))}</>}
        </div>
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
        <AgentGalleryView slug={slug} nid={node.id} node={node} toast={toast} onFocusAgent={onJump} refs={refs} />
      </div>}
      {view === 'members' && <div className="desk-tabpanel project-members">
        {members.length === 0 && <div className="dim">Nobody works on this project yet. Hire under it from its card.</div>}
        {members.map((m) => (
          <button key={m.id} className="member" data-member={m.id} disabled={!onJump}
            title={onJump ? `go to ${m.id}` : undefined} onClick={() => onJump?.(m.id)}>
            {m.kind === 'project' ? <FolderIcon fontSize="inherit" /> : <span className={'tier t-' + m.tier}>{m.tier?.[0]?.toUpperCase() ?? ''}</span>}
            <span className="name">{m.id}</span>
            {m.state !== 'live' && <span className="badge dim">{m.state}</span>}
          </button>
        ))}
      </div>}
      {view === 'about' && <div className="desk-tabpanel project-about">
        <h4>Description</h4>
        {(node.charter ?? '').trim()
          ? <div className="project-description">{node.charter}</div>
          : <div className="project-description dim">No description.</div>}
        <p className="dim">The description is the standing charter of every agent under this project, nested
          projects included. A running agent picks up a change at its next start.</p>
        <div className="row">
          {onSettings && <button onClick={onSettings}><SettingsIcon fontSize="inherit" /> settings</button>}
          {folder && <button onClick={folder}><FolderIcon fontSize="inherit" /> open project folder</button>}
        </div>
      </div>}
    </>
  )
  return (
    <div className={bare ? 'desk-bare project-desk' : 'desk-over project-desk'} onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // as the agent desk: only real controls claim the gesture, so a press
        // on the desk's own chrome still pans the canvas
        if ((e.target as Element).closest('button, input, textarea, select, a, label, .mailrow')) e.stopPropagation()
      }}>
      <div className={bare ? 'desk-body eye-chat' : 'desk-inner desk-body'}>{content}</div>
    </div>
  )
}

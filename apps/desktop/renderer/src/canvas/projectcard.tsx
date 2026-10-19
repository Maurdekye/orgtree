// canvas/projectcard.tsx — the canvas card of a PROJECT NODE
// (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16): a node that stands
// for one project and is not an agent. It runs no turns and holds no
// credits, so it has no model, credit bar or turn state. Zoomed out it is a
// large folder; at middle zoom it shows its name, the activity chip (active /
// hired agents under it) and its documents (not its description: user
// 2026-10-18 08:50Z), with the mailbox
// button only under "Show agent card shortcuts". A click or zooming in walks
// to its PROJECT DESK (projectdesk.tsx; user 2026-10-17 19:38Z, 20:04Z), never
// a modal. It has an agent card's four hire strips, and its menu
// (projectMenuEntries, shared with the Agents List) reaches its mailbox,
// folder, presentations, settings, hires and nested projects, and its
// retirement. Agents and projects hang under it like under any card; dropping
// a card on it moves that card in.

import { useState } from 'react'
import { audienceAction } from '../api'
import { createPortal } from 'react-dom'
import type { ToastFn, TreePayload } from '../types'
import { DocIcon, DocketIcon, FolderIcon, MailIcon } from '../icons'
import { NODE_H, NODE_W, subtreeDocs, useAgentShortcuts, USER, Z_MAX } from './shared'
import { SpawnChips } from './cards'
import type { CanvasNode, HireProviders, OpFn, Pt } from './shared'
import type { RefRoutes } from './reflinks'
import { ProjectActivity, ProjectDesk, ProjectLastActivity } from './projectdesk'
import { PinnedPlaceholder } from './pins'
import { DocChips } from './docs'
import { useContextMenu } from './contextmenu'
import { scratchFolderAction } from '../scratch-folder'
import { AgentRetireConfirm, projectMenuEntries } from './agentmenu'
import type { RetireKind } from './agentmenu'
import { projectSlotState, slotBadgeText, slotCount, slotsFull } from './slots'
import { listenerCards, projectListenerState, queueAckMode, queueCard } from './listeners'
import { readQuickChat } from '../quickchat'
import { agentTooltipProps } from './agentnav'
import { useAgentSurfaceRoutes } from './panelcorner'

export function isProject(node: Pick<CanvasNode, 'kind'> | null | undefined): boolean {
  return node?.kind === 'project'
}

interface ProjectSquareProps {
  node: CanvasNode
  pos: Pt
  lod: 'mini' | 'norm'
  /** the camera is on it: the card is its project desk (user 2026-10-17 19:38Z) */
  focused?: boolean
  /** its desk is a pinned window: the card holds the placeholder */
  pinnedFocus?: boolean
  /** its desk is pinned (the menu then offers Desk as a pinned window) */
  pinned?: boolean
  /** the menu's Focus: walk the camera to its desk */
  onFocus?: () => void
  onShowPin?: () => void
  /** what the desk reads: the tree (watchdogs, facts), the node map and the
   *  canvas's reference routes; without them a focused card stays a card */
  tree?: TreePayload
  map?: Map<string, CanvasNode>
  refs?: RefRoutes
  onJump?: (id: string) => void
  onPin?: () => void
  dragging: boolean
  isDrop: boolean
  op: OpFn
  slug: string
  toast: ToastFn
  zoom: number
  /** which tiers a hire under it may use, as the agent menus offer them */
  hire: HireProviders
  seats: Record<string, number>
  onHire: (tier: string) => void
  /** "New project…" and its project token: a draft project card under it */
  onNewProject: () => void
  /** coworker and parent hires around the project, as around an agent (user
   *  2026-10-17 21:24:34Z): a sibling to a side, a superior spliced above */
  onSpawnSide?: (tier: string, side: 'left' | 'right') => void
  onSpawnTop?: (tier: string) => void
  /** the side and top strips' project tokens */
  onNewProjectAt?: (edge: 'l' | 'r' | 't') => void
  onInbox: (keepOpen?: boolean) => void
  onTeam?: (keepOpen?: boolean) => void
  onSettings?: (keepOpen?: boolean) => void
  /** the project's docket: its attached items */
  onDocket?: (keepOpen?: boolean) => void
  onOpenDoc?: (id: string) => void
  /** the project's presentations; `team` its team presentations (point 27) */
  onOpenGallery?: (id: string, opts?: { team?: boolean; keepOpen?: boolean }) => void
  /** its desk as a temporary modal, or popped out to a window (point 27) */
  onOpenTemporary?: () => void
  onPopout?: () => void
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragMove: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragEnd: (e: React.PointerEvent<HTMLDivElement>, id: string, node: CanvasNode, focused: boolean) => void
  onDragCancel: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
}

export function ProjectSquare({ node, pos, lod, focused, pinnedFocus, pinned, onFocus, onShowPin, tree, map, refs, onJump, onPin, dragging, isDrop, op, slug, toast, zoom, hire, seats,
  onHire, onNewProject, onSpawnSide, onSpawnTop, onNewProjectAt, onInbox, onTeam, onSettings, onDocket, onOpenDoc, onOpenGallery,
  onOpenTemporary, onPopout, onDragStart, onDragMove, onDragEnd, onDragCancel }: ProjectSquareProps) {
  const menu = useContextMenu()
  const surfaceRoutes = useAgentSurfaceRoutes()
  // the mailbox hover button obeys "Show agent card shortcuts", like an
  // agent card's hover row (user 2026-10-17 19:37Z)
  const showShortcuts = useAgentShortcuts()
  const [asking, setAsking] = useState<RetireKind | null>(null)
  const [expandedHire, setExpandedHire] = useState<'b' | 'l' | 'r' | 't' | null>(null)
  // the nearest edge shows its strip, as on an agent card (NodeSquare.trackEdge)
  const [edge, setEdge] = useState<'b' | 'l' | 'r' | 't'>('b')
  const trackEdge = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!r.width || !r.height) return
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
    const d = Math.min(x, 1 - x, 1 - y, y)
    const next = d === 1 - y ? 'b' : d === y ? 't' : d === x ? 'l' : 'r'
    if (next !== edge) { setExpandedHire(null); setEdge(next) }
  }
  const toggle = (which: 'b' | 'l' | 'r' | 't') => setExpandedHire((v) => v === which ? null : which)
  const waiting = node.mail_pending ?? 0
  // its OWN presentations (point 27): the subtree's are its team presentations
  const docs = node.documents_count ?? node.documents?.length ?? 0
  // its slots at a glance, while it has a count: filled when full, outlined
  // with a slot free (the approved slots mockup, user 2026-10-18)
  const slots = projectSlotState(node.id, slotCount(node), tree?.slot_leases ?? [], tree?.watchdogs ?? [])
  const slotBadge = slotBadgeText(slots)
  // its event listeners at a glance (cyan) and its mail queue (the
  // fair-queue rose), beside the slots badge (user 2026-10-19)
  const listenerState = projectListenerState(node.id, tree?.watchdogs ?? [])
  const listenerBadges = listenerCards(node.id, listenerState)
  const queue = queueCard(node.id, waiting, node.mail_held ?? 0, queueAckMode(node))
  // the bottom edge's hire tokens only: agents and nested projects go under it
  const deskOpen = !!(focused && tree && refs && lod !== 'mini')
  const cls = ['sq', 'project', node.state, deskOpen ? 'desk' : lod, 'edge-' + edge]
  if (dragging) cls.push('lifted')
  if (isDrop) cls.push('drop')
  const style: React.CSSProperties = {
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    width: NODE_W, height: NODE_H,
    zIndex: dragging ? 8 : undefined,
  }
  if (zoom > 0) Object.assign(style, { '--invzf': Math.max(1 / Z_MAX, 1 / zoom).toFixed(3) })
  const menuEntries = () => projectMenuEntries(node, {
    onInbox: () => onInbox(true),
    onTeam: onTeam ? () => onTeam(true) : undefined,
    onDocket: onDocket ? () => onDocket(true) : undefined,
    onSlots: surfaceRoutes ? () => surfaceRoutes.open('project-slots', node.id) : undefined,
    onScratchFolder: scratchFolderAction(slug, node.id, toast),
    onPresentations: onOpenGallery ? () => onOpenGallery(node.id, { keepOpen: true }) : undefined,
    onTeamPresentations: onOpenGallery ? () => onOpenGallery(node.id, { team: true, keepOpen: true }) : undefined,
    onOpenTemporary,
    onPopout,
    onSettings: () => onSettings?.(true),
    onToggleUserAudience: () => audienceAction(slug,
      (node.audiences_explicit ?? node.audiences_held)?.includes(USER) ? 'revoke' : 'grant', node.id, USER)
      .catch((e: Error) => toast(['error: ' + e.message])),
    onHire,
    onHireBeside: onSpawnSide ? (t) => onSpawnSide(t, 'right') : undefined,
    onHireAbove: onSpawnTop,
    onNewProject,
    onRetireAsk: setAsking,
    onOpenDesk: onFocus,
    onPin,
    onShowPin,
  }, { ...hire, pinned, quickChatTier: readQuickChat(slug, tree?.quick_chat).tier })
  return (
    <div data-copy-agent-name={node.id} className={cls.join(' ')} style={style}
      aria-label={`project ${node.id}`}
      // a desk's own presses pan the canvas or work its controls, as an agent desk's do
      onPointerDown={(e) => { if (!deskOpen) onDragStart(e, node.id) }}
      onPointerMove={(e) => { trackEdge(e); onDragMove(e, node.id) }}
      onPointerUp={(e) => onDragEnd(e, node.id, node, false)}
      onPointerCancel={(e) => onDragCancel(e, node.id)}
      onClick={(e) => {
        if (!deskOpen) return
        if ((e.target as Element).closest('button, input, textarea, select, a, label, [role="button"], [contenteditable="true"]')) return
        if (window.getSelection()?.toString()) return
        onFocus?.()
      }}
      onContextMenu={(e) => menu.open(e, menuEntries)}>
      {lod === 'mini' ? (
        <span className="project-mini" {...agentTooltipProps(node.id, true)}><FolderIcon fontSize="inherit" /></span>
      ) : (
        <>
          <div className="sq-head project-head">
            <div className="sq-title">
              <span className="project-mark" {...agentTooltipProps(node.id, true)}>
                <FolderIcon fontSize="inherit" />
              </span>
              <span className="name" {...agentTooltipProps(node.id)}>{node.id}</span>
            </div>
            <div className="sq-meta project-meta">
              <ProjectActivity node={node} />
              <ProjectLastActivity node={node} />
              {node.state !== 'live' && <span className="badge dim">{node.state}</span>}
            </div>
            {slotBadge && <span className={'project-slots-badge' + (slotsFull(slots) ? ' full' : '')}
              title={`${slots.held.length} of ${slots.total} concurrency slot${slots.total === 1 ? '' : 's'} held`
                + (slots.held.length ? ' by ' + slots.held.map((l) => l.agent).join(', ') : '')
                + (slots.line.length ? `; in line: ${slots.line.map((w) => w.agent).join(', ')}` : '')}>{slotBadge}</span>}
            {listenerBadges.map((c) => <span key={c.key} className={'project-listeners-badge' + (c.bright ? ' bright' : '')}
              title={c.title}>{c.text}</span>)}
            {queue && <span className="project-queue-badge" title={queue.title}>{queue.text}</span>}
          </div>
          {/* no description preview here: it lives on the project desk (user 2026-10-18 08:50Z) */}
          {showShortcuts && <div className="sq-actions project-actions">
            {/* the agent card's hover row, for what a project holds (user
                2026-10-17 22:21Z): its docket, its mailbox with the waiting
                mail, and its presented documents (its own and its subtree's) */}
            {onDocket && <button className="mailbtn docketbtn" aria-label={`Docket for project ${node.id}`}
              title={`Docket for project ${node.id}: the items owned by agents under it`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDocket() }}>
              <DocketIcon fontSize="inherit" />
            </button>}
            <button className={'mailbtn' + (waiting > 0 ? ' has' : '')}
              aria-label={`mailbox of project ${node.id}`}
              title={waiting > 0
                ? `${waiting} mail waiting for a fair_queue watcher — open the project mailbox`
                : 'open the project mailbox'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onInbox() }}>
              <MailIcon fontSize="inherit" />{waiting > 0 && <span className="count">{waiting}</span>}
            </button>
            {onOpenGallery && docs > 0 &&
              <button className="presentedbtn" aria-label={`presented documents for project ${node.id}`}
                title={`open the ${docs} presented document${docs === 1 ? '' : 's'} of project ${node.id}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpenGallery(node.id) }}>
                <DocIcon fontSize="inherit" />
              </button>}
          </div>}
        </>
      )}
      {node.state === 'live' && (
        <SpawnChips onSpawn={onHire} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire} museHire={hire.museHire}
          zoom={zoom} expanded={expandedHire === 'b'} onToggleExpanded={() => toggle('b')}
          onProject={onNewProject} />
      )}
      {node.state === 'live' && onSpawnSide && (['left', 'right'] as const).map((s) => (
        <SpawnChips key={s} side={s} onSpawn={(t) => onSpawnSide(t, s)} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire} museHire={hire.museHire}
          zoom={zoom} expanded={expandedHire === s[0]} onToggleExpanded={() => toggle(s[0] as 'l' | 'r')}
          onProject={onNewProjectAt ? () => onNewProjectAt(s[0] as 'l' | 'r') : undefined} />
      ))}
      {node.state === 'live' && onSpawnTop && (
        <SpawnChips side="top" onSpawn={onSpawnTop} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire} museHire={hire.museHire}
          zoom={zoom} expanded={expandedHire === 't'} onToggleExpanded={() => toggle('t')}
          onProject={onNewProjectAt ? () => onNewProjectAt('t') : undefined} />
      )}
      {deskOpen && (
        <ProjectDesk node={node} slug={slug} tree={tree!} map={map ?? new Map()} toast={toast} refs={refs!}
          op={op} onJump={onJump} onConfig={onSettings} onPin={onPin} onPopout={onPopout} onOpenDoc={onOpenDoc} />
      )}
      {pinnedFocus && !deskOpen && onShowPin && (
        <div className="pin-holder"><PinnedPlaceholder id={node.id} onShow={onShowPin} /></div>
      )}
      {/* its own presentations and its subtree's (user 2026-10-17 22:47:29Z) */}
      {lod !== 'mini' && !deskOpen && subtreeDocs(node).length > 0 && onOpenDoc && (
        <DocChips slug={slug} docs={subtreeDocs(node)} onOpen={onOpenDoc} />
      )}
      {menu.node}
      {asking && createPortal(
        <AgentRetireConfirm kind={asking} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
    </div>
  )
}

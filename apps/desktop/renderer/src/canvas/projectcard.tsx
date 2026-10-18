// canvas/projectcard.tsx — the canvas card of a PROJECT NODE
// (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16): a node that stands
// for one project and is not an agent. It runs no turns and holds no
// credits, so it has no model, credit bar or turn state. Zoomed out it is a
// large folder; at middle zoom it shows its name, the activity chip (active /
// hired agents under it), its description and its documents, with the mailbox
// button only under "Show agent card shortcuts". A click or zooming in walks
// to its PROJECT DESK (projectdesk.tsx; user 2026-10-17 19:38Z, 20:04Z), never
// a modal. It has an agent card's four hire strips, and its menu
// (projectMenuEntries, shared with the Agents List) reaches its mailbox,
// folder, presentations, settings, hires and nested projects, and its
// retirement. Agents and projects hang under it like under any card; dropping
// a card on it moves that card in.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn, TreePayload } from '../types'
import { DocIcon, DocketIcon, FolderIcon, MailIcon } from '../icons'
import { NODE_H, NODE_W, subtreeDocs, useAgentShortcuts, Z_MAX } from './shared'
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
  /** its desk is pinned (the menu then offers Show pinned window) */
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
  onInbox: () => void
  onSettings?: () => void
  /** the project's docket: its attached items */
  onDocket?: () => void
  onOpenDoc?: (id: string) => void
  /** the project's presentations; `team` its team presentations (point 27) */
  onOpenGallery?: (id: string, opts?: { team?: boolean }) => void
  /** its desk as a temporary modal, or popped out to a window (point 27) */
  onOpenTemporary?: () => void
  onPopout?: () => void
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragMove: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragEnd: (e: React.PointerEvent<HTMLDivElement>, id: string, node: CanvasNode, focused: boolean) => void
  onDragCancel: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
}

export function ProjectSquare({ node, pos, lod, focused, pinnedFocus, pinned, onFocus, onShowPin, tree, map, refs, onJump, onPin, dragging, isDrop, op, slug, toast, zoom, hire, seats,
  onHire, onNewProject, onSpawnSide, onSpawnTop, onNewProjectAt, onInbox, onSettings, onDocket, onOpenDoc, onOpenGallery,
  onOpenTemporary, onPopout, onDragStart, onDragMove, onDragEnd, onDragCancel }: ProjectSquareProps) {
  const menu = useContextMenu()
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
  const description = (node.charter ?? '').trim().split('\n')[0] ?? ''
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
    onInbox,
    onDocket,
    onScratchFolder: scratchFolderAction(slug, node.id, toast),
    onPresentations: onOpenGallery ? () => onOpenGallery(node.id) : undefined,
    onTeamPresentations: onOpenGallery ? () => onOpenGallery(node.id, { team: true }) : undefined,
    onOpenTemporary,
    onPopout,
    onSettings: () => onSettings?.(),
    onHire,
    onHireBeside: onSpawnSide ? (t) => onSpawnSide(t, 'right') : undefined,
    onHireAbove: onSpawnTop,
    onNewProject,
    onRetireAsk: setAsking,
    onOpenDesk: onFocus,
    onPin,
    onShowPin,
  }, { ...hire, pinned })
  return (
    <div data-copy-agent-name={node.id} className={cls.join(' ')} style={style}
      aria-label={`project ${node.id}`}
      // a desk's own presses pan the canvas or work its controls, as an agent desk's do
      onPointerDown={(e) => { if (!deskOpen) onDragStart(e, node.id) }}
      onPointerMove={(e) => { trackEdge(e); onDragMove(e, node.id) }}
      onPointerUp={(e) => onDragEnd(e, node.id, node, false)}
      onPointerCancel={(e) => onDragCancel(e, node.id)}
      onContextMenu={(e) => menu.open(e, menuEntries)}>
      {lod === 'mini' ? (
        <span className="project-mini" title={`project ${node.id}`}><FolderIcon fontSize="inherit" /></span>
      ) : (
        <>
          <div className="sq-head project-head">
            <div className="sq-title">
              <span className="project-mark" title="project node: runs no turns, holds no credits">
                <FolderIcon fontSize="inherit" />
              </span>
              <span className="name" title={`project ${node.id}`}>{node.id}</span>
            </div>
            <div className="sq-meta project-meta">
              <ProjectActivity node={node} />
              <ProjectLastActivity node={node} />
              {node.state !== 'live' && <span className="badge dim">{node.state}</span>}
            </div>
          </div>
          {description && <div className="project-desc" title={node.charter ?? undefined}>{description}</div>}
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
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire}
          zoom={zoom} expanded={expandedHire === 'b'} onToggleExpanded={() => toggle('b')}
          onProject={onNewProject} />
      )}
      {node.state === 'live' && onSpawnSide && (['left', 'right'] as const).map((s) => (
        <SpawnChips key={s} side={s} onSpawn={(t) => onSpawnSide(t, s)} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire}
          zoom={zoom} expanded={expandedHire === s[0]} onToggleExpanded={() => toggle(s[0] as 'l' | 'r')}
          onProject={onNewProjectAt ? () => onNewProjectAt(s[0] as 'l' | 'r') : undefined} />
      ))}
      {node.state === 'live' && onSpawnTop && (
        <SpawnChips side="top" onSpawn={onSpawnTop} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire}
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

// canvas/projectcard.tsx — the canvas card of a PROJECT NODE
// (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16): a node that stands
// for one project and is not an agent. It runs no turns and holds no
// credits, so it has no desk, model, credit bar or turn state. The card shows
// its name, description, the mail waiting in its mailbox and its documents;
// a click opens its mailbox, and its menu (projectMenuEntries, shared with
// the Agents List) reaches its presentations, folder, hires and nested
// projects under it, and its retirement. Agents and projects hang under it
// like under any card; dropping a card on it moves that card in.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn, TreePayload } from '../types'
import { FolderIcon, MailIcon } from '../icons'
import { NODE_H, NODE_W, useAgentShortcuts, Z_MAX } from './shared'
import { SpawnChips } from './cards'
import type { CanvasNode, HireProviders, OpFn, Pt } from './shared'
import type { RefRoutes } from './reflinks'
import { ProjectActivity, ProjectDesk } from './projectdesk'
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
  onInbox: () => void
  onSettings?: () => void
  /** the project's docket: its attached items */
  onDocket?: () => void
  onOpenDoc?: (id: string) => void
  onOpenGallery?: (id: string) => void
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragMove: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragEnd: (e: React.PointerEvent<HTMLDivElement>, id: string, node: CanvasNode, focused: boolean) => void
  onDragCancel: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
}

export function ProjectSquare({ node, pos, lod, focused, pinnedFocus, onShowPin, tree, map, refs, onJump, onPin, dragging, isDrop, op, slug, toast, zoom, hire, seats,
  onHire, onNewProject, onInbox, onSettings, onDocket, onOpenDoc, onOpenGallery, onDragStart, onDragMove, onDragEnd, onDragCancel }: ProjectSquareProps) {
  const menu = useContextMenu()
  // the mailbox hover button obeys "Show agent card shortcuts", like an
  // agent card's hover row (user 2026-10-17 19:37Z)
  const showShortcuts = useAgentShortcuts()
  const [asking, setAsking] = useState<RetireKind | null>(null)
  const [expandedHire, setExpandedHire] = useState(false)
  const waiting = node.mail_pending ?? 0
  const description = (node.charter ?? '').trim().split('\n')[0] ?? ''
  // the bottom edge's hire tokens only: agents and nested projects go under it
  const deskOpen = !!(focused && tree && refs && lod !== 'mini')
  const cls = ['sq', 'project', node.state, deskOpen ? 'desk' : lod, 'edge-b']
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
    onSettings: () => onSettings?.(),
    onHire,
    onNewProject,
    onRetireAsk: setAsking,
  }, hire)
  return (
    <div data-copy-agent-name={node.id} className={cls.join(' ')} style={style}
      aria-label={`project ${node.id}`}
      // a desk's own presses pan the canvas or work its controls, as an agent desk's do
      onPointerDown={(e) => { if (!deskOpen) onDragStart(e, node.id) }}
      onPointerMove={(e) => onDragMove(e, node.id)}
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
              {node.state !== 'live' && <span className="badge dim">{node.state}</span>}
            </div>
          </div>
          {description && <div className="project-desc" title={node.charter ?? undefined}>{description}</div>}
          {showShortcuts && <div className="sq-actions project-actions">
            <button className={'mailbtn' + (waiting > 0 ? ' has' : '')}
              aria-label={`mailbox of project ${node.id}`}
              title={waiting > 0
                ? `${waiting} mail waiting for a fair_queue watcher — open the project mailbox`
                : 'open the project mailbox'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onInbox() }}>
              <MailIcon fontSize="inherit" />{waiting > 0 && <span className="count">{waiting}</span>}
            </button>
          </div>}
        </>
      )}
      {node.state === 'live' && (
        <SpawnChips onSpawn={onHire} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire}
          zoom={zoom} expanded={expandedHire} onToggleExpanded={() => setExpandedHire((v) => !v)}
          onProject={onNewProject} />
      )}
      {deskOpen && (
        <ProjectDesk node={node} slug={slug} tree={tree!} map={map ?? new Map()} toast={toast} refs={refs!}
          op={op} onJump={onJump} onConfig={onSettings} onPin={onPin} />
      )}
      {pinnedFocus && !deskOpen && onShowPin && (
        <div className="pin-holder"><PinnedPlaceholder id={node.id} onShow={onShowPin} /></div>
      )}
      {lod !== 'mini' && (node.documents?.length ?? 0) > 0 && onOpenDoc && (
        <DocChips slug={slug} docs={node.documents!} onOpen={onOpenDoc} />
      )}
      {menu.node}
      {asking && createPortal(
        <AgentRetireConfirm kind={asking} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
    </div>
  )
}

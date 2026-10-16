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
import type { ToastFn } from '../types'
import { FolderIcon, MailIcon } from '../icons'
import { NODE_H, NODE_W, Z_MAX } from './shared'
import { SpawnChips } from './cards'
import type { CanvasNode, HireProviders, OpFn, Pt } from './shared'
import { DocChips } from './docs'
import { useContextMenu } from './contextmenu'
import { scratchFolderAction } from '../scratch-folder'
import { AgentRetireConfirm, projectMenuEntries } from './agentmenu'
import type { RetireKind } from './agentmenu'
import { NewProjectModal } from './newproject'

export function isProject(node: Pick<CanvasNode, 'kind'> | null | undefined): boolean {
  return node?.kind === 'project'
}

interface ProjectSquareProps {
  node: CanvasNode
  pos: Pt
  lod: 'mini' | 'norm'
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
  onInbox: () => void
  /** the project's docket: its attached items */
  onDocket?: () => void
  onOpenDoc?: (id: string) => void
  onOpenGallery?: (id: string) => void
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragMove: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragEnd: (e: React.PointerEvent<HTMLDivElement>, id: string, node: CanvasNode, focused: boolean) => void
  onDragCancel: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
}

export function ProjectSquare({ node, pos, lod, dragging, isDrop, op, slug, toast, zoom, hire, seats,
  onHire, onInbox, onDocket, onOpenDoc, onOpenGallery, onDragStart, onDragMove, onDragEnd, onDragCancel }: ProjectSquareProps) {
  const menu = useContextMenu()
  const [asking, setAsking] = useState<RetireKind | null>(null)
  const [naming, setNaming] = useState(false)
  const [expandedHire, setExpandedHire] = useState(false)
  const waiting = node.mail_pending ?? 0
  const description = (node.charter ?? '').trim().split('\n')[0] ?? ''
  // the bottom edge's hire tokens only: agents and nested projects go under it
  const cls = ['sq', 'project', node.state, lod, 'edge-b']
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
    onSettings: () => {},
    onHire,
    onNewProject: () => setNaming(true),
    onRetireAsk: setAsking,
  }, hire)
  return (
    <div data-copy-agent-name={node.id} className={cls.join(' ')} style={style}
      aria-label={`project ${node.id}`}
      onPointerDown={(e) => onDragStart(e, node.id)}
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
              <span className="project-kind">project</span>
              {node.state !== 'live' && <span className="badge dim">{node.state}</span>}
            </div>
          </div>
          {description && <div className="project-desc" title={node.charter ?? undefined}>{description}</div>}
          <div className="sq-actions project-actions">
            <button className={'mailbtn' + (waiting > 0 ? ' has' : '')}
              aria-label={`mailbox of project ${node.id}`}
              title={waiting > 0
                ? `${waiting} mail waiting for a fair_queue watcher — open the project mailbox`
                : 'open the project mailbox'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onInbox() }}>
              <MailIcon fontSize="inherit" />{waiting > 0 && <span className="count">{waiting}</span>}
            </button>
          </div>
        </>
      )}
      {node.state === 'live' && (
        <SpawnChips onSpawn={onHire} seats={seats}
          claudeHire={hire.claudeHire} codexHire={hire.codexHire} antigravityHire={hire.antigravityHire}
          openrouterHire={hire.openrouterHire} langserverHire={hire.langserverHire}
          zoom={zoom} expanded={expandedHire} onToggleExpanded={() => setExpandedHire((v) => !v)}
          onProject={() => setNaming(true)} />
      )}
      {lod !== 'mini' && (node.documents?.length ?? 0) > 0 && onOpenDoc && (
        <DocChips slug={slug} docs={node.documents!} onOpen={onOpenDoc} />
      )}
      {menu.node}
      {asking && createPortal(
        <AgentRetireConfirm kind={asking} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
      {naming && createPortal(
        <NewProjectModal parent={node.id} op={op} toast={toast} close={() => setNaming(false)} />, document.body)}
    </div>
  )
}

// attention/AttentionView.tsx — THE ATTENTION VIEW ITSELF: the stage, the
// divider, and the two independently pinnable / poppable panels.
//
// WHAT MAKES THE RETENTION RULE TRUE BY CONSTRUCTION. The ticket requires that
// a panel which is pinned or popped out SURVIVES the switch back to the canvas,
// alongside the canvas's own pinned windows and desks, with nothing closed,
// recreated or silently unpinned. A pinned surface's DOM lives in the pin layer
// and a popped-out one lives in a child window — but BOTH are still filled by a
// React subtree, and a subtree that unmounts takes its window with it. So this
// view does not unmount its panels when the organization switches to the canvas:
// it keeps mounted exactly those that are pinned or detached, and renders the
// stage itself hidden. The panel's own surface has already moved its content
// out of that stage, so hiding the stage hides nothing the user placed.
//
//   active   embedded panels render into the stage; pinned/popped ones render
//            through their own surface, as they already were
//   inactive ONLY pinned/popped panels stay mounted; the stage is hidden and
//            holds nothing but their (empty) placeholders
//
// ⚠ THE STAGE IS HIDDEN, NOT THE HOST. `adoptPinLayer` puts the pin layer
// INSIDE the canvas host, so hiding the host would hide every pinned window in
// the organization — the canvas's and this view's alike. Only this view's own
// stage is hidden, and it is the only thing that should disappear when the
// canvas comes back.
//
// THE DIVIDER exists only while BOTH panels are embedded, because that is the
// only arrangement in which there is a margin between them to drag. Pin or pop
// either one out and the other takes the stage; the stored split is untouched
// and comes back with the panel.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode,
} from 'react'
import type { ToastFn, TreePayload } from '../types'
import type { CanvasNode, OpFn, Pt } from '../canvas/shared'
import type { DeskChatProps } from '../canvas/desk'
import type { TypedRef } from '../canvas/workrefs'
import {
  isModalPinned, PinFrame, readModalOpen, unpinModal, useModalPin, usePersistedModalOpen,
} from '../canvas/modalpin'
import { restoredWindows } from '../windowlayout'
import { openSurfaces, subscribeWindows, windowRevision } from '../windowlife'
import { LanIcon, NotificationsActiveIcon } from '../icons'
import { AttentionQueue } from './AttentionQueue'
import { AgentDeskPanel } from './AgentDeskPanel'
import {
  clampSplit, setAttentionLayout, setOrgView, SPLIT_MAX, SPLIT_MIN,
  startAttentionModeSync, useAttentionLayout, useOrgView,
} from './mode'
import './attention.css'

/** the two panels' storage identities — reserved for this feature
 *  (coordinator, 2026-09-21). Ordinary `PinFrame` kinds: pin, popout,
 *  per-org persistence and window restore all come from the existing
 *  surface machinery, and no second window system exists. */
export const QUEUE_KIND = 'attention-queue'
export const DESK_KIND = 'attention-desk'

/** Is a surface of this kind popped out into its own window RIGHT NOW, in this
 *  organization? `windowlife` is the canonical registry every movable surface
 *  registers with; asking it is what makes this reactive without a second
 *  copy of the truth. The org is part of the question — another organization's
 *  window of the same kind is not this one. */
function useDetachedKind(kind: string, org: string | null): boolean {
  const revision = useSyncExternalStore(subscribeWindows, windowRevision, windowRevision)
  return useMemo(
    () => openSurfaces().some((s) => s.kind === kind && s.org === org),
    // `revision` is the dependency that matters: the registry is mutable and
    // its identity never changes, so the revision is what says it moved.
    [revision, kind, org])
}

export interface AttentionViewProps {
  slug: string
  tree: TreePayload
  op: OpFn
  toast: ToastFn
  /** the organization's flattened canvas map, from the host that owns it */
  map: Map<string, CanvasNode>
  /** the host's layout position for an agent, for the list's visual order */
  posOf?: (id: string) => Pt | undefined
  /** routes out of the simplified workflow; each omitted one draws no control */
  onOpenItem?: (itemSlug: string) => void
  onFocusAgent?: (agentId: string) => void
  onOpenDoc?: (docId: string) => void
  onOpenMail?: (ref: TypedRef) => void
  /** the Desk's own host routes, passed through untouched */
  deskExtras?: Partial<DeskChatProps>
}

export function AttentionView(props: AttentionViewProps) {
  const { slug } = props
  const view = useOrgView(slug)
  const active = view === 'attention'
  const layout = useAttentionLayout(slug)

  useEffect(() => startAttentionModeSync(), [])

  // pinned/detached are read per panel so the two are genuinely independent:
  // pinning one says nothing about the other, and neither says anything about
  // whether the view is the one on screen.
  const queuePinned = useModalPin(QUEUE_KIND, slug) !== null
  const deskPinned = useModalPin(DESK_KIND, slug) !== null
  const queueOut = useDetachedKind(QUEUE_KIND, slug)
  const deskOut = useDetachedKind(DESK_KIND, slug)

  // A window saved as open is restored by the surface machinery — but only if
  // the surface is MOUNTED to be restored into. On the first render for an
  // organization, mount whatever its saved layout says was left open, even
  // when the organization itself opens on the canvas.
  const [restored, setRestored] = useState<{ slug: string; queue: boolean; desk: boolean }>(
    { slug: '', queue: false, desk: false })
  useEffect(() => {
    if (restored.slug === slug) return
    const rows = restoredWindows(slug)
    const open = readModalOpen(slug)
    const was = (kind: string) =>
      rows.some((r) => r.kind === kind)
      || open.some((r) => r.kind === kind && isModalPinned(kind, slug))
    setRestored({ slug, queue: was(QUEUE_KIND), desk: was(DESK_KIND) })
  }, [slug, restored.slug])
  const restoredHere = restored.slug === slug

  const queueKept = queuePinned || queueOut || (restoredHere && restored.queue)
  const deskKept = deskPinned || deskOut || (restoredHere && restored.desk)
  const queueOn = active || queueKept
  const deskOn = active || deskKept

  usePersistedModalOpen(QUEUE_KIND, slug, queueOn)
  usePersistedModalOpen(DESK_KIND, slug, deskOn)

  // the divider exists only while there IS a margin between two embedded
  // panels — see the file header
  const queueEmbedded = queueOn && !queuePinned && !queueOut
  const deskEmbedded = deskOn && !deskPinned && !deskOut
  const dividable = active && queueEmbedded && deskEmbedded

  const stageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  // the in-flight rect lives in component state (one render per pointer move);
  // the store is written ONCE, at pointer-up — the same rule every drag in
  // this app follows (see PinFrameInner in canvas/modalpin.tsx)
  const [live, setLive] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const split = clampSplit(live ?? layout.split)

  const commit = useCallback((value: number) => {
    setAttentionLayout(slug, { split: clampSplit(value) })
  }, [slug])

  const fromPointer = (clientX: number): number | null => {
    const box = stageRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return null
    return clampSplit((clientX - box.left) / box.width)
  }
  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()          // never let this reach the canvas behind it
    drag.current = e.pointerId
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDividerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== e.pointerId) return
    const next = fromPointer(e.clientX)
    if (next !== null) setLive(next)
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== e.pointerId) return
    drag.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* gone */ }
    if (live !== null) commit(live)
    setLive(null)
  }
  const onDividerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = split - step
    else if (e.key === 'ArrowRight') next = split + step
    else if (e.key === 'Home') next = SPLIT_MIN
    else if (e.key === 'End') next = SPLIT_MAX
    if (next === null) return
    e.preventDefault()
    commit(next)
  }

  const leftStyle = dividable ? { flex: `0 0 ${(split * 100).toFixed(2)}%` } : undefined
  const rightStyle = dividable ? { flex: '1 1 0' } : undefined

  return (
    <div ref={stageRef}
      className={'attn-stage' + (active ? '' : ' attn-stage-off')
        + (dragging ? ' attn-dragging' : '')}
      data-attention-active={active ? 'yes' : 'no'}
      aria-hidden={active ? undefined : true}>
      {queueOn && (
        <div className="attn-slot attn-slot-queue" style={leftStyle}>
          <PinFrame inline kind={QUEUE_KIND} title="Needs attention"
            panel="settings attn-panel attn-panel-queue"
            dialogLabel="Needs attention"
            close={() => unpinModal(QUEUE_KIND, slug)}>
            <AttentionQueue slug={slug} tree={props.tree} toast={props.toast}
              onOpenItem={props.onOpenItem} onFocusAgent={props.onFocusAgent}
              onOpenDoc={props.onOpenDoc} onOpenMail={props.onOpenMail} />
          </PinFrame>
        </div>
      )}
      {dividable && (
        <div className="attn-divider" role="separator" tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize the Needs attention panel"
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round(SPLIT_MAX * 100)}
          aria-valuenow={Math.round(split * 100)}
          onPointerDown={onDividerDown} onPointerMove={onDividerMove}
          onPointerUp={endDrag} onPointerCancel={endDrag}
          onKeyDown={onDividerKey}>
          <span className="attn-divider-grip" aria-hidden="true" />
        </div>
      )}
      {deskOn && (
        <div className="attn-slot attn-slot-desk" style={rightStyle}>
          <PinFrame inline kind={DESK_KIND} title="Agent desk"
            panel="settings attn-panel attn-panel-desk"
            dialogLabel="Agent desk"
            close={() => unpinModal(DESK_KIND, slug)}>
            <AgentDeskPanel slug={slug} tree={props.tree} op={props.op}
              toast={props.toast} map={props.map} posOf={props.posOf}
              deskExtras={props.deskExtras} />
          </PinFrame>
        </div>
      )}
    </div>
  )
}

/** The organization's view switch, for the compact header. Prominent and
 *  LABELLED (approved header design): the two views are named, not iconified,
 *  because which view you are in is the least guessable piece of state in the
 *  window. */
export function OrgViewToggle({ slug, disabled }: { slug: string | null; disabled?: boolean }) {
  const view = useOrgView(slug)
  if (!slug) return null
  const tab = (value: 'canvas' | 'attention', label: string, icon: ReactNode, hint: string) => (
    <button type="button" className={'orgview-tab' + (view === value ? ' sel' : '')}
      aria-pressed={view === value} disabled={disabled}
      title={hint} onClick={() => setOrgView(slug, value)}>
      {icon}<span className="orgview-label">{label}</span>
    </button>
  )
  return (
    <div className="orgview-toggle" role="group" aria-label="Organization view">
      {tab('canvas', 'Canvas', <LanIcon fontSize="inherit" />,
        'the full organization canvas')}
      {tab('attention', 'Attention', <NotificationsActiveIcon fontSize="inherit" />,
        'only what is waiting on you, beside one agent desk')}
    </div>
  )
}

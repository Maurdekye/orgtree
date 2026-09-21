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
import { PinFrame, unpinModal, useModalPin, usePersistedModalOpen } from '../canvas/modalpin'
import { restoredWindows, useRestoreWindows, WINDOW_LAYOUT_KEY } from '../windowlayout'
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

/** Which of this view's panels are popped out into their own window RIGHT NOW,
 *  in this organization? `windowlife` is the canonical registry every movable
 *  surface registers with; asking it is what makes this reactive without a
 *  second copy of the truth. The org is part of the question — another
 *  organization's window of the same kind is not this one. */
function useDetachedHere(org: string | null, revision: number): { queue: boolean; desk: boolean } {
  return useMemo(() => {
    const here = openSurfaces().filter((s) => s.org === org)
    return {
      queue: here.some((s) => s.kind === QUEUE_KIND),
      desk: here.some((s) => s.kind === DESK_KIND),
    }
    // `revision` is the dependency that matters: the registry is mutable and
    // its identity never changes, so the revision is what says it moved.
  }, [revision, org])
}

/**
 * Is the surface machinery still going to restore a saved window of this kind
 * into this view? A saved window can only be reopened into a subtree that is
 * MOUNTED, so a panel whose window the layout records as open has to exist even
 * when the organization opens on the Canvas.
 *
 * ⚠ READ LIVE, NEVER LATCHED, and this is the whole of the fix for the stage
 * review's finding f1. This used to be a `useState` armed by an effect that
 * returned early whenever the slug was unchanged — which made it a PERMANENT
 * keep-alive rather than the first-render restore window its own comment
 * described. A panel restored because the layout said its popped-out window was
 * open then stayed mounted after the user CLOSED that window: nothing pinned,
 * nothing detached, the organization on the Canvas, and the subtree still
 * there across a full mode round trip. Invisible (`.attn-stage-off` is
 * `display: none`), but for the Desk panel it is a live `DeskSlot` competing
 * under `Desks.put` for ownership of the very agent the user is looking at on
 * the Canvas, and `usePersistedModalOpen` kept re-asserting a panel the user
 * had closed as open.
 *
 * Read as a live question it is self-correcting: `closeSavedWindow` clears the
 * row the moment the window goes, so the next render of this component sees it
 * gone and lets the subtree go with it.
 *
 * ⚠ AN UNOBSERVED ASYNC RESTORE MUST NOT READ AS A CLOSE (multi-window-design,
 * 2026-09-21). A restore is not instant: `MovableSurface` waits for its own
 * `ready`, opens the window and then waits for its stylesheets, so there is a
 * gap between this panel mounting and the surface appearing in the registry.
 * Releasing the subtree in that gap would abort the very restore it was mounted
 * for. THE THREE STATES ARE DISTINGUISHED BY TWO RENDERER-OWNED FACTS, not by a
 * timer and not by a guess:
 *
 *   restore landed   the surface is in `windowlife`'s registry → `detached`
 *                    holds the panel; this claim is no longer what keeps it
 *   restore pending  the saved row still says open and nothing is registered →
 *                    held HERE, which is exactly the gap above
 *   window closed    `closeSavedWindow` cleared the row → released
 *
 * There is no fourth state, because `closeSavedWindow` is the ONLY writer of
 * `open: false` (windowlayout.ts) and it is called from exactly two places in
 * `MovableSurface`: `redock`, where the surface was registered, and the
 * surface's own unmount, which cannot precede this panel's. A future third
 * caller is the thing that would break this, which is why the audit is written
 * down rather than merely performed.
 *
 * ⚠ IT TAKES TWO SIGNALS AND NEEDS BOTH — measured, not assumed. The release
 * is driven by the window REGISTRY's own lifecycle event, and read from
 * STORAGE:
 *   · the view subscribes to `windowlife` once (`revision`, below) and hands
 *     it to this reader, so a surface registering or unregistering re-renders
 *     the view. A redock does `closeSavedWindow` AND the unregister in one go,
 *     so that one event is the whole of a close.
 *   · the re-render then re-reads the saved layout and sees the row gone.
 * Removing EITHER leaves the closed panel mounted: deleting the subscription
 * fails attentionview.test.tsx §7.1b (nothing re-renders, so nothing looks),
 * and latching the read fails §7.1/§7.1b/§7.2. Both mutants were run.
 *
 * ⚠ THE RAW STRING IS WHAT KEYS THE READ, not a parse on every render. The
 * saved layout has no store to subscribe to, so the cheap read (one `getItem`)
 * gates the expensive one (`JSON.parse` + filter).
 *
 * ⚠ GATED ON `useRestoreWindows`. If this installation is not going to restore
 * windows at all, there is no window coming and nothing to hold a subtree open
 * for. It is the same hook `MovableSurface` itself gates its restore on, so the
 * two cannot disagree about whether a restore is going to happen.
 */
function useAwaitingRestore(org: string | null, revision: number): { queue: boolean; desk: boolean } {
  const restoreAllowed = useRestoreWindows()
  let raw: string | null = null
  try { raw = localStorage.getItem(WINDOW_LAYOUT_KEY) } catch { raw = null }
  return useMemo(() => {
    if (!restoreAllowed) return { queue: false, desk: false }
    const rows = restoredWindows(org)
    return {
      queue: rows.some((r) => r.kind === QUEUE_KIND),
      desk: rows.some((r) => r.kind === DESK_KIND),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, restoreAllowed, raw, revision])
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
  // ONE subscription to the renderer's window registry for this view, handed
  // to both readers below. Both are questions about the live window lifecycle
  // and both have to be recomputed when it moves; two subscriptions to the
  // same store would be a second way to ask one question, and — measured —
  // either alone hid the other's absence when the mutants were run.
  const windows = useSyncExternalStore(subscribeWindows, windowRevision, windowRevision)
  const detached = useDetachedHere(slug, windows)
  const awaiting = useAwaitingRestore(slug, windows)
  const queueOut = detached.queue
  const deskOut = detached.desk

  // THE MOUNT RULE, and it is a claim that has to keep being true rather than
  // one established once: a panel exists on the Canvas exactly while it is
  // pinned, popped out, or still waiting for a saved window to be restored
  // into it. All three are read live, so each of them RELEASES the subtree as
  // soon as it stops holding — see useAwaitingRestore for what went wrong when
  // the third was latched instead.
  const queueOn = active || queuePinned || queueOut || awaiting.queue
  const deskOn = active || deskPinned || deskOut || awaiting.desk

  usePersistedModalOpen(QUEUE_KIND, slug, queueOn)
  usePersistedModalOpen(DESK_KIND, slug, deskOn)

  // the divider exists only while there IS a margin between two embedded
  // panels — see the file header
  const queueEmbedded = queueOn && !queuePinned && !queueOut
  const deskEmbedded = deskOn && !deskPinned && !deskOut
  const dividable = active && queueEmbedded && deskEmbedded

  /**
   * IS THE DESK PANEL'S DESTINATION ON SCREEN? — the `eligible` question the
   * desk registry asks (v3-effort-opus's host-slot interface rev 1, and
   * multi-window-design's refinement that the flag means the visibility of the
   * EMBEDDED DESTINATION and never "which org view is selected").
   *
   * True in three arrangements, and they are not the same as the three that
   * keep the panel MOUNTED:
   *   · the Attention stage is presented (the panel is embedded and visible)
   *   · the panel is pinned — its own window, visible in either view
   *   · the panel is popped out — its own native window, visible in either view
   *
   * It is deliberately FALSE for the fourth: mounted only because a saved
   * window is still being restored into it. That panel is embedded inside a
   * hidden stage, so its desk must not take ownership from the Canvas desk the
   * user is actually looking at. That is precisely the category finding f1 was
   * about, and it is the case this flag exists to cover — which is why the two
   * are fixed in one change rather than one relying on the other.
   *
   * A pinned or popped-out Attention panel stays ELIGIBLE while the
   * organization is on the Canvas. It is on screen; the user put it there.
   */
  const deskEligible = active || deskPinned || deskOut

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
              eligible={deskEligible}
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

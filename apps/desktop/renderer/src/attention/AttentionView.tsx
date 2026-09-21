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
import type { CanvasNode, OpFn, PolledStatus, Pt } from '../canvas/shared'
import type { DeskChatProps } from '../canvas/desk'
import type { TypedRef } from '../canvas/workrefs'
import { PinFrame, unpinModal, useModalPin, usePersistedModalOpen } from '../canvas/modalpin'
import {
  restoredWindows, subscribeWindowLayout, useRestoreWindows, windowLayoutRevision,
} from '../windowlayout'
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
 * ⚠ AN UNOBSERVED RESTORE MUST NOT READ AS A CLOSE (multi-window-design,
 * 2026-09-21) — AND THE GAP IS ONE REACT COMMIT, NOT AN ASYNC INTERVAL. An
 * earlier draft of this said `MovableSurface` "opens the window and then waits
 * for its stylesheets, so there is a gap before the surface appears in the
 * registry". That is wrong, and reading `open()` rather than assuming is what
 * showed it: `open()` has NO await anywhere. It either reaches its commit point
 * and calls `registerWindow` synchronously, or it throws and its catch calls
 * `redock()` — which calls `closeSavedWindow` — synchronously. The stylesheet
 * wait (`restoreWhenStyled`) is installed AFTER registration, so a later
 * styling failure redocks a surface that is already registered and therefore
 * publishes a registry event like any other.
 *
 * So the only interval this claim has to cover is the one React imposes: the
 * panel must be COMMITTED before `MovableSurface`'s restore effect can run at
 * all. That is why the claim exists, and why one re-evaluation on the macrotask
 * after that commit is exactly right rather than an approximation of a wait.
 *
 *   restore landed   the surface is in `windowlife`'s registry → `detached`
 *                    holds the panel; this claim is no longer what keeps it
 *   restore pending  committed, effect not yet run → held HERE. It lasts one
 *                    commit, which is why neither harness can observe it.
 *   window closed    `closeSavedWindow` cleared the row → released
 *
 * THE INVARIANT THAT MAKES THOSE THREE EXHAUSTIVE is not "there are two
 * callers" — an earlier draft of this comment said that and it was wrong
 * (finding f2, v3-ux-review-opus, 2026-09-21). It is:
 *
 *     NO CALLER CAN CLEAR AN ATTENTION-KIND ROW EXCEPT THE SURFACE THAT OWNS IT
 *
 * which is a sentence a grep can be checked against, and `attentionaudit.test.tsx`
 * does check it. As it stands:
 *   · `closeSavedWindow` has THREE callers, not two. Two are inside
 *     `MovableSurface` — `redock`, where the surface was registered, and the
 *     surface's own unmount, which cannot precede this panel's. The third is
 *     OrgCanvas's restored-document reader, which closes rows drawn from
 *     `restoredWindows(slug).filter(r => r.kind !== 'doc' && r.restore?.document)`
 *     and so can only ever reach a row carrying `restore.document`. Neither
 *     attention kind ever carries one: this view passes no `restore` at all.
 *   · `saveWindow` is EXPORTED, so `open: false` could in principle be written
 *     without going through `closeSavedWindow`. Nothing outside windowlayout.ts
 *     calls it, so "the only writer" holds by convention, not by construction.
 *   · `captureWindow` takes `open` as a parameter and could pass `false`. All
 *     four of its call sites pass `true` explicitly.
 *
 * A new caller of any of the three is what would add a fourth state, and the
 * audit test is what will say so at the moment it is added rather than long
 * afterwards.
 *
 * ⚠ TWO STORES, BOTH WITH EVENTS — AND THE SECOND ONE HAD TO BE BUILT. The
 * window REGISTRY always published (`windowlife`), so a redock woke this view
 * at once. The saved LAYOUT did not: `saveWindow` was a plain localStorage
 * write that notified nobody, so a restore that FAILED never registered
 * anything, flipped the row, and left nothing to wake any reader. Measured in
 * real Chromium (`attention-probe.tsx` §5): the panel was not released by the
 * failure, was still mounted 1.5s later with no interaction, and went only when
 * something unrelated happened to re-render. An indefinite hold — and an
 * earlier draft of this comment called it harmless because "a render is never
 * far away", which multi-window-design correctly refused as a lifecycle
 * guarantee.
 *
 * `subscribeWindowLayout` / `windowLayoutRevision` (v3-shell-opus) is that
 * second event, and this reader consumes it. An interim one-shot re-evaluation
 * scheduled on a macrotask stood here until it existed; it is deleted, and the
 * probe reports the same result through the real event as it did through the
 * timer. A store that publishes is a property of the store, where a timer was
 * only ever a property of this consumer.
 *
 * ⚠ AN UNOBSERVED RESTORE MUST NOT READ AS A CLOSE (multi-window-design,
 * 2026-09-21) — AND THE GAP IS ONE REACT COMMIT, NOT AN ASYNC INTERVAL. An
 * earlier draft of this said `MovableSurface` "opens the window and then waits
 * for its stylesheets, so there is a gap before the surface appears in the
 * registry". That is wrong, and reading `open()` rather than assuming is what
 * showed it: `open()` has NO await anywhere. It either reaches its commit point
 * and calls `registerWindow` synchronously, or it throws and its catch calls
 * `redock()` — which calls `closeSavedWindow` — synchronously. The stylesheet
 * wait (`restoreWhenStyled`) is installed AFTER registration, so a later
 * styling failure redocks a surface that is already registered and therefore
 * publishes a registry event like any other.
 *
 * So the only interval this claim has to cover is the one React imposes: the
 * panel must be COMMITTED before `MovableSurface`'s restore effect can run at
 * all. That is why the claim exists, and why one re-evaluation on the macrotask
 * after that commit is exactly right rather than an approximation of a wait.
 *
 *   restore landed   the surface is in `windowlife`'s registry → `detached`
 *                    holds the panel; this claim is no longer what keeps it
 *   restore pending  committed, effect not yet run → held HERE. It lasts one
 *                    commit, which is why neither harness can observe it.
 *   window closed    `closeSavedWindow` cleared the row → released
 *
 * THE INVARIANT THAT MAKES THOSE THREE EXHAUSTIVE is not "there are two
 * callers" — an earlier draft of this comment said that and it was wrong
 * (finding f2, v3-ux-review-opus, 2026-09-21). It is:
 *
 *     NO CALLER CAN CLEAR AN ATTENTION-KIND ROW EXCEPT THE SURFACE THAT OWNS IT
 *
 * which is a sentence a grep can be checked against, and `attentionaudit.test.tsx`
 * does check it. As it stands:
 *   · `closeSavedWindow` has THREE callers, not two. Two are inside
 *     `MovableSurface` — `redock`, where the surface was registered, and the
 *     surface's own unmount, which cannot precede this panel's. The third is
 *     OrgCanvas's restored-document reader, which closes rows drawn from
 *     `restoredWindows(slug).filter(r => r.kind !== 'doc' && r.restore?.document)`
 *     and so can only ever reach a row carrying `restore.document`. Neither
 *     attention kind ever carries one: this view passes no `restore` at all.
 *   · `saveWindow` is EXPORTED, so `open: false` could in principle be written
 *     without going through `closeSavedWindow`. Nothing outside windowlayout.ts
 *     calls it, so "the only writer" holds by convention, not by construction.
 *   · `captureWindow` takes `open` as a parameter and could pass `false`. All
 *     four of its call sites pass `true` explicitly.
 *
 * A new caller of any of the three is what would add a fourth state, and the
 * audit test is what will say so at the moment it is added rather than long
 * afterwards.
 *
 * ⚠ THE TWO SIGNALS ARE NOT SYMMETRICAL, AND THE GAP IS REAL — MEASURED, in a
 * real renderer, not reasoned about. The window REGISTRY publishes events, so
 * anything that unregisters a surface — a redock above all — wakes this view at
 * once. The saved LAYOUT does not: `saveWindow` is a plain localStorage write
 * that notifies nobody. So a restore that FAILS never registers anything (the
 * window was blocked, so there is nothing to unregister), flips the row, and
 * leaves nothing at all to wake this view.
 *
 * `attention-probe.tsx` §5 measures exactly that, in Chromium, with the real
 * `MovableSurface`: after a blocked restore the panel is NOT released by the
 * failure, is STILL mounted 1.5s later with no interaction, and is released
 * only when something unrelated happens to re-render. An earlier draft of this
 * comment called that harmless because "in the running app a render is never
 * far away" — which multi-window-design correctly refused as a lifecycle
 * guarantee, and which the measurement then showed to be an indefinite hold.
 *
 * SO THE CLAIM IS BOUNDED HERE RATHER THAN ARGUED. `useRestoreRecheck` below
 * schedules ONE re-evaluation on the macrotask after a commit that holds a
 * restore claim. That is enough by construction and is not a poll: the failure
 * path is SYNCHRONOUS — `open()` throws, its catch calls `redock()`, and
 * `redock` calls `closeSavedWindow`, all inside the same effect flush as the
 * commit that mounted the panel — so the very next macrotask already sees the
 * flipped row. A restore still genuinely in flight leaves the row open, the
 * claim stands, no further timer is scheduled, and the registry's own event
 * carries the success case. The durable fix is a notification in
 * windowlayout.ts, which this feature does not own and has been requested from
 * the owner; until then this is the bound, and it is tested rather than stated.
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
function useAwaitingRestore(org: string | null, revision: number):
{ queue: boolean; desk: boolean } {
  const restoreAllowed = useRestoreWindows()
  const layout = useSyncExternalStore(
    subscribeWindowLayout, windowLayoutRevision, windowLayoutRevision)
  return useMemo(() => {
    if (!restoreAllowed) return { queue: false, desk: false }
    const rows = restoredWindows(org)
    return {
      queue: rows.some((r) => r.kind === QUEUE_KIND),
      desk: rows.some((r) => r.kind === DESK_KIND),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, restoreAllowed, layout, revision])
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
  /**
   * THE FRESHNESS OF `tree`, forwarded to the queue — question rows are read
   * out of the tree, which this view does not fetch, so the host that DOES
   * fetch it is the only thing that can report whether the last read
   * succeeded. See `AttentionQueueProps.treeStatus` for the full contract and
   * for what a current status does and does not claim.
   *
   * ⚠ NOT OPTIONAL IN THE DELIVERED PRODUCT (multi-window-design,
   * 2026-09-21). Absent, the queue correctly refuses to vouch for a third of
   * its own list — which is right while this is a stage and wrong as a
   * shipped experience, because a permanent hedge is a hedge nobody reads.
   * Final composition must supply the real tree-read status. There must be no
   * second tree poller and no copied tree state to produce it: it is the
   * status of the request the host already makes.
   */
  treeStatus?: PolledStatus
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

  /**
   * IS THIS REGISTRATION A HUMAN REQUEST, OR THIS VIEW MOUNTING?
   *
   * `'automatic'` says the second, and the registry's picker uses it to DEFER:
   * an automatic claim never takes the desk from a different slot that still
   * has a visible destination (v3-effort-opus host-slot interface rev 4). So a
   * Canvas pin the user placed keeps agent X, and this panel draws the
   * canonical open-elsewhere / Show desk controls — which is the user's ruling,
   * carried by one field instead of a policy of our own. A HIDDEN embedded
   * Canvas owner is not eligible, so the deferral does not apply to it and the
   * desk comes here, which is the other half of that ruling.
   *
   * ⚠ IT IS OMITTED, NOT FALSE, FOR A PINNED OR POPPED-OUT PANEL. Those are
   * windows the USER PLACED: their registrations are as much a human request as
   * a Canvas pin, and a panel the user dragged out must not defer to anything.
   * That is the one distinction the earlier `placed` field got backwards by
   * describing the destination instead of the claim — an eye panel is not a
   * window the user placed, and saying so would have made the field mean
   * something false.
   *
   * So: automatic exactly while this panel is the PRESENTED STAGE.
   */
  const deskClaim: 'automatic' | undefined =
    active && !deskPinned && !deskOut ? 'automatic' : undefined

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
              onOpenDoc={props.onOpenDoc} onOpenMail={props.onOpenMail}
              treeStatus={props.treeStatus} />
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
              eligible={deskEligible} claim={deskClaim}
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

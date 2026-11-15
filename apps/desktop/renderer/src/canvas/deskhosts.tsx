import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { MovableSurface, PopoutChip, useSurface } from '../popout'
import { openSurfaces, revealSurface, revealDetachedPanel } from '../windowlife'
import { instanceKind } from '../modalkinds'
import { savedDeskIdentities, useRestoreWindows, windowExitStarted } from '../windowlayout'
import { isMobile } from '../mobile'
import { OwnedDeskChat } from './desk'
import type { DeskChatProps } from './desk'
import type { CanvasNode } from './shared'
import { useNodeDetail } from '../nodedetail'

export function deskGeneration(node: Pick<CanvasNode, 'generation'>): number {
  if (typeof node.generation !== 'number' || !Number.isSafeInteger(node.generation) || node.generation < 0) {
    throw new Error('The agent generation is missing; a separate composer cannot be owned safely.')
  }
  return node.generation
}
export const deskIdentity = (slug: string, node: Pick<CanvasNode, 'id' | 'generation'>) =>
  JSON.stringify([slug, node.id, deskGeneration(node)])

/** Raise an already detached desk instead of moving to its canvas placeholder.
 * Every generic focus route (cards, the Agents list, and links) funnels here. */
export function revealExistingDesk(slug: string,
  node: Pick<CanvasNode, 'id' | 'generation'> & Partial<Pick<CanvasNode, 'kind'>> | undefined): boolean {
  // one project desk window per project (docket several-instances-of-the-same-modal-team-slots-i)
  if (node?.kind === 'project') return revealDetachedPanel(instanceKind('project-desk', node.id), slug, { agent: node.id })
  if (!node || typeof node.generation !== 'number'
    || !Number.isSafeInteger(node.generation) || node.generation < 0) return false
  const surface = openSurfaces().find((s) => s.kind === `desk:${deskIdentity(slug, node)}`)
  return surface ? revealSurface(surface) : false
}
/** Whether this agent's desk is already open in a window of its own — the
 *  same lookup as `revealExistingDesk`, without revealing anything. Attract
 *  mode skips such desks (USER 2026-11-02 m79cb0cf57f61 "it does not focus
 *  any agent desks that are already pinned or open elsewhere"). */
export function deskOpenElsewhere(slug: string,
  node: Pick<CanvasNode, 'id' | 'generation'> | undefined): boolean {
  if (!node || typeof node.generation !== 'number'
    || !Number.isSafeInteger(node.generation) || node.generation < 0) return false
  return openSurfaces().some((s) => s.kind === `desk:${deskIdentity(slug, node)}`)
}
/**
 * EVERY PLACE A DESK IS OPEN SHOWS IT, LIVE, AT ONCE (USER 2026-11-15 10:34:16Z mbf1f1ca2cfe9, 4.6.1: "you should
 * no longer see \"xyz's desk is open elsewhere (bring it here)\" etc. it should always show in both locations at
 * once; on the canvas, in a pinned / popped out desk, in the attention desk, etc."; design-461-desk-views.md).
 *
 * This file used to keep exactly ONE live `OwnedDeskChat` per desk identity and move it between the places that
 * asked for it, drawing an "open elsewhere" notice everywhere else. The single owner existed for the composer;
 * the conversation was already one store per node (convo.ts), and the unsent draft is now one shared value per
 * desk identity too (draftstore.ts). So each place renders its own live desk, and what is left here is:
 *
 *   - THE LIST OF OPEN VIEWS per desk identity: which places show it, whether each is on screen, and which was
 *     used last. Readers: question notifications (`claimQuestionDesk`), attract mode (`deskShownAnywhere`).
 *   - THE DESK WINDOWS: a popped-out desk is a view of its own, in a native window held here (`PopoutDesk`), so
 *     the place it was popped out from keeps its desk.
 *
 * ⚠ VIEWS DO NOT SUBSCRIBE TO THE REGISTRY. The old registry bumped a version on every slot prop update and every
 * slot re-rendered on it, so one parent render re-rendered every desk on screen (@desk-freeze-opus, 2026-11-15).
 * A view registers in a layout effect and draws nothing from here; only readers that DRAW registry state
 * subscribe, each to its own scalar.
 */
type Box = { x: number; y: number; w: number; h: number }
/** a desk window: the props of the place it was popped out from, that place's frame (where a fresh window first
 *  opens), and what to do once it really is open (close a temporary place) */
interface Win { props: DeskChatProps | null; box: Box | null; fresh: boolean; onOpened?: () => void }
interface View {
  id: object
  props: DeskChatProps
  /** when this view was last pressed or focused: the "most recently used" place */
  usedAt: number
  /** this view is the desk in a desk window */
  inWindow: boolean
}

/** where a question's desktop notification found the asker's open desk */
export type QuestionDeskPlace = 'popout' | 'floating' | 'pin' | 'attention' | 'card'

/** this view's place, as the question notification names it (a `borrow` view is the floating desk modal) */
const placeOf = (v: View): QuestionDeskPlace | undefined => v.props.borrow ? 'floating' : v.props.openIn
/** on screen and reachable right now (a canvas card behind the presented Attention stage is not) */
const eligible = (v: View) => v.props.eligible !== false

class Desks {
  views = new Map<string, Map<object, View>>()
  /** desk identities open as a native window of their own: the props of the place it was popped out from (the
   *  canvas's own `popoutDesk` props win when there are any) and that place's frame, where the window first opens */
  windows = new Map<string, Win>()
  listeners = new Set<() => void>()
  clock = 0
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  change = () => { for (const fn of [...this.listeners]) fn() }
  put(key: string, id: object, props: DeskChatProps, inWindow = false) {
    let m = this.views.get(key)
    if (!m) this.views.set(key, m = new Map())
    const prev = m.get(id)
    m.set(id, { id, props, usedAt: prev?.usedAt ?? ++this.clock, inWindow })
    // a prop update is not news to anyone; a new view, or one coming on or off screen, is
    if (!prev || eligible(prev) !== (props.eligible !== false)) this.change()
  }
  /** a place in the main window shows this desk (its window aside) */
  shownInMain(key: string): boolean {
    return [...(this.views.get(key)?.values() ?? [])].some((v) => !v.inWindow && eligible(v))
  }
  remove(key: string, id: object) {
    const m = this.views.get(key)
    if (!m?.delete(id)) return
    if (!m.size) this.views.delete(key)
    this.change()
  }
  touch(key: string, id: object) {
    const v = this.views.get(key)?.get(id)
    if (v) v.usedAt = ++this.clock
  }
  /** open this desk in a window of its own, or raise the one already open */
  popout(key: string, props: DeskChatProps | null, box: Box | null = null, onOpened?: () => void, fresh = true) {
    const open = deskSurface(key)
    if (open) { revealSurface(open); onOpened?.(); return }
    // an entry with no live window (one waiting for a restore that has not come) is replaced, so this request opens it
    this.windows.delete(key)
    this.windows.set(key, { props, box, fresh, onOpened })
    this.change()
  }
  closeWindow(key: string) {
    if (this.windows.delete(key)) this.change()
  }
}

/** the live native window showing THIS desk. Keyed `desk:<identity>`, the shape `detachedKind` and
 *  `savedDeskIdentities` match on. */
const deskSurface = (key: string) => openSurfaces().find((s) => s.kind === `desk:${key}`)

const DeskContext = createContext<Desks | null>(null)
const DeskMapReady = createContext(true)

/** EACH ORGANIZATION'S ONE REGISTRY, for a caller outside `DeskHosts` that has to decide during a click: a
 *  question's desktop notification chooses between the asker's open desk and the inbox in one handler (App.tsx).
 *  Present while that organization's `DeskHosts` is mounted. */
const orgDesks = new Map<string, Desks>()

/**
 * THE ASKER'S DESK IS ALREADY OPEN: SAY WHERE.
 *
 * USER 2026-10-27 13:25:36Z m007c48d12f28: "also if the asking agent's desk of a question is pinned anywhre, open
 * either as a floating panel, a desk pin, or open in the attention agent desk, then dont open the question in the
 * inbox when clicking a desktop notification for it"; 19:00Z m41e0735bee13: "a desk on a zoomed canvas card should
 * count"; 19:10Z m1a947c081d09: the switchboard's panels count too ("Count the switchboard").
 *
 * OPEN IN MORE THAN ONE PLACE, THE MOST RECENTLY USED ONE WINS (design-461 question 3, provisional default): the
 * one last pressed or focused. A desk window counts as used when it is open. With no use recorded, the old order
 * stands: a desk pin, else the Attention desk, else the card. Every place shows the live desk now, so nothing moves.
 *
 * Returns null when no such place is open, and the caller keeps its old path. `within` is the place's element, where
 * the question card is. Bringing the window or panel forward is the caller's job.
 */
export function claimQuestionDesk(slug: string, node: Pick<CanvasNode, 'id' | 'generation'>):
  { place: QuestionDeskPlace; within: HTMLElement | null } | null {
  if (typeof node.generation !== 'number' || !Number.isSafeInteger(node.generation) || node.generation < 0) return null
  const key = deskIdentity(slug, node)
  const open = [...(orgDesks.get(slug)?.views.get(key)?.values() ?? [])].filter((v) => placeOf(v) && eligible(v))
  const floating = open.find((v) => placeOf(v) === 'floating')
  if (floating) return { place: 'floating', within: anchorOf(floating) }
  if (deskSurface(key)) return { place: 'popout', within: null }
  const order: QuestionDeskPlace[] = ['pin', 'attention', 'card']
  const chosen = [...open].sort((a, b) => b.usedAt - a.usedAt
    || order.indexOf(placeOf(a)!) - order.indexOf(placeOf(b)!))[0]
  return chosen ? { place: placeOf(chosen)!, within: anchorOf(chosen) } : null
}
const anchors = new WeakMap<object, HTMLElement>()
const anchorOf = (v: View) => anchors.get(v.id) ?? null

/** Is this agent's desk visible ANYWHERE right now, read from the registry the views themselves use? A desk window,
 *  the floating modal, a pin, the Attention agent desk, a zoomed canvas card or a switchboard panel: any view that is
 *  open and on screen. Attract mode skips such an agent entirely (USER 2026-11-04 m1869e398fdea). */
export function deskShownAnywhere(slug: string, node: Pick<CanvasNode, 'id' | 'generation'> | undefined): boolean {
  if (!node || typeof node.generation !== 'number' || !Number.isSafeInteger(node.generation) || node.generation < 0) return false
  const key = deskIdentity(slug, node)
  if (deskSurface(key)) return true
  return [...(orgDesks.get(slug)?.views.get(key)?.values() ?? [])].some((v) => (v.props.openIn || v.props.borrow) && eligible(v))
}

export function DeskHosts({ children, map, slug, treeSlug = slug, popoutDesk }: {
  children: ReactNode; map: Map<string, CanvasNode>; slug: string; treeSlug?: string
  /** the props a desk WINDOW renders with (the canvas's own routes). A desk saved open as a window at the last
   *  session comes back with these, and so does one popped out from a place that has no props of its own. */
  popoutDesk?: (node: CanvasNode) => DeskChatProps
}) {
  const [desks] = useState(() => new Desks())
  useLayoutEffect(() => {
    orgDesks.set(slug, desks)
    return () => { if (orgDesks.get(slug) === desks) orgDesks.delete(slug) }
  }, [desks, slug])
  // the desk windows the last session left open come back as windows (MovableSurface reopens each at its saved
  // place), once this organization's tree is the one shown AND windows may be restored: not before, or the entry
  // would wait in its hidden holder with no window
  const restored = useRef(false)
  const restoreAllowed = useRestoreWindows()
  useEffect(() => {
    if (restored.current || !popoutDesk || treeSlug !== slug || !restoreAllowed) return
    restored.current = true
    for (const [org, id, generation] of savedDeskIdentities(slug)) {
      const node = map.get(id)
      // not fresh: MovableSurface reopens it from its saved row, at its saved place
      if (org === slug && node?.generation === generation) desks.popout(deskIdentity(slug, node), popoutDesk(node), null, undefined, false)
    }
  }, [desks, map, slug, treeSlug, popoutDesk, restoreAllowed])
  // a window whose agent is gone or has a new generation closes with it
  useEffect(() => {
    if (treeSlug !== slug) return
    for (const key of [...desks.windows.keys()]) {
      const [, id, generation] = JSON.parse(key) as [string, string, number]
      if (map.get(id)?.generation !== generation) desks.closeWindow(key)
    }
  }, [desks, map, slug, treeSlug])
  return <DeskMapReady.Provider value={treeSlug === slug}><DeskContext.Provider value={desks}>{children}
    <DeskWindows desks={desks} map={map} slug={slug} propsFor={popoutDesk} /></DeskContext.Provider></DeskMapReady.Provider>
}

function DeskWindows({ desks, map, slug, propsFor }: {
  desks: Desks; map: Map<string, CanvasNode>; slug: string; propsFor?: (node: CanvasNode) => DeskChatProps
}) {
  useSyncExternalStore(desks.subscribe, () => desks.windows.size)
  return <>{[...desks.windows].map(([key, win]) => {
    const { props, box } = win
    const [org, id, generation] = JSON.parse(key) as [string, string, number]
    const node = map.get(id)
    const base = node && (propsFor?.(node) ?? props)
    if (org !== slug || node?.generation !== generation || !base) return null
    return <PopoutDesk key={key} desks={desks} winKey={key} win={win} box={box} props={{ ...base, node, map, eligible: true,
      claim: undefined, borrow: undefined, openIn: undefined, temporaryPlacement: undefined, onPoppedOut: undefined }} />
  })}</>
}

/**
 * A DESK IN A NATIVE WINDOW OF ITS OWN: one more view, in its own `MovableSurface`, docked in a hidden holder
 * while it is not a window. A FRESH one (the user popped it out) opens at once over the frame it was popped out
 * from; one the last session left open is reopened by MovableSurface itself, from its saved row. Closing the
 * window, or its Return, ends this view; the places in the main window kept their own desks all along.
 */
function PopoutDesk({ desks, winKey, win, props, box }: {
  desks: Desks; winKey: string; win: Win; props: DeskChatProps; box: Box | null
}) {
  const [dock, setDock] = useState<HTMLElement | null>(null)
  return <div hidden ref={setDock}>
    {dock && <MovableSurface kind={`desk:${winKey}`} title={`${props.node.id} · desk`} org={props.slug} anchor={dock}
      sourceBox={() => box} exactSourceBox
      // the window's own Close ends this view, saving where the window was; at the app's exit it stays open, so the
      // next start reopens it (MovableSurface `dismissWindow`)
      onDismiss={() => desks.closeWindow(winKey)}
      onDetached={(v, reason) => {
        if (v) { const done = win.onOpened; win.onOpened = undefined; done?.() }
        else if (!windowExitStarted()) {
          // Return to main window with no place there showing this desk: go to the agent, as the return always did
          if (reason !== 'close' && !desks.shownInMain(winKey)) props.onJump?.(props.node.id)
          desks.closeWindow(winKey)
        }
      }}>
      <PopoutDeskBody desks={desks} winKey={winKey} win={win} props={props} />
    </MovableSurface>}
  </div>
}
function PopoutDeskBody({ desks, winKey, win, props }: { desks: Desks; winKey: string; win: Win; props: DeskChatProps }) {
  const surface = useSurface()
  useLayoutEffect(() => {
    if (!win.fresh || !surface || surface.detached) return
    win.fresh = false
    surface.open()
  }, [win, surface])
  // a window that could not open (blocked, or it failed): say why, and the place it was popped out from stays
  useEffect(() => {
    if (!surface?.error) return
    props.toast([surface.error])
    desks.closeWindow(winKey)
  }, [desks, winKey, props, surface?.error])
  return <DeskView desks={desks} deskKey={winKey} props={props} window />
}

/** A desk's own pop-out control: this place's desk opens in a window of its own, or the window this desk is in
 *  closes. Read by the desk header's pop-out button (desk.tsx) in place of the nearest surface's, which for a desk
 *  inside a pin or a popped-out panel would pop out the pin or the panel. */
export interface DeskViewControl {
  /** this desk is the one in a desk window */
  inWindow: boolean
  /** the kind of place it is shown in, which its scroll is remembered under while the place is off screen
   *  (deskscroll.ts): card, pin, attention, window, floating, or place for one with no name */
  place: string
  popout: () => void
  closeWindow: () => void
}
export const DeskViewContext = createContext<DeskViewControl | null>(null)

/**
 * A notice standing where a desk would be, before the organization's tree has loaded.
 *
 * On a CANVAS CARD the desk is counter-scaled into the card's 120px interior (`.desk-inner`), so a notice that
 * replaces it has to be too (user report 2026-09-11). `bare` is the same flag that decides whether the real desk
 * renders counter-scaled or at 1:1, so the notice follows whatever its desk would have done.
 */
function InDesksPlace({ bare, children }: { bare?: boolean; children: ReactNode }) {
  if (bare) return <PopoutChip>{children}</PopoutChip>
  return <div className="desk-elsewhere-holder">
    <PopoutChip className="desk-elsewhere">{children}</PopoutChip>
  </div>
}

export function DeskSlot(outer: DeskChatProps) {
  const desks = useContext(DeskContext)
  const mapReady = useContext(DeskMapReady)
  // §4.8: an archived seat arrives summarised, and the desk reads its full charter and turn history. Resolved HERE
  // because this is the one door every desk goes through. It does NOT gate: the desk renders from the summary and
  // upgrades when detail lands, so opening a retired agent never waits on a spinner.
  const { node } = useNodeDetail(outer.slug, outer.node)
  const props = node === outer.node ? outer : { ...outer, node }
  if (!mapReady) return <InDesksPlace bare={props.bare}>Loading organization...</InDesksPlace>
  if (!desks || isMobile || typeof props.node.generation !== 'number'
    || !Number.isSafeInteger(props.node.generation) || props.node.generation < 0) return <OwnedDeskChat {...props} />
  return <DeskView desks={desks} deskKey={deskIdentity(props.slug, props.node)} props={props} />
}

/**
 * ONE PLACE'S LIVE DESK. It registers itself (for the readers above) and renders its own `OwnedDeskChat` while its
 * place is on screen. Off screen it renders nothing at all and mounts when it comes back: a desk nobody can see is
 * never mounted (design-461; the mount-cost budget agreed with @desk-freeze-opus).
 */
function DeskView({ desks, deskKey, props, window: inWindow = false }: {
  desks: Desks; deskKey: string; props: DeskChatProps; window?: boolean
}) {
  const id = useRef({}).current
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (anchor.current) anchors.set(id, anchor.current)
    desks.put(deskKey, id, props, inWindow)
  }, [desks, deskKey, id, props, inWindow])
  useLayoutEffect(() => () => desks.remove(deskKey, id), [desks, deskKey, id])
  const control = useRef<DeskViewControl>({ inWindow, place: 'place', popout: () => {}, closeWindow: () => {} })
  control.current.inWindow = inWindow
  control.current.place = inWindow ? 'window' : props.borrow ? 'floating' : props.openIn ?? 'place'
  control.current.popout = () => {
    // the window first opens over the frame this place shows the desk in, a pin's title bar included
    const frame = anchor.current?.closest('.pinwin') ?? anchor.current?.querySelector('.desk-body')
    const rect = frame?.getBoundingClientRect()
    // the place it was popped out from may go with it once the window is open (a pin, the floating modal:
    // design-461 question 2); a blocked window leaves it where it is
    desks.popout(deskKey, props, props.temporaryPlacement?.sourceBox()
      ?? (rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null),
      () => { props.temporaryPlacement?.onPopout(); props.onPoppedOut?.() })
  }
  control.current.closeWindow = () => {
    // Return to main window with no place there showing this desk: go to the agent, as the return always did
    if (!desks.shownInMain(deskKey)) props.onJump?.(props.node.id)
    desks.closeWindow(deskKey)
  }
  const used = () => desks.touch(deskKey, id)
  return <div className="desk-slot" ref={anchor} data-desk-slot={deskKey}
    onPointerDownCapture={used} onFocusCapture={used}>
    {props.eligible !== false && <DeskViewContext.Provider value={control.current}>
      <OwnedDeskChat {...props} />
    </DeskViewContext.Provider>}
  </div>
}

export interface DeskActions {
  /** this seat can own a desk at all (a generation is what identifies one) */
  valid: boolean
  /** its desk is open somewhere right now */
  present: boolean
  /** its desk is open in a window of its own */
  detached: boolean
  /** raise that window */
  show?: () => void
  /** open it in a window of its own, first over `box` when given (the frame it is shown in); `onOpened` runs once
   *  the window really is open */
  requestPopout: (box?: Box | null, onOpened?: () => void) => void
}

function deskActionsOf(desks: Desks | null, mapReady: boolean, slug: string,
  node: Pick<CanvasNode, 'id' | 'generation'>): DeskActions {
  const valid = typeof node.generation === 'number'
    && Number.isSafeInteger(node.generation) && node.generation >= 0
  const key = valid ? deskIdentity(slug, node) : null
  const views = mapReady && desks && key ? desks.views.get(key) : undefined
  const surface = key ? deskSurface(key) : undefined
  return {
    valid,
    present: !!views?.size || !!surface,
    detached: !!surface,
    show: surface ? () => { revealSurface(surface) } : undefined,
    // the list may ask before any place shows this desk (its card is outside the viewport): the window renders with
    // the canvas's own props (`popoutDesk`), else those of a place that shows it
    requestPopout: (box, onOpened) => {
      if (!key || !desks) return
      desks.popout(key, views?.values().next().value?.props ?? null, box ?? null, onOpened)
    },
  }
}

/** An agent's desk-window actions, read at the moment they are needed — a context menu builds its entries when the
 *  menu OPENS, not on every render.
 *
 *  ⚠ IT DELIBERATELY DOES NOT SUBSCRIBE, which is what lets every agent card on the canvas and every row of the
 *  Agents List hold one. The returned reader walks the live registry when it is called. */
export function useDeskActionsNow(slug: string):
(node: Pick<CanvasNode, 'id' | 'generation'>) => DeskActions {
  const desks = useContext(DeskContext)
  const mapReady = useContext(DeskMapReady)
  return (node) => deskActionsOf(desks, mapReady, slug, node)
}

/** The card is laid out as the focused desk (desk-sized, head hidden) while its desk is open, popped out or not:
 *  every place shows the desk now, the card included (4.6.1). Before, a card whose desk was in another window went
 *  back to its normal face (@item:orgtree/x-is-in-another-window-placeholder-covers-parts-o). */
export const cardIsDeskLayout = (deskOpen: boolean, pinnedFocus: boolean): boolean => deskOpen || pinnedFocus

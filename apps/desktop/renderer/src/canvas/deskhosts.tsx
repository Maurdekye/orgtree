import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { MovableSurface, useSurface } from '../popout'
import { openSurfaces } from '../windowlife'
import type { BorrowedSurface } from '../windowlife'
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
interface Slot { id: object; anchor: HTMLElement; props: DeskChatProps }
interface Entry {
  key: string; invalidated?: boolean; pendingRename?: boolean; slots: Map<object, Slot>; last: Slot; detached: boolean
  show?: () => void; redock?: (slot?: object) => void; popout?: () => void; pendingPopout?: boolean
  /** the borrowing slot's id, while a temporary surface holds this desk */
  borrowedBy?: object
  /** WHERE THE DESK WAS WHEN THE BORROW BEGAN. Read ONCE, on the transition
   *  into the borrow — never re-read, or a borrower records itself. */
  borrowedFrom?: { id: object; detached: boolean }
  /** the two ways a borrowed NATIVE window can end — `restore` puts it back
   *  exactly where it was, `release` gives it up. Absent unless the desk was
   *  detached when the borrow began. */
  borrowedHandle?: BorrowedSurface
  /** THE OWNER AS OF THE END OF THE PREVIOUS COMMIT — see `settle`. */
  settled?: object
}

/** is this slot's destination on screen and reachable right now?
 *
 *  ⚠ NOT "is this the selected org view". It is a fact about ONE destination:
 *  a pinned window is eligible whatever view the org is in, because it is
 *  screen-space and survives the switch, while a canvas card behind a
 *  presented Attention stage is not. Absent means eligible, so every existing
 *  call site is unaffected. */
const eligible = (slot: Slot) => slot.props.eligible !== false

/** is this registration a VIEW MOUNTING rather than the user asking for this
 *  desk here?
 *
 *  ⚠ THIS FIELD EXISTS BECAUSE ITS PREDECESSOR LIED. The first design carried
 *  `placed` on the DESTINATION — "the user put the desk here" — and protected
 *  any placed owner from any other claim. That rewrote pin ownership in
 *  general, and the user ruled only on the Attention view: it would have
 *  changed today's behaviour for an agent that is pinned AND open in an eye
 *  panel, where the panel currently takes the desk. The offered patch was to
 *  label the eye panel `placed` too, and multi-window-design refused it on the
 *  grounds that an eye panel is not a placed window and the field would then
 *  mean something false (2026-09-21). So the deciding fact moved to where it
 *  actually lives: the CLAIM. Only the Attention stage sets this, and only
 *  while it is the presented stage — pinned or popped out, the user placed it,
 *  so it claims like anything else. */
const automatic = (slot: Slot) => slot.props.claim === 'automatic'

/** the live native window showing THIS desk, if it is popped out. Keyed the
 *  way `DeskHost` opens it — `desk:<identity>` — which is the same shape
 *  `detachedKind` already matches on. */
const deskSurface = (key: string) =>
  openSurfaces().find((s) => s.kind === `desk:${key}`)

/**
 * WHICH SLOT OWNS THE ONE LIVE DESK — the single answer both assignment points
 * now go through.
 *
 * ⚠ THERE WERE TWO OF THEM, AND ONLY ONE WAS EVER REPORTED. `put` promoting
 * every registration was the known half; `DeskHost`'s per-render re-point
 * (below) was the other, and it re-pointed ownership at
 * `[...entry.slots.values()][0]` — the first slot in Map INSERTION ORDER —
 * whenever the owning slot's id was gone. So a fix to `put` alone left
 * ownership landing by registration accident the moment a slot unregistered.
 * Both call this.
 *
 * ⚠ AND `put` FIRES ON EVERY PROP UPDATE, not just on registration
 * (RegisteredSlot's useLayoutEffect depends on `props`). So the live rule this
 * has to preserve is "the last writer wins, on every update", NOT "the first
 * registration wins". An earlier draft of this function preferred the incumbent
 * globally and would have silently changed behaviour for every caller that
 * passes none of the new fields.
 *
 * WHAT IS UNCHANGED FOR EXISTING CALLERS, by construction rather than by
 * argument: steps 2 and 5's eligibility branches are unreachable while nothing
 * passes `eligible={false}` or `claim`, and step 6 is unreachable while 3 or 4
 * can fire. So an all-default registry runs 1 → 3 → 4 → 5 and lands exactly
 * where the previous code did:
 *
 *   put, attached, any registration or prop update  →  3, the incoming slot
 *   put, detached, some other slot                  →  1, no change
 *   put, detached, the owning slot again            →  1's exception, itself
 *   DeskHost, owner still registered                →  4, the owner
 *   DeskHost, owner gone                            →  5, first in order
 */
function pick(e: Entry, incoming?: Slot): Slot {
  // 0. BORROWED. A temporary surface holds the desk for as long as it is
  //    mounted, whatever else registers or re-renders behind it.
  //
  //    ⚠ AHEAD OF THE DETACHED GUARD, DELIBERATELY. That guard exists to stop
  //    an ordinary registration stealing a desk out of a native window by
  //    accident. A borrow is not an accident: it has already REDOCKED that
  //    window through `borrow()` (see `put`), so there is no window left to
  //    protect, and the user ruled that the temporary modal may borrow a
  //    popped-out desk and must give it back to the same placement.
  if (e.borrowedBy) {
    const held = e.slots.get(e.borrowedBy)
    if (held) return held
  }
  // 1. DETACHED. While the desk is a native window ownership does not move at
  //    all, and the one exception is the owning slot re-registering as itself —
  //    which is the previous code's `e.last.id === slot.id` term, verbatim.
  //    Eligibility deliberately plays no part here: a detached desk's
  //    Show/Return placeholder is the behaviour the ruling says to preserve.
  if (e.detached) return incoming && e.last.id === incoming.id ? incoming : e.last
  const cur = e.slots.get(e.last.id)
  // 2. AN AUTOMATIC CLAIM DEFERS TO A VISIBLE OWNER. This is the whole of the
  //    Attention rule: a view mounting or re-rendering does not take a desk
  //    away from a destination the user can currently see. It falls through
  //    when the incumbent is NOT eligible, which is the other half — a hidden
  //    embedded owner relinquishes rather than holding the desk somewhere
  //    nobody can look at.
  if (incoming && automatic(incoming) && cur && cur.id !== incoming.id && eligible(cur)) return cur
  // 3. the incoming slot — the previous code's unconditional promotion
  if (incoming && eligible(incoming)) return incoming
  // 4. the incumbent — the previous code's `slots.get(entry.last.id)`
  if (cur && eligible(cur)) return cur
  // 5. the first ELIGIBLE slot in registration order, where the previous code
  //    took the first slot in registration order
  for (const s of e.slots.values()) if (eligible(s)) return s
  // 6. NEVER HOMELESS. Eligibility reorders preference; it must not leave a
  //    desk with no host, so an all-ineligible registry still gets an owner.
  return cur ?? incoming ?? [...e.slots.values()][0] ?? e.last
}
class Desks {
  entries = new Map<string, Entry>()
  pendingPopouts = new Set<string>()
  version = 0
  nextKey = 0
  renamedAway = new Map<string, string>()
  listeners = new Set<() => void>()
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  snapshot = () => this.version
  change = () => {
    this.version++
    for (const fn of [...this.listeners]) fn()
    this.settle()
  }
  settling = false
  /**
   * REMEMBER WHO OWNED EACH DESK AT THE END OF THE LAST COMMIT.
   *
   * ⚠ WITHOUT THIS, A BORROW RECORDS THE WRONG DESTINATION. Registration
   * re-runs for EVERY slot whenever its parent re-renders — `RegisteredSlot`'s
   * effect depends on `props`, which is a fresh object each render — so the
   * slots of one commit re-register in tree order and `last` moves several
   * times before the commit is over. The modal opening IS such a commit, so
   * `e.last` at the moment the borrowing slot registers is merely whichever
   * sibling registered just before it, not the desk's actual pre-open owner.
   * Reading a value snapshotted in a microtask AFTER the previous commit is
   * what makes "put it back where it was" mean the place the user was actually
   * looking at.
   */
  settle() {
    if (this.settling) return
    this.settling = true
    queueMicrotask(() => {
      this.settling = false
      for (const e of this.entries.values()) if (!e.borrowedBy) e.settled = e.last.id
    })
  }
  requestPopout(key: string) {
    const entry = this.entries.get(key)
    if (entry?.popout) { entry.popout(); return }
    if (entry) entry.pendingPopout = true
    else this.pendingPopouts.add(key)
  }
  put(key: string, slot: Slot) {
    if (this.renamedAway.has(key)) {
      this.pendingPopouts.delete(key)
      return
    }
    let e = this.entries.get(key)
    if (!e) {
      e = { key: `host-${++this.nextKey}`, slots: new Map(), last: slot, detached: false }
      if (this.pendingPopouts.delete(key)) e.pendingPopout = true
      this.entries.set(key, e)
    }
    e.slots.set(slot.id, slot)
    // ⚠ CAPTURED ON THE TRANSITION IN, AND NOWHERE ELSE. This runs again on
    // every prop change — RegisteredSlot's registration effect depends on
    // `props` — so an unguarded capture would record the borrower as its OWN
    // previous owner on its second render, and the restore would silently
    // become a no-op. Read before `pick` moves `last`, because `last` is the
    // thing being saved.
    if (slot.props.borrow && e.borrowedBy !== slot.id) {
      e.borrowedBy = slot.id
      // ⚠ `settled`, NOT `e.last` — see `settle()`. `e.last` mid-commit is
      // whichever sibling re-registered just before this one, because opening
      // the modal re-renders the whole subtree and every slot re-registers in
      // tree order. `settled` is the owner as of the end of the last commit,
      // which is the destination the user was actually looking at.
      e.borrowedFrom = { id: e.settled ?? e.last.id, detached: e.detached }
      // A DETACHED DESK IS BORROWED BY REDOCKING IT, and `borrow()` is the only
      // call that does so without recording the window as closed — an ordinary
      // `redock` clears the saved row, which both loses the arrangement on
      // reopen and makes the return land at a freshly computed position rather
      // than the one it left. The handle is held here, for exactly as long as
      // the borrowing slot is mounted, and ended once in `endBorrow`.
      if (e.detached) e.borrowedHandle = deskSurface(key)?.borrow?.()
    }
    e.last = pick(e, slot)
    this.change()
  }

  /**
   * THE BORROW ENDS WHEN ITS SLOT UNREGISTERS — a dismissal, an unmount, a
   * route change and an error teardown all arrive here, because `remove` is a
   * layout-effect cleanup.
   *
   * ⚠ THE NATIVE WINDOW AND THE OWNERSHIP ARE TWO DIFFERENT QUESTIONS, and
   * fusing them leaks state. The window is ALWAYS returned: `borrow()` left the
   * saved row `open: true` with its rect and nothing behind it, so declining to
   * call the closure — because the destination happens to be gone — strands
   * exactly the row the seam exists to protect. Ownership, by contrast, only
   * goes back to a destination that is still real: still registered, and not
   * invalidated by a generation change. A removed destination is not
   * resurrected; `pick` then finds the desk a home by the ordinary rules.
   */
  endBorrow(e: Entry) {
    const from = e.borrowedFrom
    const handle = e.borrowedHandle
    e.borrowedBy = undefined
    e.borrowedFrom = undefined
    e.borrowedHandle = undefined
    // ⚠ RESTORE ONLY FOR A VALID PRIOR DESTINATION *AND* IDENTITY, NEVER BOTH
    // OUTCOMES (multi-window-design, 2026-09-21). `invalidated` is set when the
    // tree no longer has this generation, and `pendingRename` while an identity
    // move is still mid-flight — putting a window back onto either is putting it
    // onto an agent that is not there any more. The restore branch returns, so
    // exactly one of the two is ever used.
    if (from && !e.invalidated && !e.pendingRename) {
      const target = e.slots.get(from.id)
      if (target) {
        e.last = target
        // it came from a native window, so it goes back to one — at the
        // geometry it actually had, which `borrow()` captured before closing
        handle?.restore()
        return
      }
    }
    // NOTHING VALID TO GO BACK TO. The window must still be given up rather
    // than simply dropped: `borrow()` left the saved row `open: true` with its
    // rect and nothing behind it, so a borrow that merely stops makes startup
    // restoration reopen a window nobody left open — and restoring it here
    // would resurrect a window with nowhere valid to be.
    handle?.release()
  }
  remove(key: string, id: object) {
    const e = [...this.entries.values()].find((entry) => entry.slots.has(id))
    if (!e) return
    e.slots.delete(id)
    if (e.borrowedBy === id) this.endBorrow(e)
    // Slot migration can unregister/register in a single React commit. Give
    // that commit a chance to finish before releasing its stable host.
    queueMicrotask(() => {
      if (!e.slots.size && !e.detached) {
        for (const [k, entry] of this.entries) if (entry === e) this.entries.delete(k)
      }
      this.change()
    })
  }
}
const DeskContext = createContext<Desks | null>(null)
const DeskMapReady = createContext(true)

export function DeskHosts({ children, map, slug, treeSlug = slug }: {
  children: ReactNode; map: Map<string, CanvasNode>; slug: string; treeSlug?: string
}) {
  const [desks] = useState(() => new Desks())
  useEffect(() => {
    const rename = (event: Event) => {
      const d = (event as CustomEvent<{ slug: string; from: string; to: string }>).detail
      if (!d || d.slug !== slug) return
      for (const [key, entry] of [...desks.entries]) {
        if (entry.invalidated || entry.last.props.slug !== slug || entry.last.props.node.id !== d.from) continue
        const move = (slot: Slot): Slot => ({ ...slot, props: { ...slot.props, node: { ...slot.props.node, id: d.to } } })
        const next = move(entry.last)
        const target = deskIdentity(slug, next.props.node)
        const destination = desks.entries.get(target)
        if (destination?.detached) continue
        // A full payload can create its new presentation slot before the
        // parent's validated rename notification. Retain the original host
        // and adopt only that new slot; never revive an invalidated host.
        if (destination) {
          for (const [id, slot] of destination.slots) entry.slots.set(id, slot)
          desks.entries.delete(target)
        }
        entry.pendingRename = true
        entry.last = next
        entry.slots = new Map([...entry.slots].map(([id, slot]) => [id, move(slot)]))
        desks.renamedAway.set(key, d.from)
        desks.entries.delete(key); desks.entries.set(target, entry)
      }
      desks.change()
    }
    window.addEventListener('orgtree:desk-rename', rename)
    return () => window.removeEventListener('orgtree:desk-rename', rename)
  }, [desks, slug])
  useEffect(() => {
    if (treeSlug !== slug) return
    // Parent passive effects reconcile payload-only same-session renames.
    // Validate this accepted snapshot after those effects, without clearing
    // an earlier deletion or generation invalidation.
    queueMicrotask(() => {
      let changed = false
      for (const [key, entry] of [...desks.entries]) {
        if (entry.last.props.slug !== slug) continue
        const current = map.get(entry.last.props.node.id)
        if (entry.pendingRename && current?.generation === entry.last.props.node.generation) entry.pendingRename = false
        if (entry.invalidated || entry.pendingRename || (current && current.generation === entry.last.props.node.generation)) continue
        entry.invalidated = true
        desks.entries.delete(key); desks.entries.set(`recovery:${entry.key}`, entry); changed = true
      }
      if (changed) desks.change()
    })
  }, [desks, map, slug, treeSlug])
  useEffect(() => {
    let changed = false
    for (const key of desks.pendingPopouts) {
      let parsed: unknown
      try { parsed = JSON.parse(key) } catch { parsed = null }
      const parts = Array.isArray(parsed) ? parsed : []
      const id = typeof parts[1] === 'string' ? parts[1] : null
      const generation = typeof parts[2] === 'number' ? parts[2] : null
      const current = id ? map.get(id) : undefined
      if (parts[0] !== slug || !current || current.generation !== generation) {
        desks.pendingPopouts.delete(key)
        changed = true
      }
    }
    if (changed) desks.change()
  }, [desks, map, slug, treeSlug])
  useEffect(() => {
    // Once the authoritative tree drops the old name, a later new hire may
    // reuse it. Until then an old presentation must not recreate a writer.
    if (treeSlug !== slug) return
    for (const [key, id] of desks.renamedAway) if (!map.has(id)) desks.renamedAway.delete(key)
  }, [desks, map, slug, treeSlug])
  return <DeskMapReady.Provider value={treeSlug === slug}><DeskContext.Provider value={desks}>{children}<HostList desks={desks} map={map} slug={slug} /></DeskContext.Provider></DeskMapReady.Provider>
}

/**
 * A press on a control inside a canvas card must not reach the viewport.
 *
 * The viewport takes pointer capture on EVERY left press that gets to it
 * (OrgCanvas's onPointerDown), and once that capture is live Chromium fires
 * the compatibility mouse events — `click` among them — at the CAPTURING
 * element. A button that lets its pointerdown through is therefore pressed,
 * highlights under the cursor, and never hears the click at all. The card's
 * own `startNodeDrag` deliberately returns early for a button WITHOUT
 * stopping propagation, so nothing upstream saves it.
 *
 * Every in-card control already does this for itself: PinnedPlaceholder
 * (pins.tsx), the stack badge (cards.tsx), PopoutButton (popout.tsx), and
 * `.desk-over`'s own wall (desk.tsx) — which is what protects a real desk's
 * buttons, and which is NOT rendered while the desk is elsewhere. That is
 * why this notice has to carry its own.
 *
 * User report 2026-09-11: neither "Show desk" nor "Return here" did
 * anything. MEASURED in a real window, the click on both was delivered to
 * `div.viewport`; tests/placeholder-actions.probe.ts records the target of
 * every press so the difference is visible rather than inferred.
 */
const stopPress = (e: ReactPointerEvent) => e.stopPropagation()

/**
 * A notice standing where a desk would be.
 *
 * On a CANVAS CARD the desk is counter-scaled into the card's 120px
 * interior (`.desk-inner`), so a notice that replaces it has to be too, or
 * it renders at the camera's scale instead — 7.5x too big, wrapped, with its
 * buttons hanging outside the card. That is the shape the user reported on
 * 2026-09-11. `.pin-holder` + `.pin-placeholder` have always done this for a
 * pinned desk; this is the same pair for a popped-out one.
 *
 * `bare` is the discriminator and not a guess: it is the same flag that
 * decides whether the real desk renders counter-scaled (`.desk-inner`) or at
 * 1:1 (`.desk-bare`), so the notice follows whatever its desk would have
 * done. The switchboard panels and a pinned window's body are `bare` and
 * keep the plain inline notice.
 */
function InDesksPlace({ bare, children }: { bare?: boolean; children: ReactNode }) {
  if (bare) return <div className="popout-placeholder">{children}</div>
  return <div className="desk-elsewhere-holder">
    <div className="popout-placeholder desk-elsewhere">{children}</div>
  </div>
}

export function DeskSlot(outer: DeskChatProps) {
  const desks = useContext(DeskContext)
  const mapReady = useContext(DeskMapReady)
  // §4.8: an archived seat arrives summarised, and the desk reads its full
  // charter and turn history. Resolved HERE because this is the one door every
  // desk goes through — five call sites, one fetch rule. It does NOT gate:
  // the desk renders from the summary and upgrades when detail lands, so
  // opening a retired agent never waits on a spinner.
  const { node } = useNodeDetail(outer.slug, outer.node)
  const props = node === outer.node ? outer : { ...outer, node }
  if (!mapReady) return <InDesksPlace bare={props.bare}>Loading organization...</InDesksPlace>
  if (!desks || isMobile || typeof props.node.generation !== 'number'
    || !Number.isSafeInteger(props.node.generation) || props.node.generation < 0) return <OwnedDeskChat {...props} />
  return <RegisteredSlot desks={desks} props={props} />
}

export interface DeskActions {
  /** this seat can own a desk at all (a generation is what identifies one) */
  valid: boolean
  /** its desk is mounted somewhere right now */
  present: boolean
  /** its desk is already open as a native window */
  detached: boolean
  /** raise that native window */
  show?: () => void
  requestPopout: () => void
}

function deskActionsOf(desks: Desks | null, mapReady: boolean, slug: string,
  node: Pick<CanvasNode, 'id' | 'generation'>): DeskActions {
  const valid = typeof node.generation === 'number'
    && Number.isSafeInteger(node.generation) && node.generation >= 0
  const key = valid ? deskIdentity(slug, node) : null
  const entry = mapReady && desks && key ? desks.entries.get(key) : undefined
  return {
    valid,
    present: !!entry,
    detached: !!entry?.detached,
    show: entry?.show,
    // The list may ask before a desk host exists (the card is outside the
    // viewport), so the request is RETAINED until that desk registers its
    // native surface.
    requestPopout: () => { if (key) desks?.requestPopout(key) },
  }
}

/** An agent's desk-window actions, read at the moment they are needed — a
 *  context menu builds its entries when the menu OPENS, not on every render.
 *
 *  ⚠ IT DELIBERATELY DOES NOT SUBSCRIBE, which is what lets every agent card
 *  on the canvas and every row of the Agents List hold one: a
 *  `useSyncExternalStore` per caller would be hundreds of subscriptions to a
 *  store that only the open menu is looking at. The returned reader walks the
 *  live registry when it is called, so a menu opened a second later still sees
 *  the truth. A surface that DRAWS this state (a control that has to say
 *  "show" while the desk is detached and "pop out" while it is not) would need
 *  the subscription — there is no such control any more: the user had the
 *  per-agent pin and popout buttons removed from the list on 2026-09-12, in
 *  favour of the menu these entries live in. */
export function useDeskActionsNow(slug: string):
(node: Pick<CanvasNode, 'id' | 'generation'>) => DeskActions {
  const desks = useContext(DeskContext)
  const mapReady = useContext(DeskMapReady)
  return (node) => deskActionsOf(desks, mapReady, slug, node)
}

function RegisteredSlot({ desks, props }: { desks: Desks; props: DeskChatProps }) {
  const id = useRef({}).current
  const anchor = useRef<HTMLDivElement>(null)
  const key = deskIdentity(props.slug, props.node)
  useSyncExternalStore(desks.subscribe, desks.snapshot)
  useLayoutEffect(() => {
    if (anchor.current) desks.put(key, { id, anchor: anchor.current, props })
  }, [desks, key, id, props])
  useLayoutEffect(() => () => desks.remove(key, id), [desks, key, id])
  const e = desks.entries.get(key)
  const elsewhere = e?.detached || (e && e.last.id !== id)
  return <div className="desk-slot" ref={anchor} data-desk-slot={key}>
    {elsewhere && <InDesksPlace bare={props.bare}>
      <span data-copy-agent-name={props.node.id}>{props.node.id}'s desk is open elsewhere.</span>
      <button onPointerDown={stopPress} onClick={() => e.show?.()}>Show desk</button>
      {/* `id` is THIS slot: the desk comes back where it was asked for, which
          need not be the host it was popped out of. */}
      {e.detached && <button onPointerDown={stopPress} onClick={() => e.redock?.(id)}>Return here</button>}
    </InDesksPlace>}
  </div>
}
function HostList({ desks, map, slug }: { desks: Desks; map: Map<string, CanvasNode>; slug: string }) {
  useSyncExternalStore(desks.subscribe, desks.snapshot)
  return <>{[...desks.entries.values()].filter((e) => e.last.props.slug === slug).map((e) =>
    <DeskHost key={e.key} desks={desks} entry={e} map={map} />)}</>
}
function DeskHost({ desks, entry, map }: { desks: Desks; entry: Entry; map: Map<string, CanvasNode> }) {
  const current = map.get(entry.last.props.node.id)
  const changedGeneration = !!entry.invalidated || !current || current.generation !== entry.last.props.node.generation
  // THE SECOND ASSIGNMENT POINT (see `pick`). This used to be
  // `entry.slots.get(entry.last.id) ?? [...entry.slots.values()][0]`, which
  // handed ownership to the first slot in Map insertion order once the owner's
  // id was gone — as likely to be an invisible destination as a visible one.
  const slot = !entry.detached ? pick(entry) : entry.slots.get(entry.last.id)
  if (slot && !entry.detached) entry.last = slot
  const props = entry.last.props
  return <MovableSurface kind={`desk:${deskIdentity(props.slug, props.node)}`} title={`${props.node.id} · desk`}
    org={props.slug} anchor={slot?.anchor ?? null}
    onDetached={(v) => {
      entry.detached = v
      if (!v && !entry.slots.size) props.onJump?.(props.node.id)
      desks.change()
    }}>
    <DeskOwnerControls entry={entry} stale={changedGeneration} dismiss={() => {
      entry.redock?.(); for (const [key, e] of desks.entries) if (e === entry) desks.entries.delete(key); desks.change()
    }} />
    {changedGeneration && <StaleIdentityNotice generation={props.node.generation} />}
    <OwnedDeskChat {...props} node={changedGeneration ? props.node : current}
      map={map} staleIdentity={changedGeneration} />
  </MovableSurface>
}
function DeskOwnerControls({ entry, stale, dismiss }: { entry: Entry; stale: boolean; dismiss: () => void }) {
  const surface = useSurface()
  useLayoutEffect(() => {
    entry.show = () => {
      if (surface?.detached) surface.open()
      else { entry.last.anchor.scrollIntoView({ block: 'nearest' }); entry.last.props.onJump?.(entry.last.props.node.id) }
    }
    entry.redock = (slot) => {
      // Return the desk to the host that ASKED for it. `entry.last` is what
      // DeskHost hands MovableSurface as its anchor, so pointing it at the
      // clicked slot first is what makes the redock land there; the anchor
      // prop change re-places the surface on the commit that follows.
      const target = slot ? entry.slots.get(slot) : undefined
      if (target) entry.last = target
      surface?.redock()
    }
    entry.popout = () => surface?.open()
    if (entry.pendingPopout) {
      entry.pendingPopout = false
      queueMicrotask(() => entry.popout?.())
    }
  }, [entry, surface])
  return <StaleDeskControls stale={stale} dismiss={dismiss} />
}
/** The draft stranded by an identity change is now SAVED, not copied: it goes
 *  into this agent's sent-message history and comes back with Up in the
 *  message box. So the notice reads the same docked or popped out - there is
 *  no longer a control that exists in one place and not the other. */
function StaleIdentityNotice({ generation }: { generation: number | undefined }) {
  return <div className="popout-error" role="status">
    This agent's identity changed. This draft belongs to generation {generation}.
    It will not be sent to the new generation; it is kept in this agent's
    message history, so press Up in the message box to bring it back.
  </div>
}
/** What is left on a desk whose agent's identity has moved on: the way to
 *  close it. The `Copy unsent draft` button that used to sit here is retired -
 *  the draft is written into the agent's message history instead, so there is
 *  nothing to copy by hand and nothing that only works in the main window. */
function StaleDeskControls({ stale, dismiss }: { stale: boolean; dismiss: () => void }) {
  const surface = useSurface()
  if (!surface || !stale || surface.detached) return null
  return <div className="popout-draft-recovery">
    <button onClick={dismiss}>Close old desk</button>
  </div>
}

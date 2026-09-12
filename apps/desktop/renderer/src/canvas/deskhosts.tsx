import { draftKey } from '../draftstore'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { MovableSurface, useSurface } from '../popout'
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
  change = () => { this.version++; for (const fn of [...this.listeners]) fn() }
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
    if (!e.detached || e.last.id === slot.id) e.last = slot
    this.change()
  }
  remove(key: string, id: object) {
    const e = [...this.entries.values()].find((entry) => entry.slots.has(id))
    if (!e) return
    e.slots.delete(id)
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
  const slot = entry.slots.get(entry.last.id) ?? [...entry.slots.values()][0]
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
  const p = entry.last.props
  return <DraftRecovery stale={stale} dismiss={dismiss} keyName={draftKey(p.slug, p.node.id, deskGeneration(p.node))} />
}
/** The notice names the action that is ACTUALLY available where it is read. A
 *  popped-out desk has no draft-recovery controls (below), so telling its
 *  reader to copy the draft there would point at nothing. */
function StaleIdentityNotice({ generation }: { generation: number | undefined }) {
  const detached = !!useSurface()?.detached
  return <div className="popout-error" role="status">
    This agent's identity changed. This draft belongs to generation {generation}.
    {detached
      ? ' Return this desk to the main window to copy it; it will not be sent to the new generation.'
      : ' Copy your draft before returning; it will not be sent to the new generation.'}
  </div>
}
/** Draft recovery for a desk whose agent's identity has moved on, in the main
 *  window only (user 2026-09-11): a popped-out desk shows no draft-copy control
 *  at all. Redocking brings it back. */
function DraftRecovery({ keyName, stale, dismiss }: { keyName: string; stale: boolean; dismiss: () => void }) {
  const surface = useSurface()
  const [copied, setCopied] = useState(false)
  if (!surface || !stale || surface.detached) return null
  return <div className="popout-draft-recovery"><button className="popout-copy-draft" onClick={() => {
    let text = ''
    try { text = localStorage.getItem(keyName) || localStorage.getItem(keyName.replace('orgtree-draft-v2-', 'orgtree-draft-recovery-')) || '' } catch { /* unavailable */ }
    surface.document.defaultView?.navigator.clipboard?.writeText(text)
      .then(() => setCopied(true)).catch(() => setCopied(false))
  }}>{copied ? 'Draft copied' : 'Copy unsent draft'}</button>
    <button onClick={dismiss}>Close old desk</button>
  </div>
}

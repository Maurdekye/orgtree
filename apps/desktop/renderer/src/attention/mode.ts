// attention/mode.ts — WHICH VIEW AN ORGANIZATION IS IN, AND THE ATTENTION
// VIEW'S OWN LAYOUT, PERSISTED PER ORGANIZATION.
//
// Canvas and Attention are the two main views of an organization. The choice
// belongs to the ORGANIZATION, not to the app: opening org A in Attention view
// and then switching to org B must land on whatever B was left in, exactly the
// way every pinned surface is already scoped per org (`useScopedOpen` in
// canvas/modalpin.tsx, and the comment there for what went wrong without it).
//
// These are remembered, all per org:
//   view      'canvas' | 'attention'
//   split     divider fraction from the queue's side (1 - split when swapped)
//   agent     the selected agent in the dynamic agent area
//   listOpen  whether the agents list is rolled out rather than collapsed
//   swapped   Needs attention is on the right
//   hidden    the SIDE of the stage whose panel is hidden, if one is
//
// The store is the same shape the pin stores use: one cached read, one write
// that notifies, and a `forget` for a `storage` event from another window or
// for a test that cleared localStorage. A popped-out panel is a SEPARATE
// document sharing the same localStorage, so the storage listener is what
// keeps it agreeing with the main window rather than a second source of truth.

import { useSyncExternalStore } from 'react'

export type OrgView = 'canvas' | 'attention'

export const ORG_VIEW_KEY = 'orgtree-org-view'
export const ATTENTION_LAYOUT_KEY = 'orgtree-attention-layout'

/** Divider fraction from the queue's side. Bounded so a drag can never leave
 *  either panel at a width nothing can be read or clicked in. */
export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8
export const SPLIT_DEFAULT = 0.38
/** A drag stops at a panel's minimum; carried on past HALF of it, the panel is
 *  hidden instead (user 2026-11-13 m2672b93c2df8, point 4). */
export const HIDE_SNAP = SPLIT_MIN / 2

/** A side of the stage, as the user sees it. */
export type StageSide = 'left' | 'right'

export interface AttentionLayout {
  split: number
  agent: string | null
  /** the agents list is COLLAPSED by default (ticket) — rolled out on hover,
   *  or held open by this flag once the user opens it deliberately */
  listOpen: boolean
  /** the two panels' left/right order is reversed: Needs attention on the right */
  swapped: boolean
  /** THE SIDE WHOSE PANEL IS HIDDEN, because the divider was taken to that
   *  edge (user 2026-11-13 m525fd3e66e99). A side of the STAGE and not a panel:
   *  Swap panels leaves the divider where it is, so with one side hidden it
   *  changes only `swapped`, and the panel that was hidden is the one in view
   *  (point 1 of m2672b93c2df8). `split` then holds that side's panel at its
   *  minimum, which is where it comes back. */
  hidden: StageSide | null
}

export const DEFAULT_LAYOUT: AttentionLayout = {
  split: SPLIT_DEFAULT, agent: null, listOpen: false, swapped: false, hidden: null,
}

export const clampSplit = (v: number): number =>
  !Number.isFinite(v) ? SPLIT_DEFAULT : Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))

// ------------------------------------------------- where the divider stands
// The divider is dragged and keyed in the STAGE's terms (left and right as the
// user sees them); the store keeps the queue's share. These few functions are
// the whole translation, so the view never does the sum itself.

/** Where the divider stands: the left area's share of the stage, and the side
 *  it has been taken to the edge of, if any. */
export interface DividerPlace { left: number; hidden: StageSide | null }

export const dividerPlace = (l: Pick<AttentionLayout, 'split' | 'swapped' | 'hidden'>): DividerPlace =>
  ({ left: clampSplit(l.swapped ? 1 - l.split : l.split), hidden: l.hidden })

/** the layout fields a divider place is stored as */
export const placePatch = (place: DividerPlace, swapped: boolean): Pick<AttentionLayout, 'split' | 'hidden'> =>
  ({ split: clampSplit(swapped ? 1 - place.left : place.left), hidden: place.hidden })

const AT_LEFT: DividerPlace = { left: SPLIT_MIN, hidden: 'left' }
const AT_RIGHT: DividerPlace = { left: SPLIT_MAX, hidden: 'right' }

/** The place a pointer at `x` (a fraction of the stage's width) asks for: a
 *  panel stops at its minimum, and within HIDE_SNAP of an edge it is hidden. */
export function placeFromPointer(x: number): DividerPlace {
  if (!Number.isFinite(x)) return { left: SPLIT_DEFAULT, hidden: null }
  if (x < HIDE_SNAP) return AT_LEFT
  if (x > 1 - HIDE_SNAP) return AT_RIGHT
  return { left: clampSplit(x), hidden: null }
}

/** The place a key asks for from `place`, or null for a key that is not the
 *  divider's. An arrow steps; at a panel's minimum the next step hides it, and
 *  the opposite arrow brings a hidden panel back at that minimum. Home and End
 *  hide the left and the right panel. */
export function placeFromKey(place: DividerPlace, key: string, big: boolean): DividerPlace | null {
  const step = big ? 0.1 : 0.02
  const eps = 1e-9
  if (key === 'Home') return AT_LEFT
  if (key === 'End') return AT_RIGHT
  if (key === 'ArrowLeft') {
    if (place.hidden === 'left') return place
    if (place.hidden === 'right') return { left: SPLIT_MAX, hidden: null }
    if (place.left <= SPLIT_MIN + eps) return AT_LEFT
    return { left: clampSplit(place.left - step), hidden: null }
  }
  if (key === 'ArrowRight') {
    if (place.hidden === 'right') return place
    if (place.hidden === 'left') return { left: SPLIT_MIN, hidden: null }
    if (place.left >= SPLIT_MAX - eps) return AT_RIGHT
    return { left: clampSplit(place.left + step), hidden: null }
  }
  return null
}

/** Which panel a layout hides. */
export const hiddenPanel = (l: Pick<AttentionLayout, 'swapped' | 'hidden'>): 'queue' | 'desk' | null =>
  l.hidden === null ? null : (l.hidden === 'left') !== l.swapped ? 'queue' : 'desk'

const subs = new Set<() => void>()
const notify = () => { for (const fn of [...subs]) fn() }
const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? obj as Record<string, unknown> : {}
  } catch { return {} }        // private mode, or garbage — same answer
}

function writeJson(key: string, value: Record<string, unknown>): void {
  try {
    if (Object.keys(value).length) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch { /* private mode */ }
}

let layoutCache: Record<string, AttentionLayout> | null = null

/** drop the cached copy so the next read comes from storage again. The view
 *  key is not cached at all — see `readViews`. */
export function forgetAttentionMode(): void {
  layoutCache = null
  notify()
}

/** THE CHANNEL A SECOND WRITER OF THE VIEW KEY USES TO SAY SO.
 *
 *  While the shell ships its temporary `shell/viewmode.ts`, two modules write
 *  `orgtree-org-view`. An uncached read (see `readViews`) means neither can
 *  serve a stale answer, but a foreign write still has to WAKE the subscribers
 *  here or nothing re-renders to do the reading. `storage` does not fire for a
 *  same-document write, so this is the signal: whoever writes the key
 *  dispatches it, and every reader in this document hears it.
 *
 *  Same idiom as `orgtree:desk-rename` in canvas/deskhosts.tsx — a window
 *  CustomEvent is how this renderer already crosses a module boundary that has
 *  no shared store. It costs nothing once the shell's module is deleted: this
 *  module keeps dispatching it and nobody else has to listen. */
export const ORG_VIEW_EVENT = 'orgtree:org-view'

/** ⚠ A PLAIN `Event`, NOT `CustomEvent`. This channel carries no payload — the
 *  readers re-read storage — so a bare Event is sufficient, and it is the one
 *  that exists everywhere this renderer runs. `CustomEvent` is NOT on the test
 *  harness's globals, so the first version of this dispatched nothing at all
 *  and the surrounding try/catch swallowed the failure: a signal that silently
 *  never fires is worse than no signal, because everything downstream still
 *  looks wired up. */
function announceViewChange(): void {
  try { window.dispatchEvent(new Event(ORG_VIEW_EVENT)) } catch { /* no DOM */ }
}

/**
 * ⚠ DELIBERATELY UNCACHED, unlike `readLayouts` below. This key has a SECOND
 * WRITER for as long as the shell ships its temporary `shell/viewmode.ts` — the
 * compact header could not be blocked on a module in another worktree, so that
 * module writes `orgtree-org-view` on the same contract until it is replaced by
 * this one. A cache here would go stale the instant that writer wrote, and
 * `storage` events do not fire for same-document writes, so nothing would
 * correct it.
 *
 * Re-reading is safe HERE and not below because of what each returns:
 * `orgView` yields a STRING, which `useSyncExternalStore` compares by value, so
 * a fresh parse per call is still a stable snapshot. `attentionLayout` yields an
 * OBJECT, and a fresh one per call would be a new identity every render — an
 * infinite re-render loop, not a staleness bug. The layout key has only ever had
 * one writer, so it keeps its cache.
 *
 * The parse is a few hundred bytes of JSON; the correctness is worth more.
 */
function readViews(): Record<string, OrgView> {
  const out: Record<string, OrgView> = {}
  for (const [org, v] of Object.entries(readJson(ORG_VIEW_KEY))) {
    if (v === 'canvas' || v === 'attention') out[org] = v
  }
  return out
}

function readLayouts(): Record<string, AttentionLayout> {
  if (layoutCache) return layoutCache
  const out: Record<string, AttentionLayout> = {}
  for (const [org, v] of Object.entries(readJson(ATTENTION_LAYOUT_KEY))) {
    const o = v as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    out[org] = {
      split: clampSplit(typeof o.split === 'number' ? o.split : SPLIT_DEFAULT),
      agent: typeof o.agent === 'string' && o.agent ? o.agent : null,
      listOpen: o.listOpen === true,
      swapped: o.swapped === true,
      hidden: o.hidden === 'left' || o.hidden === 'right' ? o.hidden : null,
    }
  }
  layoutCache = out
  return out
}

/** The view an organization is in. A slug nobody has chosen for reads as
 *  `canvas`: the canvas is the default way to look at an organization, and an
 *  unknown org must never open somewhere the user did not put it. */
export function orgView(slug: string | null): OrgView {
  if (!slug) return 'canvas'
  return readViews()[slug] ?? 'canvas'
}

export function setOrgView(slug: string | null, view: OrgView): void {
  if (!slug) return
  const next = { ...readViews() }
  if (view === 'canvas') delete next[slug]   // the default is stored as absence
  else next[slug] = view
  writeJson(ORG_VIEW_KEY, next)
  announceViewChange()
  notify()
}

export function attentionLayout(slug: string | null): AttentionLayout {
  if (!slug) return DEFAULT_LAYOUT
  return readLayouts()[slug] ?? DEFAULT_LAYOUT
}

export function setAttentionLayout(slug: string | null, patch: Partial<AttentionLayout>): void {
  if (!slug) return
  const layouts = readLayouts()
  const merged: AttentionLayout = { ...(layouts[slug] ?? DEFAULT_LAYOUT), ...patch }
  merged.split = clampSplit(merged.split)
  const next = { ...layouts, [slug]: merged }
  layoutCache = next
  writeJson(ATTENTION_LAYOUT_KEY, next)
  notify()
  // AFTER the write, so a listener reads the layout the choice produced
  if (typeof patch.agent === 'string' && patch.agent) {
    for (const fn of [...agentChosen]) fn(slug, patch.agent)
  }
}

/**
 * SOMEBODY CHOSE AN AGENT FOR THE ATTENTION DESK. Every route that does ends in
 * `setAttentionLayout(slug, { agent })` with a name: an agent link or any other
 * focus action while the view is presented (OrgCanvas's `centerOn`), a mention
 * row, a press in the desk's own agents list. All of them are a person asking
 * to see that agent, which is what the view needs to know when its Agent desk
 * has been hidden at the edge: the request would otherwise change a panel
 * nobody can see. Clearing the selection (`agent: null`) is not a choice and is
 * not announced.
 *
 * A plain callback set. The view decides what a choice means for it: only a
 * desk EMBEDDED in the stage can be hidden there, and a pinned or popped-out
 * one is already where the user put it.
 */
const agentChosen = new Set<(slug: string, agent: string) => void>()
export function onAttentionAgentChosen(fn: (slug: string, agent: string) => void): () => void {
  agentChosen.add(fn)
  return () => { agentChosen.delete(fn) }
}

// ---------------------------------------------------------------- the hooks
// `getSnapshot` must return a STABLE value for an unchanged store, or
// useSyncExternalStore re-renders forever. Both readers below return the same
// object identity until something calls notify(), because the caches are
// replaced only on a write.

export function useOrgView(slug: string | null): OrgView {
  return useSyncExternalStore(subscribe, () => orgView(slug), () => orgView(slug))
}

export function useAttentionLayout(slug: string | null): AttentionLayout {
  return useSyncExternalStore(subscribe,
    () => attentionLayout(slug), () => attentionLayout(slug))
}

/** Keep every window (and every popped-out panel, which is its own document)
 *  agreeing with storage. Mounted once by the view; harmless if mounted twice. */
export function startAttentionModeSync(target: Window = window): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ORG_VIEW_KEY || e.key === ATTENTION_LAYOUT_KEY) {
      forgetAttentionMode()
    }
  }
  // a same-document writer of the view key — see ORG_VIEW_EVENT
  const onForeignView = () => notify()
  target.addEventListener('storage', onStorage)
  target.addEventListener(ORG_VIEW_EVENT, onForeignView)
  return () => {
    target.removeEventListener('storage', onStorage)
    target.removeEventListener(ORG_VIEW_EVENT, onForeignView)
  }
}

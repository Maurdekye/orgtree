// attention/mode.ts — WHICH VIEW AN ORGANIZATION IS IN, AND THE ATTENTION
// VIEW'S OWN LAYOUT, PERSISTED PER ORGANIZATION.
//
// Canvas and Attention are the two main views of an organization. The choice
// belongs to the ORGANIZATION, not to the app: opening org A in Attention view
// and then switching to org B must land on whatever B was left in, exactly the
// way every pinned surface is already scoped per org (`useScopedOpen` in
// canvas/modalpin.tsx, and the comment there for what went wrong without it).
//
// Three things are remembered, all per org:
//   view      'canvas' | 'attention'
//   split     the divider position, as the left panel's fraction of the stage
//   agent     the selected agent in the dynamic agent area
//   listOpen  whether the agents list is rolled out rather than collapsed
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

/** the left panel's share of the stage. Bounded so a drag can never leave
 *  either panel at a width nothing can be read or clicked in. */
export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8
export const SPLIT_DEFAULT = 0.38

export interface AttentionLayout {
  split: number
  agent: string | null
  /** the agents list is COLLAPSED by default (ticket) — rolled out on hover,
   *  or held open by this flag once the user opens it deliberately */
  listOpen: boolean
}

export const DEFAULT_LAYOUT: AttentionLayout = {
  split: SPLIT_DEFAULT, agent: null, listOpen: false,
}

export const clampSplit = (v: number): number =>
  !Number.isFinite(v) ? SPLIT_DEFAULT : Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))

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

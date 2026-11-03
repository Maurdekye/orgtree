// canvas/subtreefold.ts — expand/collapse an agent's or project's subtree
// on the canvas (user 2026-10-28; liaison spec 2026-11-01). A DISPLAY prune
// of the layout tree, exactly the shape of hide-retired's pruneRetiredView:
// the full map keeps every node addressable (desks, mail, lineage), a folded
// member simply has no card of its own — the collapsed node stands for it in
// the shared `hidden` map, so wires, sparks, focus and keyboard navigation
// treat it like a piled-away member. The layout reflows over the pruned
// tree in both chart layouts. The folded set is per-org reader state, saved
// across restarts like the camera (`orgtree-view-<slug>`) and pile fronts
// (`orgtree-pile-<slug>`); no org record changes.
import { useSyncExternalStore } from 'react'
import type { CanvasNode } from './shared'

/** what a collapsed node reports about the members it hides */
/** one direct child a collapsed node tucks under its bottom edge */
export interface FoldTuck {
  id: string
  /** a project child wears its theme colour; an agent child its provider's */
  project: boolean
  tier?: string
}

/** at most this many tucked shapes peek out under a collapsed node */
export const MAX_TUCKS = 3

export interface FoldSummary {
  /** every hidden descendant, agents and projects alike */
  count: number
  /** some hidden member is mid-turn */
  working: boolean
  /** some hidden member needs the user's attention — collapsing never hides it */
  attention: boolean
  /** the first MAX_TUCKS direct children, in child order (the tucked stack) */
  tucks?: FoldTuck[]
}

/** the fold control's view of one card that has members */
export interface FoldInfo extends FoldSummary { collapsed: boolean }

const midTurn = (n: CanvasNode): boolean =>
  !!n.busy || n.phase === 'compacting'

const asksAttention = (n: CanvasNode): boolean =>
  !!(n.ask && (n.ask.status === 'open' || n.ask.status === 'pending'))

/** the collapsed-subtree DISPLAY prune (pure — the canvas memos it; tests
 *  call it directly). A node in `collapsed` keeps its card and loses its
 *  children lists. Returns the pruned root, every hidden id, each hidden id's
 *  standing collapsed node (for the canvas `hidden` map), and each VISIBLE
 *  collapsed node's summary. A knowledge bearer is never claimed: its
 *  floating card beside its successor is an active consultation surface,
 *  not a resting member (the hide-retired rule) — it takes no layout slot
 *  either way, so only the bookkeeping skips it. `needsAttention` lets the
 *  caller fold its own attention signals (submitted-ask suppression, unseen
 *  mentions) into the rollup beside the open-question default. */
export function pruneCollapsedView(root: CanvasNode,
  collapsed: ReadonlySet<string>,
  needsAttention: (n: CanvasNode) => boolean = asksAttention): {
  root: CanvasNode
  prunedIds: Set<string>
  hiddenBy: Map<string, string>
  summaries: Map<string, FoldSummary>
} {
  const prunedIds = new Set<string>()
  const hiddenBy = new Map<string, string>()
  const summaries = new Map<string, FoldSummary>()
  if (!collapsed.size) return { root, prunedIds, hiddenBy, summaries }
  const walk = (n: CanvasNode): CanvasNode => {
    const kids = n.children ?? []
    if (collapsed.has(n.id) && kids.length) {
      const summary: FoldSummary = { count: 0, working: false, attention: false }
      const collect = (d: CanvasNode) => {
        if (!d.isBearerOf) {
          prunedIds.add(d.id)
          hiddenBy.set(d.id, n.id)
          summary.count++
          if (midTurn(d)) summary.working = true
          if (needsAttention(d)) summary.attention = true
        }
        ;(d.children ?? []).forEach(collect)
      }
      kids.forEach(collect)
      summary.tucks = kids.filter((k) => !k.isBearerOf).slice(0, MAX_TUCKS)
        .map((k) => ({ id: k.id, project: k.kind === 'project', tier: k.tier ?? undefined }))
      if (summary.count) summaries.set(n.id, summary)
      return { ...n, children: [] }
    }
    let changed = false
    const next = kids.map((c) => {
      const w = walk(c)
      if (w !== c) changed = true
      return w
    })
    return changed ? { ...n, children: next } : n
  }
  return { root: walk(root), prunedIds, hiddenBy, summaries }
}

/** every VISIBLE node with members → its fold control's facts. Walks the
 *  pre-collapse tree (post retired-prune), so "has members" means members
 *  this view would actually show; a collapsed node's own members get no
 *  entry — they have no card to carry a chevron. The eye, the draft card
 *  and lineage bearers never fold. */
export function subtreeFoldInfo(root: CanvasNode,
  collapsed: ReadonlySet<string>,
  summaries: ReadonlyMap<string, FoldSummary>): Map<string, FoldInfo> {
  const out = new Map<string, FoldInfo>()
  const walk = (n: CanvasNode, isRoot: boolean) => {
    const kids = n.children ?? []
    if (!isRoot && kids.length && n.state !== 'draft' && n.state !== 'user'
        && !n.isBearerOf) {
      if (collapsed.has(n.id)) {
        const s = summaries.get(n.id)
        if (s) out.set(n.id, { collapsed: true, ...s })
        return
      }
      out.set(n.id, { collapsed: false, count: 0, working: false, attention: false })
    }
    kids.forEach((c) => walk(c, false))
  }
  walk(root, true)
  return out
}

// ------------------------------------------------------------- the saved set

export const collapsedSubtreesKey = (slug: string): string =>
  'orgtree-collapsed-' + slug

export function parseCollapsedSubtrees(raw: string | null): Set<string> {
  try {
    const v: unknown = JSON.parse(raw ?? 'null')
    return new Set(Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch { return new Set() }
}

const EMPTY: ReadonlySet<string> = new Set()
const cache = new Map<string, ReadonlySet<string>>()
const listeners = new Set<() => void>()
const notify = () => { for (const fn of [...listeners]) fn() }

export function getCollapsedSubtrees(slug: string): ReadonlySet<string> {
  let hit = cache.get(slug)
  if (!hit) {
    let raw: string | null = null
    try { raw = localStorage.getItem(collapsedSubtreesKey(slug)) } catch { /* storage unavailable: the fold works for the session */ }
    hit = parseCollapsedSubtrees(raw)
    cache.set(slug, hit)
  }
  return hit
}

function setCollapsedSubtrees(slug: string, next: ReadonlySet<string>): void {
  cache.set(slug, next)
  try {
    if (next.size) localStorage.setItem(collapsedSubtreesKey(slug), JSON.stringify([...next]))
    else localStorage.removeItem(collapsedSubtreesKey(slug))
  } catch { /* private mode: same best-effort persistence as the camera */ }
  notify()
}

export function toggleCollapsedSubtree(slug: string, id: string): void {
  const next = new Set(getCollapsedSubtrees(slug))
  if (!next.delete(id)) next.add(id)
  setCollapsedSubtrees(slug, next)
}

/** an explicit jump to a folded-away member unfolds the folds over it (the
 *  hide-retired reveal precedent); attention alone never calls this */
export function expandCollapsedSubtrees(slug: string, ids: Iterable<string>): void {
  const cur = getCollapsedSubtrees(slug)
  const drop = [...ids].filter((id) => cur.has(id))
  if (!drop.length) return
  const next = new Set(cur)
  drop.forEach((id) => next.delete(id))
  setCollapsedSubtrees(slug, next)
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  const storage = (e: StorageEvent) => {
    if (e.key === null) cache.clear()
    else if (e.key.startsWith('orgtree-collapsed-'))
      cache.delete(e.key.slice('orgtree-collapsed-'.length))
    else return
    fn()
  }
  window.addEventListener('storage', storage)
  return () => { listeners.delete(fn); window.removeEventListener('storage', storage) }
}

export const useCollapsedSubtrees = (slug: string): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => getCollapsedSubtrees(slug), () => EMPTY)

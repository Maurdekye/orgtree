// Structural sharing between two projections of the same org tree.
//
// The record feed projects a whole new tree on every frame (recordprojection.ts projectTree), so
// every node is a new object even when one agent's status changed, or nothing did (the net
// record's hub heartbeat). Every memo keyed on a node or the tree then misses, and each frame
// re-renders the canvas and every open desk: 4.6.1-alpha.3 on the user's machine blocked the
// renderer for up to 11.2 s during feed bursts. shareTree hands back the previous objects for
// everything that is equal by value, so an unchanged frame returns the previous tree itself and a
// changed node only renews itself and its ancestors.
import type { TreeNode, TreePayload } from './types'

/** equal by value: plain JSON-like data (records from the feed) */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const pa = Object.getPrototypeOf(a), pb = Object.getPrototypeOf(b)
  if (pa !== pb || (pa !== Object.prototype && pa !== null)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

function shareNode(prev: TreeNode | undefined, next: TreeNode, byId: Map<string, TreeNode>): TreeNode {
  const old = prev && prev.id === next.id ? prev : byId.get(next.id)
  const kids = next.children ?? []
  const children = kids.map((c, i) => shareNode(old?.children?.[i], c, byId))
  if (!old) return children.every((c, i) => c === kids[i]) ? next : { ...next, children }
  const sameKids = old.children?.length === children.length && children.every((c, i) => c === old.children[i])
  let same = sameKids
  if (same) for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (k === 'children') continue
    if (!sameValue((old as unknown as Record<string, unknown>)[k], (next as unknown as Record<string, unknown>)[k])) { same = false; break }
  }
  if (same) return old
  return children.every((c, i) => c === kids[i]) ? next : { ...next, children }
}

/** `next` with every part equal by value to `prev` replaced by prev's object; `prev` itself when all is equal */
export function shareTree(prev: TreePayload | null | undefined, next: TreePayload): TreePayload {
  if (!prev || prev === next) return next
  const byId = new Map<string, TreeNode>()
  const index = (n: TreeNode) => { byId.set(n.id, n); for (const c of n.children ?? []) index(c) }
  for (const r of prev.roots ?? []) index(r)
  const nextRoots = next.roots ?? []
  const roots = nextRoots.map((r, i) => shareNode(prev.roots?.[i], r, byId))
  const sameRoots = prev.roots?.length === roots.length && roots.every((r, i) => r === prev.roots[i])
  const out: Record<string, unknown> = { ...next, roots: sameRoots ? prev.roots : roots }
  let same = sameRoots
  for (const k of Object.keys(out)) {
    if (k === 'roots') continue
    const p = (prev as unknown as Record<string, unknown>)[k]
    if (sameValue(p, out[k])) out[k] = p
    else same = false
  }
  if (same && Object.keys(prev).length === Object.keys(out).length) return prev
  return out as unknown as TreePayload
}

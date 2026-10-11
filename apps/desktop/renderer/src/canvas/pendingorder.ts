import type { TreeNode, TreePayload } from '../types'
import { siblingOrder, type SiblingOrder } from '../treeorder'

export type ReorderSlot = { before?: string; after?: string }
export type PendingOrder = {
  parent: string | null
  block: readonly string[]
  slot: ReorderSlot
  settled: boolean
}

/** Mirror Rust reorder's live-sibling midpoint, including its ordering of
 * archived cards. The block is the existing sequential stack request. Never
 * reparent a member or invent a missing anchor after a concurrent tree change. */
function ordered(kids: TreeNode[], entry: PendingOrder): TreeNode[] {
  if (entry.block.some(id => !kids.some(n => n.id === id))) return kids
  let next = kids
  let prev: string | undefined
  for (const id of entry.block) {
    const slot = prev ? { after: prev } : entry.slot
    const live = next.filter(n => n.id !== id && n.state === 'live').sort(siblingOrder)
    const anchor = slot.before ?? slot.after
    const at = anchor === undefined ? live.length : live.findIndex(n => n.id === anchor)
    if (at < 0) return kids
    const pos = at + (slot.after === undefined ? 0 : 1)
    const key = (n: SiblingOrder) => n.sibling_order ?? n.ui_order ?? 0
    const left = pos > 0 ? key(live[pos - 1]!) : live.length ? key(live[0]!) - 2 : 0
    const right = pos < live.length ? key(live[pos]!) : left + 2
    const order = (left + right) / 2
    next = next.map(n => n.id === id ? { ...n, ui_order: order, sibling_order: order } : n)
      .sort(siblingOrder)
    prev = id
  }
  // Preserve identity once the visual order agrees, even if numeric keys differ.
  return next.every((n, i) => n.id === kids[i]?.id) ? kids : next
}

export function withPendingOrder(tree: TreePayload, entry: PendingOrder): TreePayload {
  const walk = (kids: TreeNode[]): TreeNode[] => {
    let changed = false
    const next = kids.map(n => {
      const children = n.id === entry.parent ? ordered(n.children, entry) : walk(n.children)
      if (children === n.children) return n
      changed = true
      return { ...n, children }
    })
    return changed ? next : kids
  }
  const roots = entry.parent === null ? ordered(tree.roots, entry) : walk(tree.roots)
  return roots === tree.roots ? tree : { ...tree, roots }
}

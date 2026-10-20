import type { TreeNode, TreePayload } from '../types'
import type { ReorderSlot } from './pendingorder'
import type { CanvasNode } from './shared'
import type { SiblingOrder } from '../treeorder'

export type BunchRotation = { before: string[]; after: string[]; steps: Record<string, unknown>[] }

function nodesInRun(tree: TreePayload, ids: readonly string[]) {
  let head: TreeNode | undefined, parent: string | null = null
  const find = (kids: TreeNode[], owner: string | null) => {
    for (const n of kids) {
      if (n.id === ids[0]) { head = n; parent = owner; return }
      find(n.children, n.id)
      if (head) return
    }
  }
  find(tree.roots, null)
  type RunNode = TreeNode & Pick<CanvasNode, 'hidden_retired_children'> & SiblingOrder
  const nodes: RunNode[] = []
  let n: RunNode | undefined = head
  for (let i = 0; i < ids.length; i++) {
    if (!n || n.id !== ids[i] || n.kind !== 'project' || n.state !== 'live'
      || n.hidden_retired_children) return null
    nodes.push(n)
    if (i < ids.length - 1 && n.children.length !== 1) return null
    n = n.children[0]
  }
  return nodes.length ? { nodes, parent } : null
}

/** Rotate identities along a physical chain without adopting/releasing its
 * bottom group. Each intermediate move is acyclic. The caller submits ALL
 * steps in one existing userGesture transaction, never separate HTTP writes. */
export function projectBunchRotation(tree: TreePayload, before: string[], id: string, slot: ReorderSlot): BunchRotation | null {
  const run = nodesInRun(tree, before)
  if (!run) throw new Error('This project column changed or has unloaded children. Load its complete children, including retired nodes, before reordering.')
  const old = before.indexOf(id), remaining = before.filter(k => k !== id)
  if (old < 0 || !remaining.length) return null
  const anchor = slot.before ?? slot.after
  const anchorIndex = remaining.indexOf(anchor ?? '')
  if (anchorIndex < 0) return null
  const index = anchorIndex + (slot.after ? 1 : 0)
  const after = [...remaining.slice(0, index), id, ...remaining.slice(index)]
  if (before.every((k, i) => k === after[i])) return null
  const steps: Record<string, unknown>[] = []
  let batch: { node: string; new_parent: string | null }[] = []
  const flush = () => { if (batch.length) { steps.push({ op: 'moves', moves: batch }); batch = [] } }
  const move = (node: string, new_parent: string | null) => {
    batch.push({ node, new_parent }); if (batch.length === 20) flush()
  }
  const oldParent = old ? before[old - 1]! : run.parent
  for (const c of run.nodes[old]!.children) move(c.id, oldParent)
  if (old === 0) {
    flush()
    steps.push({ op: 'reorder', node: remaining[0], before: id })
  }
  move(id, index ? remaining[index - 1]! : run.parent)
  if (index === 0) {
    flush()
    steps.push({ op: 'reorder', node: id, before: remaining[0] })
  }
  if (index < remaining.length) move(remaining[index]!, id)
  else for (const c of run.nodes[run.nodes.length - 1]!.children) move(c.id, id)
  flush()
  if (steps.length > 100) throw new Error('This project has too many children for one atomic reorder.')
  return { before, after, steps }
}

/** Optimistic display using current data, never a captured stale tree.
 * A concurrent split invalidates the preview; an agreeing feed is already
 * in the requested order and needs no projection. */
export function withProjectBunchRotation(tree: TreePayload, rotation: BunchRotation): TreePayload {
  const run = nodesInRun(tree, rotation.before)
  if (!run) return tree
  const nodes = new Map(run.nodes.map(n => [n.id, n]))
  let kids = run.nodes[run.nodes.length - 1]!.children
  for (const id of [...rotation.after].reverse()) kids = [{ ...nodes.get(id)!, children: kids }]
  const old = run.nodes[0]!
  const head = { ...kids[0]!, ui_order: old.ui_order, sibling_order: old.sibling_order }
  const replace = (rows: TreeNode[]): TreeNode[] => rows.map(n =>
    n.id === old.id ? head : { ...n, children: replace(n.children) })
  return { ...tree, roots: replace(tree.roots) }
}

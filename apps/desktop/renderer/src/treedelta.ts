/** Exact-base, lossless tree patches. Widgets still receive the full TreePayload. */
import type { TreeNode, TreePayload } from './types'

type Fields = { set: Record<string, unknown>; remove: string[] }
export type TreeWire = {
  format: 'orgtree.tree/v1'; revision: string; tree?: TreePayload; base?: string
  top?: Fields; nodes?: Record<string, Fields>; removed?: string[]
}

const fields = (old: Record<string, unknown>, change: Fields): Record<string, unknown> => {
  const result = { ...old, ...change.set }
  for (const key of change.remove) delete result[key]
  return result
}

export function decodeTree(raw: TreePayload | TreeWire,
                           base?: { revision: string; raw: TreePayload }): TreePayload {
  if (!('format' in raw) || raw.format !== 'orgtree.tree/v1') return raw as TreePayload
  const wire = raw as TreeWire
  if (wire.tree) return wire.tree
  if (!base || wire.base !== base.revision || !wire.top || !wire.nodes || !wire.removed) {
    throw new Error('Tree delta does not match its cached base')
  }
  const nodes = new Map<string, Record<string, unknown>>()
  const flatten = (node: TreeNode): void => {
    nodes.set(node.id, { ...node, children: node.children.map(n => n.id) })
    node.children.forEach(flatten)
  }
  base.raw.roots.forEach(flatten)
  for (const id of wire.removed) nodes.delete(id)
  for (const [id, patch] of Object.entries(wire.nodes)) nodes.set(id, fields(nodes.get(id) ?? {}, patch))
  const top = fields({ ...base.raw, roots: base.raw.roots.map(n => n.id) }, wire.top)
  const visited = new Set<string>()
  const rebuild = (id: string): TreeNode => {
    if (visited.has(id)) throw new Error('Tree delta contains a cycle or duplicate node')
    const row = nodes.get(id)
    if (!row || row.id !== id || !Array.isArray(row.children)) throw new Error('Tree delta is missing a node')
    visited.add(id)
    return { ...row, children: (row.children as string[]).map(rebuild) } as TreeNode
  }
  if (!Array.isArray(top.roots)) throw new Error('Tree delta is missing its roots')
  const roots = (top.roots as string[]).map(rebuild)
  if (visited.size !== nodes.size) throw new Error('Tree delta contains unreachable nodes')
  return { ...top, roots } as unknown as TreePayload
}

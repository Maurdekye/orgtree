import type { OrgListEntry, TreeNode, TreePayload } from './types'
import type { RecordTable } from './recordfeed'
import { hydrateTree } from './archived'

/** Compatibility records contain renderer values, never PostgreSQL column layouts. */
export function projectTree(records: RecordTable): TreePayload {
  const top = records.get('org')?.get('org') as Omit<TreePayload, 'roots'> | undefined
  if (!top) throw new Error('Feed snapshot is missing org record')
  const nodes = records.get('agent') ?? new Map()
  agentRecordIds(records)
  const children = new Map<string | null, string[]>()
  for (const [id, body] of nodes) {
    const row = body as AgentRecord
    if (!row || typeof row.id !== 'string'
        || !(row.parent_id === null || typeof row.parent_id === 'string'))
      throw new Error('Feed agent is missing its parent link')
    const siblings = children.get(row.parent_id) ?? []
    siblings.push(id)
    children.set(row.parent_id, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => {
    const x = nodes.get(a) as AgentRecord, y = nodes.get(b) as AgentRecord
    return (x.sibling_order ?? x.ui_order ?? 0) - (y.sibling_order ?? y.ui_order ?? 0)
      || a.localeCompare(b)
  })
  // Partial sets may have missing parents; cycles among held records are still invalid.
  const checked = new Set<string>()
  for (const id of nodes.keys()) {
    const path = new Set<string>()
    let at: string | null = id
    while (at !== null && nodes.has(at) && !checked.has(at)) {
      if (path.has(at)) throw new Error('Feed tree contains a cycle')
      path.add(at)
      at = (nodes.get(at) as AgentRecord).parent_id
    }
    for (const key of path) checked.add(key)
  }
  const seen = new Set<string>()
  const build = (id: string): TreeNode => {
    if (seen.has(id)) throw new Error('Feed tree contains a cycle or duplicate node')
    const row = nodes.get(id) as AgentRecord | undefined
    if (!row) throw new Error('Feed tree is missing a node')
    seen.add(id)
    const { parent_id: _parent, sibling_order: _order, ...fields } = row
    const parent = row.parent_id === null ? null : (nodes.get(row.parent_id) as AgentRecord).id
    return { ...fields, parent, children: (children.get(id) ?? []).map(build) } as TreeNode
  }
  const roots = (children.get(null) ?? []).map(build)
  return hydrateTree({ ...top, roots } as TreePayload)
}

export function projectOrgs(records: RecordTable): OrgListEntry[] {
  return [...(records.get('registry_org')?.values() ?? [])] as OrgListEntry[]
}

export type AgentRecord = Omit<TreeNode, 'children'> & { parent_id: string | null; sibling_order?: number }
const nameIndexes = new WeakMap<RecordTable, ReadonlyMap<string, string>>()

/** UI nid lookup remains stable through a database-keyed rename. */
export function agentRecordIds(records: RecordTable): ReadonlyMap<string, string> {
  const cached = nameIndexes.get(records)
  if (cached) return cached
  const names = new Map<string, string>()
  for (const [id, body] of records.get('agent') ?? []) {
    const row = body as AgentRecord
    if (!row || typeof row.id !== 'string' || names.has(row.id))
      throw new Error('Feed agent name is invalid or duplicated')
    names.set(row.id, id)
  }
  nameIndexes.set(records, names)
  return names
}

export const recordFeedCapable = (tree: TreePayload | null): boolean =>
  (tree as (TreePayload & { capabilities?: { record_changes_v1?: boolean } }) | null)
    ?.capabilities?.record_changes_v1 === true

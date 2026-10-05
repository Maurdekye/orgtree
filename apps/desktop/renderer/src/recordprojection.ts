import type { OrgListEntry, TreeNode, TreePayload } from './types'
import type { FeedCursor, RecordTable } from './recordfeed'
import type { RuntimeTable, RuntimeValue } from './recordoverlay'
import { hydrateTree } from './archived'

export interface TreeRecordInputs {
  runtime?: RuntimeTable
  netRuntime?: Readonly<RuntimeValue> | null
  favourites?: { tiers?: Record<string, number>; models?: Record<string, unknown> }
  cursor?: FeedCursor
}
export const treeOrgGroups = ['settings', 'tiers', 'cost', 'audit', 'foreground', 'asks',
  'audiences', 'watchdogs', 'inbox_summary', 'org_inbox', 'net', 'work_summary'] as const

function header(records: RecordTable): Omit<TreePayload, 'roots'> {
  const rows = records.get('org')
  // The disabled earlier prototype used a single compatibility header.
  if (rows?.has('org')) return rows.get('org') as Omit<TreePayload, 'roots'>
  const top: Record<string, unknown> = {}
  for (const group of treeOrgGroups) {
    const fields = rows?.get(group)
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      throw new Error('Feed snapshot is missing org group: ' + group)
    for (const [key, value] of Object.entries(fields)) {
      if (Object.hasOwn(top, key)) throw new Error('Feed org groups repeat a field: ' + key)
      top[key] = value
    }
  }
  return top as unknown as Omit<TreePayload, 'roots'>
}

// Python sorts Unicode code points; localeCompare and UTF-16 order disagree.
function textOrder(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (order) return order
  }
  return x.length - y.length
}

/** Bodies are set-independent Python display values. Topology/counts are
 * projected from the DISTINCT held records, including subscription-only seats.
 */
export function projectTree(records: RecordTable, inputs: TreeRecordInputs = {}): TreePayload {
  const top = header(records)
  const nodes = records.get('agent') ?? new Map()
  agentRecordIds(records)
  const children = new Map<string | null, string[]>()
  const heldRetired = new Map<string | null, number>()
  for (const [id, body] of nodes) {
    const row = body as AgentRecord
    if (!row || typeof row.id !== 'string'
        || !(row.parent_id === null || typeof row.parent_id === 'string'))
      throw new Error('Feed agent is missing its parent link')
    if (!(row.state === 'archived' && row.successor)) {
      const siblings = children.get(row.parent_id) ?? []
      siblings.push(id)
      children.set(row.parent_id, siblings)
    }
    if (row.state === 'archived' && !row.successor)
      heldRetired.set(row.parent_id, (heldRetired.get(row.parent_id) ?? 0) + 1)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => {
    const x = nodes.get(a) as AgentRecord, y = nodes.get(b) as AgentRecord
    return (x.ui_order ?? x.sibling_order ?? 0) - (y.ui_order ?? y.sibling_order ?? 0)
      || textOrder(x.created ?? '', y.created ?? '')
      || (x.ord ?? 0) - (y.ord ?? 0) || textOrder(x.id, y.id)
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
    const { parent_id: _parent, sibling_order: _order, retired_children_total: total,
      ord: _ordinal, name: _name, ...fields } = row
    const parent = row.parent_id === null ? null : (nodes.get(row.parent_id) as AgentRecord | undefined)?.id ?? null
    const overlay: Readonly<Record<string, unknown>> = inputs.runtime?.get(id) ?? {}
    const { epoch: _epoch, seq: _seq, ask_linger_visible: linger, ...runtime } = overlay ?? {}
    return { ...fields, ...runtime, ...(linger === false ? { ask: null } : {}), parent,
      ...(total === undefined ? {} : { hidden_retired_children: hidden(total, heldRetired.get(id) ?? 0) }),
      children: (children.get(id) ?? []).map(build) } as TreeNode
  }
  const roots = (children.get(null) ?? []).map(build)
  const { retired_roots_total: total, ...fields } = top as typeof top & { retired_roots_total?: number }
  const groups = records.get('org')?.has('settings')
  return hydrateTree({ ...fields, roots,
    ...(inputs.netRuntime && top.net ? { net: { ...top.net, hubs: top.net.hubs.map(hub => {
      const live = (inputs.netRuntime!.hubs as Record<string, unknown>[]).find(row =>
        row.id === hub.id && row.address === hub.address)
      if (!live) return hub
      const { id: _id, address: _address, ...values } = live
      return { ...hub, ...values }
    }) } } : {}),
    ...(inputs.favourites ? {
      tiers: { ...inputs.favourites.tiers, ...top.tiers },
      models: { ...inputs.favourites.models, ...top.models },
    } : {}),
    ...(groups ? { foreground: { catalog_revision: inputs.cursor
      ? `${inputs.cursor.org_uuid}:${inputs.cursor.incarnation}:${inputs.cursor.rev}` : 'records',
      present: [...nodes.values()].map(body => (body as AgentRecord).id), missing: [],
      ...(total === undefined ? {} : { hidden_retired_roots: hidden(total, heldRetired.get(null) ?? 0) }),
      retired_total: (top as typeof top & { retired_total?: number }).retired_total } } : {}),
    ...(inputs.cursor ? { org_rev: inputs.cursor.rev } : {}),
  } as TreePayload)
}

function hidden(total: number, held: number): number {
  if (!Number.isSafeInteger(total) || total < held) throw new Error('Feed retired count disagrees with held records')
  return total - held
}

export function projectOrgs(records: RecordTable): OrgListEntry[] {
  return [...(records.get('registry_org')?.values() ?? [])] as OrgListEntry[]
}

export type AgentRecord = Omit<TreeNode, 'children'> & { parent_id: string | null; sibling_order?: number
  created?: string; ord?: number; name?: string; retired_children_total?: number; successor?: string | null }
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

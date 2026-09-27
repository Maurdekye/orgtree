/** Selected tree transport. This is opt-in until every consumer understands
 * omission: only missing_requested / lookup found=false proves absence. */
import { hydrateTree } from './archived'
import type { TreeNode, TreePayload } from './types'

export const FOREGROUND_TREE_FORMAT = 'orgtree.foreground-tree/v1' as const
export type FlatTreeNode = Omit<TreeNode, 'children' | 'lineage'> & {
  children: string[]; parent: string | null; axis: 'org' | 'lineage'
  hidden_retired_children: number; lineage_loaded: false
  predecessor: string | null; successor: string | null
}
type Boundary = { format: typeof FOREGROUND_TREE_FORMAT; revision: string
  catalog_revision: string; org_rev: number; sync_rev: number }
export type ForegroundSnapshot = Boundary & { kind: 'snapshot'
  nodes: Record<string, FlatTreeNode>; roots: string[]; missing_requested: string[]
  header: Omit<TreePayload, 'roots' | 'sync_rev' | 'org_rev'> & {
    hidden_retired_roots: number; retired_total: number }
}
type Change = { set: Record<string, unknown>; unset: string[] }
export type ForegroundDelta = Boundary & { kind: 'delta'; base: string
  nodes: Record<string, Change>; removed: string[]; header: Change
  roots: string[]; missing_requested: string[] }
export type ForegroundPage = Boundary & { kind: 'page'; nodes: Record<string, FlatTreeNode>
  matches: string[]; next_cursor: string | null }
export type ForegroundLookup = Boundary & { kind: 'lookup'; nodes: Record<string, FlatTreeNode>
  requested: string; found: boolean; path: string[] }
export type ForegroundRead = { tree: TreePayload; snapshot: ForegroundSnapshot | null }
type Read = (path: string, etag?: string) => Promise<Response>

export class ForegroundControl extends Error {
  constructor(public kind: 'reset' | 'compatibility') { super(`Foreground tree ${kind}`) }
}
class DeltaBaseError extends Error {}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(id => typeof id === 'string')
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function boundary(value: unknown): asserts value is Boundary & Record<string, unknown> {
  if (!record(value) || value.format !== FOREGROUND_TREE_FORMAT
      || typeof value.revision !== 'string' || typeof value.catalog_revision !== 'string'
      || !Number.isSafeInteger(value.org_rev) || Number(value.org_rev) < 0
      || !Number.isSafeInteger(value.sync_rev) || Number(value.sync_rev) < 0) {
    throw new Error('Invalid foreground tree boundary')
  }
}
function change(old: Record<string, unknown>, patch: Change): Record<string, unknown> {
  if (!record(patch) || !record(patch.set) || !strings(patch.unset)) {
    throw new Error('Invalid foreground tree patch')
  }
  const result = { ...old, ...patch.set }
  for (const key of patch.unset) delete result[key]
  return result
}

/** Never inserts lineage rows into the organization axis. Validate all rows,
 * including off-axis identities, before returning any usable tree. */
export function projectForeground(snapshot: ForegroundSnapshot): TreePayload {
  if (!record(snapshot.nodes) || !record(snapshot.header) || !strings(snapshot.roots)
      || !strings(snapshot.missing_requested)) throw new Error('Invalid foreground tree snapshot')
  const nodes = snapshot.nodes
  const ancestors = new Set<string>()
  for (const [id, row] of Object.entries(nodes)) {
    if (!record(row) || row.id !== id || !strings(row.children)
        || !['org', 'lineage'].includes(row.axis)
        || (row.parent !== null && typeof row.parent !== 'string')) {
      throw new Error('Invalid foreground tree node')
    }
    const seen = new Set<string>()
    let at: string | null = id
    while (at && !ancestors.has(at)) {
      if (seen.has(at)) throw new Error('Foreground tree parent cycle')
      seen.add(at)
      const ancestor: FlatTreeNode | undefined = nodes[at]
      if (!ancestor) throw new Error('Foreground tree missing ancestor')
      at = ancestor.parent
    }
    for (const id of seen) ancestors.add(id)
  }
  const visited = new Set<string>()
  const build = (id: string, parent: string | null): TreeNode => {
    if (visited.has(id)) throw new Error('Foreground tree cycle or duplicate child')
    const row = nodes[id]
    if (!row || row.axis !== 'org' || row.parent !== parent) {
      throw new Error('Foreground tree missing node or inconsistent parent')
    }
    visited.add(id)
    // Like archived summaries, this is a deliberately partial TreeNode.
    // lineage_loaded=false remains present: activation must teach lineage
    // consumers to resolve it, never manufacture an empty historical array.
    return { ...row, children: row.children.map(child => build(child, id)) } as unknown as TreeNode
  }
  const roots = snapshot.roots.map(id => build(id, null))
  if (Object.values(nodes).some(row => row.axis === 'org' && !visited.has(row.id))) {
    throw new Error('Foreground tree unreachable organization node')
  }
  if (snapshot.missing_requested.some(id => id in nodes)) {
    throw new Error('Foreground tree contradicts requested absence')
  }
  return hydrateTree({ ...snapshot.header, roots,
    sync_rev: snapshot.sync_rev, org_rev: snapshot.org_rev })
}

export function decodeForeground(wire: ForegroundSnapshot | ForegroundDelta,
                                 base?: ForegroundSnapshot): ForegroundSnapshot {
  boundary(wire)
  let result: ForegroundSnapshot
  if (wire.kind === 'snapshot') result = wire
  else if (wire.kind === 'delta') {
    if (!base || base.revision !== wire.base) throw new DeltaBaseError('Foreground delta has no exact base')
    if (!record(wire.nodes) || !strings(wire.removed)) throw new Error('Invalid foreground delta')
    const nodes = { ...base.nodes }
    for (const id of wire.removed) delete nodes[id]
    for (const [id, patch] of Object.entries(wire.nodes)) {
      nodes[id] = change(nodes[id] ?? {}, patch) as FlatTreeNode
    }
    result = { ...wire, kind: 'snapshot', nodes,
      header: change(base.header, wire.header) as ForegroundSnapshot['header'] }
  } else throw new Error('Unexpected foreground tree response')
  // Validation is shared with consumers; no malformed partial answer escapes.
  projectForeground(result)
  return result
}

async function answer(response: Response): Promise<unknown> {
  const body = await response.json()
  if (response.status === 409 && (body.kind === 'reset' || body.kind === 'compatibility')) {
    throw new ForegroundControl(body.kind)
  }
  if (!response.ok) throw new Error(body.detail || `Foreground request failed (${response.status})`)
  return body
}

/** At most one selected graph per org, at most eight orgs. Changing include
 * replaces the retained graph instead of caching every historical visit. */
export class ForegroundTreeReader {
  private cache = new Map<string, { key: string; etag: string; value: ForegroundRead }>()
  private pending = new Map<string, Promise<ForegroundRead>>()
  private owners = new Map<string, Promise<ForegroundRead>>()
  private generation = 0
  constructor(private read: Read, private legacy: (org: string) => Promise<TreePayload>) {}

  invalidate(): void { ++this.generation; this.cache.clear(); this.pending.clear(); this.owners.clear() }

  get(org: string, include: readonly string[] = []): Promise<ForegroundRead> {
    const names = [...new Set(include)].sort()
    const key = JSON.stringify([org, names])
    const waiting = this.pending.get(key)
    if (waiting) return waiting
    const generation = this.generation
    const cached = this.cache.get(org)
    let hit = cached?.key === key ? cached : undefined
    let task!: Promise<ForegroundRead>
    task = (async () => {
      // Preserve explicit surfaces beyond the server's selection limit.
      if (names.length <= 128) for (let attempt = 0; attempt < 2; ++attempt) {
        try {
          const query = names.map(id => `include=${encodeURIComponent(id)}`).join('&')
          const response = await this.read(`/api/orgs/${encodeURIComponent(org)}/foreground-tree`
            + (query ? '?' + query : ''), hit?.etag)
          if (response.status === 304) {
            if (!hit?.value.snapshot) throw new DeltaBaseError('Foreground304 has no cached base')
            const before = hit.value.snapshot
            const catalog = response.headers.get('X-Orgtree-Catalog-Rev')
            if (catalog && catalog !== before.catalog_revision) throw new DeltaBaseError('Foreground304 changed catalog')
            let snapshot = before
            for (const [header, field] of [['X-Orgtree-Sync-Rev', 'sync_rev'], ['X-Orgtree-Org-Rev', 'org_rev']] as const) {
              const value = response.headers.get(header)
              if (value === null) continue
              const rev = Number(value)
              if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('Invalid foreground watermark')
              if (rev !== snapshot[field]) snapshot = { ...snapshot, [field]: rev }
            }
            const value = snapshot === before ? hit.value : { snapshot, tree: projectForeground(snapshot) }
            this.remember(org, key, hit.etag, value, generation, task)
            return value
          }
          const snapshot = decodeForeground(await answer(response) as ForegroundSnapshot | ForegroundDelta,
            hit?.value.snapshot ?? undefined)
          const value = { snapshot, tree: projectForeground(snapshot) }
          const etag = response.headers.get('ETag')
          if (etag) this.remember(org, key, etag, value, generation, task)
          else if (generation === this.generation && this.owners.get(org) === task) this.cache.delete(org)
          return value
        } catch (error) {
          if (error instanceof ForegroundControl && error.kind === 'compatibility') break
          if (error instanceof DeltaBaseError || error instanceof ForegroundControl && error.kind === 'reset') {
            hit = undefined
            continue
          }
          throw error
        }
      }
      // Full compatibility answers are owned by their mounted caller only.
      if (generation === this.generation && this.owners.get(org) === task) this.cache.delete(org)
      return { snapshot: null, tree: await this.legacy(org) }
    })().finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key)
      if (this.owners.get(org) === task) this.owners.delete(org)
    })
    this.pending.set(key, task)
    this.owners.set(org, task)
    return task
  }

  private remember(org: string, key: string, etag: string, value: ForegroundRead,
                   generation: number, task: Promise<ForegroundRead>) {
    if (generation !== this.generation || this.pending.get(key) !== task || this.owners.get(org) !== task) return
    this.cache.delete(org); this.cache.set(org, { key, etag, value })
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
  }

  async lookup(org: string, id: string): Promise<ForegroundLookup> {
    const body = await answer(await this.read(`/api/orgs/${encodeURIComponent(org)}/foreground-tree/lookup/${encodeURIComponent(id)}`))
    boundary(body)
    if (body.kind !== 'lookup' || body.requested !== id || typeof body.found !== 'boolean'
        || !record(body.nodes) || !strings(body.path)
        || body.found !== Object.hasOwn(body.nodes, id)) throw new Error('Invalid foreground lookup')
    return body as ForegroundLookup
  }

  async page(org: string, kind: 'children' | 'search', query: string,
             cursor = '', state?: 'live' | 'archived' | 'unrecoverable', limit = 100): Promise<ForegroundPage> {
    const params = new URLSearchParams({ [kind === 'children' ? 'parent' : 'q']: query, limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    if (state) params.set('state', state)
    const body = await answer(await this.read(`/api/orgs/${encodeURIComponent(org)}/foreground-tree/${kind}?${params}`))
    boundary(body)
    if (body.kind !== 'page' || !record(body.nodes) || !strings(body.matches)
        || !(body.next_cursor === null || typeof body.next_cursor === 'string')
        || body.matches.some(id => !Object.hasOwn(body.nodes as object, id))) throw new Error('Invalid foreground page')
    return body as ForegroundPage
  }
}

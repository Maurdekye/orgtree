import type { FeedRecord, RecordTable } from './recordfeed'

export interface RecordKey { entity: string; id: string; set?: string }
export interface SetReplacement { set: string; records: FeedRecord[] }
export type Memberships = ReadonlyMap<string, ReadonlySet<string>>
const keyOf = (row: RecordKey) => {
  if (typeof row.entity !== 'string' || !row.entity || typeof row.id !== 'string' || !row.id)
    throw new Error('Invalid feed record key')
  return JSON.stringify([row.entity, row.id])
}
export const recordSet = (name = 'shared'): string => {
  if (name !== 'shared' && !/^sub:(0|[1-9][0-9]*)$/.test(name))
    throw new Error('Invalid record set')
  if (name !== 'shared' && !Number.isSafeInteger(Number(name.slice(4))))
    throw new Error('Invalid subscription generation')
  return name
}

/** Persistent state: membership belongs to sets; a body belongs to its record.
 * Build a candidate, project it, then publish it. A failed projection leaves
 * the previous memberships and bodies intact.
 */
export class RecordStore {
  constructor(readonly records: RecordTable = new Map(),
    readonly memberships: Memberships = new Map()) {}

  change(upserts: FeedRecord[], tombstones: RecordKey[] = [],
    replacements: SetReplacement[] = [], allowed: (set: string) => boolean = () => true): RecordStore {
    const holds = new Map(this.memberships)
    const touched = new Map<string, Set<string>>()
    const bodies = new Map<string, FeedRecord>()
    const members = (name: string) => {
      let ids = touched.get(name)
      if (!ids) { ids = new Set(holds.get(name)); touched.set(name, ids); holds.set(name, ids) }
      return ids
    }
    const insert = (row: FeedRecord, set: string) => {
      const key = keyOf(row)
      members(set).add(key)
      bodies.set(key, row)
    }
    const replaced = new Set<string>()
    for (const replacement of replacements) {
      const set = recordSet(replacement.set)
      if (replaced.has(set)) throw new Error('Duplicate set replacement')
      replaced.add(set)
      if (!allowed(set)) continue
      const ids = new Set<string>()
      touched.set(set, ids); holds.set(set, ids)
      for (const row of replacement.records) {
        if (row.set !== undefined && row.set !== set) throw new Error('Replacement has a different set')
        insert(row, set)
      }
    }
    for (const row of upserts) {
      const set = recordSet(row.set)
      if (allowed(set)) insert(row, set)
    }
    for (const row of tombstones) {
      const set = recordSet(row.set)
      if (allowed(set)) members(set).delete(keyOf(row))
    }
    const retained = new Set<string>()
    for (const ids of holds.values()) for (const key of ids) retained.add(key)
    const next = new Map<string, Map<string, unknown>>()
    for (const [entity, rows] of this.records) {
      const kept = new Map<string, unknown>()
      for (const [id, body] of rows) if (retained.has(keyOf({ entity, id }))) kept.set(id, body)
      next.set(entity, kept)
    }
    for (const [key, row] of bodies) if (retained.has(key)) {
      const rows = next.get(row.entity) ?? new Map<string, unknown>()
      rows.set(row.id, row.body); next.set(row.entity, rows)
    }
    return new RecordStore(next, holds)
  }

  drop(set: string): RecordStore {
    recordSet(set)
    const holds = new Map(this.memberships)
    holds.delete(set)
    return new RecordStore(this.records, holds).change([])
  }
}

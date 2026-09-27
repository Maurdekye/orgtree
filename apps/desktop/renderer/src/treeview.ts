/** Opt-in selected-view assembly. All rows published to consumers come from
 * one final snapshot; paging contributes identities, never mixed row bodies. */
import { ForegroundControl } from './foregroundtree'
import type { ForegroundRead, ForegroundSnapshot, ForegroundTreeReader } from './foregroundtree'
import type { TreePayload } from './types'

export type TreeBrowse = { kind: 'children'; parent: string }
  | { kind: 'search'; query: string; state?: 'live' | 'archived' | 'unrecoverable' }
  | { kind: 'all' }
export type TreeSelection = {
  include: readonly string[]
  hideRetired: boolean
  /** Org-axis parent id; the empty string denotes roots. */
  fronts: Readonly<Record<string, string>>
  browse?: TreeBrowse | null
}
type Reader = Pick<ForegroundTreeReader, 'get' | 'page'>
type Plan = { key: string; catalog: string; include: string[] }
const identity = (s: TreeSelection) => JSON.stringify([
  [...new Set(s.include)].sort(), s.hideRetired,
  Object.entries(s.fronts).sort(([a], [b]) => a.localeCompare(b)), s.browse ?? null,
])
const coherent = (catalog: string, got: { catalog_revision: string }) => {
  if (catalog !== got.catalog_revision) throw new ForegroundControl('reset')
}

/** The only retained history is the current selection plan for eight orgs.
 * Closing a browser changes its key and releases that browser's identities.
 * In-flight older selections cannot reinstall their plan after a newer one. */
export class TreeViewReader {
  private plans = new Map<string, Plan>()
  private owners = new Map<string, object>()
  constructor(private reader: Reader, private legacy: (org: string) => Promise<TreePayload>) {}

  clear(): void { this.plans.clear(); this.owners.clear() }

  async get(org: string, selection: TreeSelection): Promise<ForegroundRead> {
    // Copy caller-owned collections before awaiting network work.
    const selected: TreeSelection = { ...selection, include: [...selection.include],
      fronts: { ...selection.fronts }, browse: selection.browse && { ...selection.browse } }
    const key = identity(selected)
    const owner = {}
    this.owners.set(org, owner)
    const previous = this.plans.get(org)
    const plan = previous?.key === key ? previous : undefined
    if (!plan) this.plans.delete(org)
    const full = async (): Promise<ForegroundRead> => {
      if (this.owners.get(org) === owner) this.plans.delete(org)
      return { snapshot: null, tree: await this.legacy(org) }
    }
    try {
      // Opening the full archived switchboard explicitly requests all rows.
      if (selected.browse?.kind === 'all') return await full()
      for (let attempt = 0; attempt < 2; ++attempt) {
        try {
          const requested = new Set(selected.include)
          // Saved fronts are explicit protected choices, not a cache of visits.
          if (!selected.hideRetired) Object.values(selected.fronts).forEach(id => requested.add(id))
          if (requested.size > 128) return await full()
          let answer = await this.reader.get(org, attempt === 0 && plan ? plan.include : [...requested])
          if (!answer.snapshot) return answer
          if (attempt === 0 && plan?.catalog === answer.snapshot.catalog_revision) return answer
          // A changed catalog invalidates old default fronts. Start from only
          // explicit targets so a previously fronted branch cannot retain
          // descendants after a different retiree becomes the front.
          if (attempt === 0 && plan) answer = await this.reader.get(org, [...requested])
          if (!answer.snapshot) return answer
          const catalog = answer.snapshot.catalog_revision
          if (selected.browse) {
            const browse = selected.browse
            let cursor = ''
            const cursors = new Set<string>()
            do {
              const page = browse.kind === 'children'
                ? await this.reader.page(org, 'children', browse.parent, cursor)
                : await this.reader.page(org, 'search', browse.query, cursor, browse.state)
              coherent(catalog, page)
              page.matches.forEach(id => requested.add(id))
              if (requested.size > 128) return await full()
              cursor = page.next_cursor ?? ''
              if (cursor && cursors.has(cursor)) throw new Error('Repeated foreground cursor')
              cursors.add(cursor)
            } while (cursor)
          }
          if (selected.hideRetired) {
            // One coherent read drops any previous closed browser contents.
            answer = await this.reader.get(org, [...requested])
            if (answer.snapshot) coherent(catalog, answer.snapshot)
          } else {
            const resolved = new Set<string>()
            // New front rows may themselves have visible retired-child piles.
            for (;;) {
              const snapshot = answer.snapshot!
              const parents = this.visibleParents(snapshot, selected.fronts)
                .filter(parent => !resolved.has(parent))
              for (const parent of parents) {
                resolved.add(parent)
                // The FIRST sibling anchors pile position among live siblings;
                // the LAST sibling is its default front. Both reads are O(1).
                const first = await this.reader.page(org, 'children', parent, '', undefined, 1)
                coherent(catalog, first)
                first.matches.forEach(id => requested.add(id))
                const saved = selected.fronts[parent]
                const row = saved ? snapshot.nodes[saved] : undefined
                if (!row || row.axis !== 'org' || row.state !== 'archived' || (row.parent ?? '') !== parent) {
                  const last = await this.reader.page(org, 'children', parent, '', undefined, 1, 'last')
                  coherent(catalog, last)
                  last.matches.forEach(id => requested.add(id))
                }
              }
              if (requested.size > 128) return await full()
              const next = await this.reader.get(org, [...requested])
              if (!next.snapshot) return next
              coherent(catalog, next.snapshot)
              answer = next
              if (!this.visibleParents(next.snapshot, selected.fronts).some(parent => !resolved.has(parent))) break
            }
          }
          if (answer.snapshot && this.owners.get(org) === owner) {
            this.plans.delete(org)
            this.plans.set(org, { key, catalog, include: [...requested] })
            while (this.plans.size > 8) this.plans.delete(this.plans.keys().next().value!)
          }
          return answer
        } catch (error) {
          if (error instanceof ForegroundControl) {
            if (error.kind === 'compatibility') return await full()
            continue
          }
          throw error
        }
      }
      // Catalog churn cannot publish a graph assembled across revisions.
      return await full()
    } finally {
      if (this.owners.get(org) === owner) this.owners.delete(org)
    }
  }

  private visibleParents(snapshot: ForegroundSnapshot, fronts: TreeSelection['fronts']): string[] {
    const result: string[] = []
    const walk = (ids: string[], parent: string, omitted: number) => {
      const rows = ids.map(id => snapshot.nodes[id]!)
      const retired = rows.filter(row => row.state === 'archived')
      if (omitted + retired.length > 0) result.push(parent)
      const saved = fronts[parent]
      const front = retired.find(row => row.id === saved) ?? retired[retired.length - 1]
      for (const row of rows) {
        if (row.state === 'archived' && row !== front) continue
        walk(row.children, row.id, row.hidden_retired_children)
      }
    }
    walk(snapshot.roots, '', snapshot.header.hidden_retired_roots)
    return result
  }
}

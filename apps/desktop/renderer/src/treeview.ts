/** Opt-in selected-view assembly. All rows published to consumers come from
 * one final snapshot; paging contributes identities, never mixed row bodies. */
import { ForegroundControl } from './foregroundtree'
import type { ForegroundRead, ForegroundTreeReader } from './foregroundtree'
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
type Plan = { key: string; rest: string; catalog: string; include: string[]; covered: ReadonlySet<string> }
const identity = (s: TreeSelection) => JSON.stringify([
  [...new Set(s.include)].sort(), s.hideRetired,
  Object.entries(s.fronts).sort(([a], [b]) => a.localeCompare(b)), s.browse ?? null,
])
/** Everything but the protected IDs: a plan whose rows already carry every
 * requested ID answers the same question without re-planning. */
const rest = (s: TreeSelection) => JSON.stringify([s.hideRetired,
  Object.entries(s.fronts).sort(([a], [b]) => a.localeCompare(b)), s.browse ?? null])
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
    // A camera focus usually lands on a card already on screen. When every
    // requested ID is already carried by the current plan, keep that plan
    // (and its conditional-read base) instead of re-reading its edges.
    const wanted = [...selected.include, ...(selected.hideRetired ? [] : Object.values(selected.fronts))]
    const plan = previous && (previous.key === key
      || (previous.rest === rest(selected) && wanted.every(id => previous.covered.has(id)))) ? previous : undefined
    if (!plan) this.plans.delete(org)
    const full = async (): Promise<ForegroundRead> => {
      if (this.owners.get(org) === owner) this.plans.delete(org)
      return { snapshot: null, tree: await this.legacy(org) }
    }
    try {
      // Opening the full archived switchboard explicitly requests all rows.
      if (selected.browse?.kind === 'all') return await full()
      // Shown retired piles: the server selects every visible pile's first
      // row (its position among live siblings) and default-front row in the
      // same snapshot, so they never enter `requested` or its 128 limit.
      const piles = selected.hideRetired ? undefined : selected.fronts
      for (let attempt = 0; attempt < 2; ++attempt) {
        try {
          const requested = new Set(selected.include)
          // Saved fronts are explicit protected choices, not a cache of visits.
          if (!selected.hideRetired) Object.values(selected.fronts).forEach(id => requested.add(id))
          if (requested.size > 128) return await full()
          let answer = await this.reader.get(org, attempt === 0 && plan ? plan.include : [...requested], piles)
          if (!answer.snapshot) return answer
          if (attempt === 0 && plan?.catalog === answer.snapshot.catalog_revision) return answer
          // A changed catalog invalidates the old plan: read from only the
          // explicit targets (the server re-resolves every pile).
          if (attempt === 0 && plan && (plan.include.length !== requested.size
              || plan.include.some(id => !requested.has(id)))) {
            answer = await this.reader.get(org, [...requested], piles)
          }
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
              // An explicit browser beyond the selection limit keeps every
              // identity through the whole compatibility read.
              if (requested.size > 128) return await full()
              cursor = page.next_cursor ?? ''
              if (cursor && cursors.has(cursor)) throw new Error('Repeated foreground cursor')
              cursors.add(cursor)
            } while (cursor)
            // One coherent read of the browsed identities.
            answer = await this.reader.get(org, [...requested], piles)
            if (answer.snapshot) coherent(catalog, answer.snapshot)
          }
          if (answer.snapshot && this.owners.get(org) === owner) {
            this.plans.delete(org)
            this.plans.set(org, { key, rest: rest(selected), catalog, include: [...requested],
              covered: new Set([...requested, ...Object.keys(answer.snapshot.nodes)]) })
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
}

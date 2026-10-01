/** Exact identity facts for agents a partial tree does not carry.
 * An answer is valid only for the catalog it was read from: a caller asks with
 * its tree's catalog and never sees an answer about a different graph. */
import { MAX_REFERENCES } from './foregroundtree'
import type { AgentReference, ForegroundReferences } from './foregroundtree'

export type ReferenceState = { catalog: string; ref: AgentReference | null } | { catalog: string; error: true }
  /** Asked for this catalog, answered for another (the tree lags or leads the
   * server). Not an answer about this tree, and not to be asked again for it. */
  | { catalog: string; stale: true }
type Stored = ReferenceState & { asked: string }
type Fetch = (org: string, ids: readonly string[]) => Promise<ForegroundReferences>

/** Bounded: at most `perOrg` identities for each of eight orgs. Nothing here
 * is a whole-history index; only IDs a mounted surface asked about. */
export class AgentReferences {
  private orgs = new Map<string, Map<string, Stored>>()
  private inflight = new Set<string>()
  private listeners = new Set<() => void>()
  constructor(private fetch: Fetch, private perOrg = 512) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  get(org: string, catalog: string, id: string): ReferenceState | undefined {
    const known = this.orgs.get(org)?.get(id)
    if (!known) return undefined
    if (known.catalog === catalog) return known
    return known.asked === catalog ? { catalog, stale: true } : undefined
  }

  /** Starts reads for IDs not yet answered for this catalog. Failures are
   * remembered as errors for this catalog only, never as absence. */
  request(org: string, catalog: string, ids: readonly string[]): void {
    const wanted = [...new Set(ids)].filter(id => id && !this.get(org, catalog, id)
      && !this.inflight.has(JSON.stringify([org, catalog, id])))
    for (let at = 0; at < wanted.length; at += MAX_REFERENCES) {
      const batch = wanted.slice(at, at + MAX_REFERENCES)
      const keys = batch.map(id => JSON.stringify([org, catalog, id]))
      keys.forEach(key => this.inflight.add(key))
      this.fetch(org, batch).then(answer => {
        const got = answer.catalog_revision
        for (const id of batch) {
          this.store(org, id, { catalog: got, ref: answer.references[id] ?? null, asked: catalog })
        }
      }, () => {
        for (const id of batch) this.store(org, id, { catalog, error: true, asked: catalog })
      }).finally(() => {
        keys.forEach(key => this.inflight.delete(key))
        this.listeners.forEach(fn => fn())
      })
    }
  }

  private store(org: string, id: string, state: Stored): void {
    let entries = this.orgs.get(org)
    if (!entries) entries = new Map()
    this.orgs.delete(org); this.orgs.set(org, entries)
    while (this.orgs.size > 8) this.orgs.delete(this.orgs.keys().next().value!)
    entries.delete(id); entries.set(id, state)
    while (entries.size > this.perOrg) entries.delete(entries.keys().next().value!)
  }
}

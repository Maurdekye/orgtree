import type { FeedCursor, RecordSession, SubscriptionInput } from './recordfeed'
import type { TreeSelection } from './treeview'

export type SelectionRequest = { names: string[]; search?: { query: string; state?: string } }
export type SelectionAnswer = { cursor: FeedCursor; names: Record<string, string>; missing: string[]; matches: string[] }
const identity = (c: FeedCursor) => JSON.stringify([c.org_uuid, c.incarnation])
const id = (s: unknown): s is string => typeof s === 'string' && /^[1-9][0-9]*$/.test(s) && BigInt(s) < 2n ** 63n

/** Mounted tree surfaces declare UI names. Only the snapshot resolver converts
 * them to stable keys; socket sets own all bodies, paging and subsequent edits.
 * A search is evaluated once per query/identity, not on every org revision. */
export class RecordTreeSelection {
  private wanted: TreeSelection | null = null
  private key = ''
  private serial = 0
  private dead = false
  private busy = false
  private lastAttempt = ''
  private accepted = ''
  private own = ''
  private missing = false
  private search: { key: string; ids: string[] } | null = null
  private pending: { answer: SelectionAnswer; serial: number; searchKey: string } | null = null
  private sets = new Map<string, () => void>()
  private off: () => void
  constructor(private feed: RecordSession,
    private resolve: (request: SelectionRequest) => Promise<SelectionAnswer>,
    private recover: () => void, private error: (error: Error) => void) {
    this.off = feed.listen(() => this.changed())
  }

  set(selection: TreeSelection): void {
    const copy = structuredClone(selection), key = JSON.stringify(copy)
    if (key === this.key) return
    this.wanted = copy; this.key = key; this.serial++
    this.pending = null; this.lastAttempt = ''; this.accepted = ''
    this.changed()
  }

  private changed(): void {
    if (this.dead || !this.wanted) return
    const view = this.feed.getSnapshot()
    if (!view) return
    const c = view.cursor, own = identity(c), wanted = `${this.serial}:${own}`
    if (this.own !== own) {
      this.own = own; this.accepted = ''; this.pending = null; this.search = null; this.lastAttempt = ''
      // A replacement may reuse numeric IDs. Drop declarations for its previous
      // incarnation before a delayed name lookup can arrive.
      const releases = [...this.sets.values()]
      this.sets.clear()
      const busy = this.busy
      this.busy = true
      try { releases.forEach(release => release()) } finally { this.busy = busy }
    }
    if (this.busy) return
    if (this.pending) {
      const p = this.pending
      if (p.serial !== this.serial || identity(p.answer.cursor) !== own || p.answer.cursor.rev < c.rev) this.pending = null
      else if (p.answer.cursor.rev === c.rev) {
        this.pending = null; this.apply(p.answer, wanted, p.searchKey); return
      } else return // The stream must catch up before a declaration is installed.
    }
    if (this.accepted === wanted && !this.missing) return
    const attempt = `${wanted}:${c.rev}`
    if (this.lastAttempt === attempt) return
    this.lastAttempt = attempt
    const s = this.wanted, names = new Set(s.include)
    if (!s.hideRetired) Object.values(s.fronts).forEach(name => names.add(name))
    if (s.browse?.kind === 'children' && s.browse.parent) names.add(s.browse.parent)
    const searchKey = JSON.stringify([own, s.browse?.kind === 'search' ? s.browse : null])
    const request: SelectionRequest = { names: [...names].sort() }
    if (s.browse?.kind === 'search' && this.search?.key !== searchKey)
      request.search = { query: s.browse.query, ...(s.browse.state ? { state: s.browse.state } : {}) }
    const serial = this.serial
    this.busy = true
    void this.resolve(request).then(answer => {
      if (this.dead || serial !== this.serial) return
      if (!answer || !answer.cursor || !Number.isSafeInteger(answer.cursor.rev) || answer.cursor.rev < 0
          || typeof answer.cursor.org_uuid !== 'string' || !answer.cursor.org_uuid
          || typeof answer.cursor.incarnation !== 'string' || !answer.cursor.incarnation
          || !answer.names || Array.isArray(answer.names) || typeof answer.names !== 'object'
          || Object.entries(answer.names).some(([name, key]) => !names.has(name) || !id(key))
          || !Array.isArray(answer.missing) || answer.missing.some(name => !names.has(name))
          || !Array.isArray(answer.matches) || answer.matches.some(key => !id(key))
          || [...names].some(name => (Object.hasOwn(answer.names, name) ? 1 : 0)
            + (answer.missing.includes(name) ? 1 : 0) !== 1)) throw new Error('Invalid record selection answer')
      const current = this.feed.getSnapshot()?.cursor
      if (!current || identity(current) !== own || identity(answer.cursor) !== own) return
      if (answer.cursor.rev < current.rev) return
      this.pending = { answer: { ...answer, matches: request.search ? answer.matches : this.search?.key === searchKey ? this.search.ids : [] }, serial, searchKey }
      if (answer.cursor.rev > current.rev) this.recover()
    }).catch(e => {
      if (!this.dead && serial === this.serial) this.error(e instanceof Error ? e : new Error(String(e)))
    }).finally(() => {
      this.busy = false
      try { this.changed() } catch (e) { if (!this.dead) this.error(e instanceof Error ? e : new Error(String(e))) }
    })
  }

  private apply(answer: SelectionAnswer, wanted: string, searchKey: string): void {
    const s = this.wanted!, agents = [...new Set([...Object.values(answer.names), ...answer.matches])].sort()
    const windows: Record<string, unknown>[] = []
    if (s.browse?.kind === 'all') windows.push({ kind: 'archived_all' })
    if (s.browse?.kind === 'children') {
      const parent = s.browse.parent
        ? Object.hasOwn(answer.names, s.browse.parent) ? answer.names[s.browse.parent] : undefined : '0'
      if (parent) windows.push({ kind: 'archived_under', parent })
    }
    const inputs: SubscriptionInput[] = []
    for (let start = 0; start < agents.length; start += 128) inputs.push({ agents: agents.slice(start, start + 128) })
    if (windows.length) inputs.push({ windows })
    if (inputs.length > 128) throw new Error('Tree selection exceeds the record subscription bound')
    const desired = new Map(inputs.map(input => [JSON.stringify(input), input]))
    // Mark before release, whose synchronous publication calls our listener.
    this.accepted = wanted; this.missing = answer.missing.length > 0
    this.search = { key: searchKey, ids: answer.matches }
    this.busy = true
    try {
      for (const [key, release] of this.sets) if (!desired.has(key)) { this.sets.delete(key); release() }
      for (const [key, input] of desired) if (!this.sets.has(key)) this.sets.set(key, this.feed.subscribe(input))
    } finally { this.busy = false }
  }

  dispose(): void {
    this.dead = true; this.serial++; this.off()
    for (const release of this.sets.values()) release()
    this.sets.clear(); this.pending = null; this.search = null
  }
}

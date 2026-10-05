import type { RecordSession } from './recordfeed'
import type { SelectionAnswer, SelectionRequest } from './recordtreeselection'

const identity = (c: SelectionAnswer['cursor']) => JSON.stringify([c.org_uuid, c.incarnation])

/** Resolve a panel's UI name at the stream cursor, then retain its physical ID.
 * A replaced org must resolve again even when it reuses names or numeric IDs. */
export class RecordPanelSelection {
  private dead = false
  private busy = false
  private own = ''
  private accepted = false
  private attempted = ''
  private pending: SelectionAnswer | null = null
  private off: () => void
  retry = (): void => {
    if (this.dead || this.accepted || this.busy) return
    this.attempted = ''; this.pending = null
    this.publish(null, null)
    this.changed()
  }
  constructor(private feed: RecordSession, private name: string,
    private resolve: (request: SelectionRequest) => Promise<SelectionAnswer>,
    private publish: (id: string | null, error: Error | null) => void) {
    this.off = feed.listen(() => this.changed())
    this.changed()
  }
  private changed(): void {
    if (this.dead) return
    const cursor = this.feed.getSnapshot()?.cursor
    if (!cursor) { this.accepted = false; this.pending = null; this.own = ''; this.publish(null, null); return }
    const own = identity(cursor)
    if (own !== this.own) {
      this.own = own; this.accepted = false; this.pending = null; this.attempted = ''
      this.publish(null, null)
    }
    if (this.accepted || this.busy) return
    if (this.pending) {
      const answer = this.pending
      if (identity(answer.cursor) !== own || answer.cursor.rev < cursor.rev) this.pending = null
      else if (answer.cursor.rev > cursor.rev) return
      else {
        this.pending = null
        const id = answer.names[this.name]
        this.accepted = !!id
        this.publish(id ?? null, null)
        if (id) return
      }
    }
    const attempt = `${own}:${cursor.rev}`
    if (this.attempted === attempt) return
    this.attempted = attempt; this.busy = true
    void this.resolve({ names: [this.name] }).then(answer => {
      if (this.dead || this.own !== own) return
      const c = answer?.cursor, id = answer?.names?.[this.name]
      if (!c || !Number.isSafeInteger(c.rev) || c.rev < 0 || !c.org_uuid || !c.incarnation
          || (id !== undefined && (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || BigInt(id) >= 2n ** 63n))
          || !Array.isArray(answer.missing) || (id === undefined) !== answer.missing.includes(this.name))
        throw new Error('Invalid panel selection answer')
      if (identity(c) === own) {
        this.pending = answer
        const current = this.feed.getSnapshot()?.cursor
        if (current && c.rev > current.rev) return this.feed.reconnect?.(false)
      }
    }).catch(error => {
      if (!this.dead && this.own === own) this.publish(null, error instanceof Error ? error : new Error(String(error)))
    }).finally(() => { this.busy = false; this.changed() })
  }
  dispose(): void { this.dead = true; this.off() }
}

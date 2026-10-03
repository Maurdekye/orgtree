/** The §2.5 ordered pipeline. Each instance owns one stream and one identity. */
export interface FeedCursor { org_uuid: string; incarnation: string; rev: number }
export interface FeedRecord { entity: string; id: string; body: unknown }
export interface RecordSnapshot {
  type: 'record_snapshot'; cursor: FeedCursor; records: FeedRecord[]
}
export interface RecordChanges {
  type: 'record_changes'; org_uuid: string; incarnation: string
  from: number; to: number; upserts: FeedRecord[]
  tombstones: { entity: string; id: string }[]
}
export type FeedAnswer = RecordSnapshot | RecordChanges | { type: 'record_reset' }
export type RecordTable = ReadonlyMap<string, ReadonlyMap<string, unknown>>
const sameIdentity = (a: FeedCursor, b: Pick<FeedCursor, 'org_uuid' | 'incarnation'>) =>
  a.org_uuid === b.org_uuid && a.incarnation === b.incarnation
const revision = (n: number) => Number.isSafeInteger(n) && n >= 0
const identity = (c: Pick<FeedCursor, 'org_uuid' | 'incarnation'>) =>
  typeof c.org_uuid === 'string' && !!c.org_uuid
    && typeof c.incarnation === 'string' && !!c.incarnation

function changedTable(old: RecordTable, upserts: FeedRecord[],
  tombstones: RecordChanges['tombstones'] = []): RecordTable {
  const next = new Map(old)
  const touched = new Map<string, Map<string, unknown>>()
  const table = (entity: string, id: string) => {
    if (typeof entity !== 'string' || !entity || typeof id !== 'string' || !id)
      throw new Error('Invalid feed record key')
    let rows = touched.get(entity)
    if (!rows) { rows = new Map(old.get(entity)); touched.set(entity, rows); next.set(entity, rows) }
    return rows
  }
  for (const row of upserts) table(row.entity, row.id).set(row.id, row.body)
  for (const row of tombstones) table(row.entity, row.id).delete(row.id)
  return next
}

export interface FeedIO<T> {
  snapshot: () => Promise<RecordSnapshot>
  catchup: (cursor: FeedCursor) => Promise<FeedAnswer>
  /** Validate/project before publishing, so invalid frames never advance the cursor. */
  project: (records: RecordTable) => T
  /** HTTP start time confirms client overlays; live frames carry no confirmation. */
  publish: (value: T, records: RecordTable, cursor: FeedCursor, readStartedAt?: number) => void
  error: (error: Error) => void
}

export class RecordFeed<T> {
  cursor: FeedCursor | null = null
  records: RecordTable = new Map()
  private buffering = false
  private buffer: RecordChanges[] = []
  private generation = 0
  private disposed = false
  private recovery: Promise<void> | null = null
  private reconnectPending = false
  constructor(private io: FeedIO<T>) {}

  private commit(records: RecordTable, cursor: FeedCursor, readStartedAt = 0) {
    const value = this.io.project(records)
    this.records = records
    this.cursor = cursor
    this.io.publish(value, records, cursor, readStartedAt)
  }

  private baseline(answer: RecordSnapshot, readStartedAt = 0) {
    const c = answer.cursor
    if (!identity(c) || !revision(c.rev)) throw new Error('Invalid feed snapshot cursor')
    if (this.cursor && sameIdentity(this.cursor, c) && c.rev < this.cursor.rev) {
      if (readStartedAt) this.commit(this.records, this.cursor, readStartedAt)
      return
    }
    this.commit(changedTable(new Map(), answer.records), { ...c }, readStartedAt)
  }

  /** Snapshot and HTTP answers share this entry with websocket frames. */
  receive(answer: FeedAnswer, readStartedAt = 0): void {
    if (this.disposed) return
    try {
      if (answer.type === 'record_reset') { void this.resync(); return }
      if (answer.type === 'record_snapshot') { this.baseline(answer, readStartedAt); return }
      if (!identity(answer) || !revision(answer.from) || !revision(answer.to)
          || answer.to < answer.from) throw new Error('Invalid feed frame bounds')
      if (this.buffering || !this.cursor) {
        this.buffer.push(answer)
        if (this.buffer.length > 256) { this.buffer = []; void this.resync() }
        else if (!this.buffering) void this.resync()
        return
      }
      const c = this.cursor
      if (!sameIdentity(c, answer)) { void this.resync(); return }
      if (answer.to <= c.rev) {
        if (readStartedAt) this.commit(this.records, c, readStartedAt)
        return
      }
      if (answer.from > c.rev) { void this.reconnect(false); return }
      this.commit(changedTable(this.records, answer.upserts, answer.tombstones),
        { org_uuid: c.org_uuid, incarnation: c.incarnation, rev: answer.to }, readStartedAt)
    } catch (e) {
      this.io.error(e instanceof Error ? e : new Error(String(e)))
      if (!this.buffering) void this.resync()
    }
  }

  /** A replacement invalidates old HTTP responses, even under the same slug. */
  resync(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const run = ++this.generation
    const previousIdentity = this.cursor
    this.buffering = true
    this.recovery = null
    const readStartedAt = Date.now()
    return this.io.snapshot().then(answer => {
      if (this.disposed || run !== this.generation) return
      this.baseline(answer, readStartedAt)
      const pending = this.buffer
      this.buffer = []
      this.buffering = false
      for (const frame of pending) {
        // Frames from the replaced database are never replayed into its successor.
        if (this.cursor && sameIdentity(this.cursor, frame)) this.receive(frame)
        else if (!(previousIdentity && sameIdentity(previousIdentity, frame)
            && this.cursor && !sameIdentity(previousIdentity, this.cursor))) {
          // A replacement may have committed after the baseline took its
          // snapshot. Its first frame is enough to demand a new full load;
          // there need not be another write to reveal the stale identity.
          return this.resync()
        }
      }
      if (this.reconnectPending) {
        this.reconnectPending = false
        void this.reconnect()
      }
    }).catch(e => {
      if (this.disposed || run !== this.generation) return
      this.buffering = false
      this.io.error(e instanceof Error ? e : new Error(String(e)))
    })
  }

  /** Always catch up on a new connection: no later commit is needed to reveal loss. */
  reconnect(force = true): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.buffering) {
      if (force) this.reconnectPending = true
      return Promise.resolve()
    }
    if (!this.cursor) return this.resync()
    // Gap bursts coalesce. A new socket must ask again even if an older HTTP
    // snapshot is in flight: that snapshot may predate writes made while offline.
    if (this.recovery && !force) return this.recovery
    const run = this.generation
    const cursor = { ...this.cursor }
    const readStartedAt = Date.now()
    const pending = this.io.catchup(cursor).then(answer => {
      if (this.disposed || run !== this.generation) return
      this.receive(answer, readStartedAt)
    }).catch(e => {
      if (!this.disposed && run === this.generation)
        this.io.error(e instanceof Error ? e : new Error(String(e)))
    }).finally(() => { if (this.recovery === pending) this.recovery = null })
    this.recovery = pending
    return pending
  }

  dispose(): void { this.disposed = true; ++this.generation; this.buffer = [] }
}

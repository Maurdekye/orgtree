/** The §2.5 ordered pipeline. Each instance owns one stream and one identity. */
import { RecordStore } from './recordstore'
import type { Memberships, SetReplacement } from './recordstore'
import { RecordOverlay } from './recordoverlay'
import type { AgentRuntime, RuntimeTable, RuntimeValue } from './recordoverlay'

export interface FeedCursor { org_uuid: string; incarnation: string; rev: number }
export interface FeedRecord { entity: string; id: string; body: unknown; set?: string }
export interface RecordSnapshot {
  type: 'record_snapshot'; cursor: FeedCursor; records: FeedRecord[]; runtime?: AgentRuntime
}
export interface RecordChanges {
  type: 'record_changes'; org_uuid: string; incarnation: string
  from: number; to: number; upserts: FeedRecord[]
  tombstones: { entity: string; id: string; set?: string }[]
  replacements?: SetReplacement[]; runtime?: AgentRuntime
}
export type FeedAnswer = RecordSnapshot | RecordChanges | { type: 'record_reset' }
export interface RecordSubscribed extends FeedCursor {
  type: 'record_subscribed'; sub: number; records: FeedRecord[]
  page?: number; final?: boolean
}
export type RecordEvent = FeedAnswer | RecordSubscribed | AgentRuntime
export interface SubscriptionInput { agents?: string[]; windows?: Record<string, unknown>[] }
export interface SubscriptionDeclaration { sub: number; agents: string[]; windows: Record<string, unknown>[] }
export type SubscriptionMessage = ({ type: 'subscribe' } & SubscriptionDeclaration)
  | { type: 'unsubscribe'; sub: number }
export interface FeedState { cursor: FeedCursor; memberships: Memberships; runtime: RuntimeTable; netRuntime?: Readonly<RuntimeValue> | null }
export interface FeedView extends FeedState { records: RecordTable }
export interface RecordSession {
  getSnapshot: () => FeedView | null
  listen: (listener: () => void) => () => void
  subscribe: (input: SubscriptionInput, onReady?: (ready: boolean) => void) => () => void
}
export type RecordTable = ReadonlyMap<string, ReadonlyMap<string, unknown>>
const sameIdentity = (a: Pick<FeedCursor, 'org_uuid' | 'incarnation'>, b: Pick<FeedCursor, 'org_uuid' | 'incarnation'>) =>
  a.org_uuid === b.org_uuid && a.incarnation === b.incarnation
const revision = (n: number) => Number.isSafeInteger(n) && n >= 0
const identity = (c: Pick<FeedCursor, 'org_uuid' | 'incarnation'>) =>
  typeof c.org_uuid === 'string' && !!c.org_uuid
    && typeof c.incarnation === 'string' && !!c.incarnation

export interface FeedIO<T> {
  snapshot: () => Promise<RecordSnapshot>
  catchup: (cursor: FeedCursor, subscriptions: SubscriptionDeclaration[]) => Promise<FeedAnswer>
  /** Validate/project before publishing, so invalid frames never advance the cursor. */
  project: (records: RecordTable, state: FeedState) => T
  /** HTTP start time confirms client overlays; live frames carry no confirmation. */
  publish: (value: T, records: RecordTable, cursor: FeedCursor, readStartedAt?: number) => void
  error: (error: Error) => void
  /** A replacement needs a new socket's trusted host epoch, even at lower R. */
  identityChanged?: () => void
}

interface SubscriptionState {
  declaration: SubscriptionDeclaration; active: boolean; sent: boolean
  onReady?: (ready: boolean) => void
  pages?: { next: number; records: FeedRecord[]; keys: Set<string> }
}

export class RecordFeed<T> {
  cursor: FeedCursor | null = null
  records: RecordTable = new Map()
  private store = new RecordStore()
  private overlay: RecordOverlay | null = null
  private subscriptions = new Map<number, SubscriptionState>()
  private nextSubscription = 0
  private socketGeneration = 0
  private socketSend: ((message: SubscriptionMessage) => void) | null = null
  private firstSocketCopy = true
  private runtimeBuffer: { frame: AgentRuntime; trusted: boolean }[] = []
  private buffering = false
  private buffer: RecordChanges[] = []
  private generation = 0
  private disposed = false
  private recovery: Promise<void> | null = null
  private reconnectPending = false
  private gapTarget: FeedCursor | null = null
  private view: FeedView | null = null
  private listeners = new Set<() => void>()
  constructor(private io: FeedIO<T>) {}

  getSnapshot = (): FeedView | null => this.view
  listen = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get memberships(): Memberships { return this.store.memberships }
  get runtime(): RuntimeTable { return this.overlay?.values ?? new Map() }
  declarations(): SubscriptionDeclaration[] {
    return [...this.subscriptions.values()].map(s => structuredClone(s.declaration))
  }

  private commit(store: RecordStore, cursor: FeedCursor, readStartedAt = 0,
    overlay = this.overlay && sameIdentity(this.overlay.identity, cursor) ? this.overlay : new RecordOverlay(cursor)) {
    const state = { cursor, memberships: store.memberships, runtime: overlay.values, netRuntime: overlay.net }
    const value = this.io.project(store.records, state)
    this.store = store
    this.overlay = overlay
    this.records = store.records
    this.cursor = cursor
    this.view = { ...state, records: store.records }
    if (this.gapTarget && (!sameIdentity(cursor, this.gapTarget)
        || cursor.rev >= this.gapTarget.rev)) this.gapTarget = null
    this.io.publish(value, store.records, cursor, readStartedAt)
    for (const listener of [...this.listeners]) {
      try { listener() }
      catch (e) { this.io.error(e instanceof Error ? e : new Error(String(e))) }
    }
  }

  private allowed = (set: string) => set === 'shared'
    || [...this.subscriptions.values()].some(s => s.active && set === `sub:${s.declaration.sub}`)

  private sendPending() {
    if (!this.cursor || this.buffering || !this.socketSend) return
    for (const s of this.subscriptions.values()) if (!s.sent) {
      s.sent = true
      try { this.socketSend({ type: 'subscribe', ...structuredClone(s.declaration) }) }
      catch (e) { s.sent = false; throw e }
    }
  }

  private ready(s: SubscriptionState, value: boolean) {
    try { s.onReady?.(value) }
    catch (e) { this.io.error(e instanceof Error ? e : new Error(String(e))) }
  }

  private renew(s: SubscriptionState) {
    if (s.sent) this.socketSend?.({ type: 'unsubscribe', sub: s.declaration.sub })
    if (!Number.isSafeInteger(this.nextSubscription + 1)) throw new Error('Subscription generation exhausted')
    s.declaration = { ...s.declaration, sub: ++this.nextSubscription }
    s.active = false; s.sent = false
    this.ready(s, false)
    s.pages = undefined
  }

  /** The returned release drops this set immediately, even during an HTTP read. */
  subscribe(input: SubscriptionInput, onReady?: (ready: boolean) => void): () => void {
    if (this.disposed) throw new Error('Feed disposed')
    const agents = [...new Set(input.agents ?? [])], windows = structuredClone(input.windows ?? [])
    if (agents.some(id => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)
        || BigInt(id) >= 2n ** 63n) || windows.length > 128
        || windows.some(w => !w || typeof w !== 'object' || Array.isArray(w)))
      throw new Error('Invalid subscription declaration')
    if (agents.length > 128 || this.subscriptions.size >= 128) throw new Error('Subscription bound exceeded')
    const s = { declaration: { sub: 0, agents, windows }, active: false, sent: false, onReady }
    this.renew(s)
    const handle = s.declaration.sub
    this.subscriptions.set(handle, s)
    this.sendPending()
    return () => {
      if (!this.subscriptions.has(handle)) return
      const candidate = this.store.drop(`sub:${s.declaration.sub}`)
      if (this.cursor) this.commit(candidate, this.cursor)
      this.subscriptions.delete(handle)
      if (s.sent) this.socketSend?.({ type: 'unsubscribe', sub: s.declaration.sub })
    }
  }

  private dropSubscriptions() {
    let candidate = this.store
    for (const s of this.subscriptions.values()) candidate = candidate.drop(`sub:${s.declaration.sub}`)
    if (this.cursor && candidate !== this.store) this.commit(candidate, this.cursor)
    for (const s of this.subscriptions.values()) this.renew(s)
  }

  /** Fence frames from an old socket; only this socket's first full runtime establishes epoch. */
  socketOpened(send: (message: SubscriptionMessage) => void): number {
    if (this.disposed) throw new Error('Feed disposed')
    this.socketSend = null
    this.dropSubscriptions()
    this.socketSend = send
    this.firstSocketCopy = true; this.runtimeBuffer = []
    const token = ++this.socketGeneration
    this.sendPending()
    return token
  }
  socketClosed(token: number): void {
    if (token === this.socketGeneration) { this.socketSend = null; ++this.socketGeneration }
  }
  receiveSocket(answer: RecordEvent, token: number): void {
    if (token !== this.socketGeneration || this.disposed) return
    this.receiveEvent(answer, true)
  }

  private runtimeFrame(frame: AgentRuntime, socket = false) {
    const trusted = socket && this.firstSocketCopy && frame.full
    if (!this.cursor || !sameIdentity(this.cursor, frame)) {
      if (socket && this.runtimeBuffer.length < 256) {
        if (trusted) {
          new RecordOverlay(frame).receive(frame, true)
          this.firstSocketCopy = false
        }
        this.runtimeBuffer.push({ frame, trusted })
      }
      return
    }
    const overlay = (this.overlay ?? new RecordOverlay(this.cursor)).receive(frame, trusted)
    if (trusted) this.firstSocketCopy = false
    if (overlay !== this.overlay) this.commit(this.store, this.cursor, 0, overlay)
  }

  private receiveEvent(answer: RecordEvent, socket = false, readStartedAt = 0): void {
    if (this.disposed) return
    try {
      if (answer.type === 'agent_runtime') { this.runtimeFrame(answer, socket); return }
      if (answer.type === 'record_subscribed') {
        if (!revision(answer.sub) || !revision(answer.rev) || !identity(answer))
          throw new Error('Invalid subscription answer')
        const s = [...this.subscriptions.values()].find(s => s.declaration.sub === answer.sub)
        if (!s || s.active || !s.sent) return
        if (!this.cursor || this.buffering) return
        if (!sameIdentity(this.cursor, answer) || this.cursor.rev !== answer.rev) {
          this.renew(s); this.sendPending(); return
        }
        const set = `sub:${answer.sub}`
        const paged = answer.page !== undefined || answer.final !== undefined
        if ((!paged && s.pages) || (paged && (!revision(answer.page!) || typeof answer.final !== 'boolean'
            || answer.page !== (s.pages?.next ?? 0)))) {
          this.renew(s); this.sendPending(); return
        }
        if (!Array.isArray(answer.records)) throw new Error('Invalid subscription records')
        const pages = s.pages ?? { next: 0, records: [], keys: new Set<string>() }
        for (const record of answer.records) {
          const key = JSON.stringify([record.entity, record.id])
          if (pages.keys.has(key) || (record.set !== undefined && record.set !== set))
            throw new Error('Subscription page repeats a record or names another set')
          pages.keys.add(key)
        }
        pages.records.push(...answer.records); pages.next++
        if (paged && !answer.final) { s.pages = pages; return }
        const candidate = this.store.change([], [], [{ set, records: pages.records }])
        this.commit(candidate, this.cursor)
        s.pages = undefined
        s.active = true
        this.ready(s, true)
        return
      }
      this.receive(answer, readStartedAt)
    } catch (e) {
      this.io.error(e instanceof Error ? e : new Error(String(e)))
      if (!this.buffering) void this.resync()
    }
  }

  private baseline(answer: RecordSnapshot, readStartedAt = 0) {
    const c = answer.cursor
    if (!identity(c) || !revision(c.rev)) throw new Error('Invalid feed snapshot cursor')
    if (this.cursor && sameIdentity(this.cursor, c) && c.rev < this.cursor.rev) {
      if (answer.runtime) this.runtimeFrame(answer.runtime)
      if (readStartedAt) this.commit(this.store, this.cursor, readStartedAt)
      return
    }
    const replaced = this.cursor && !sameIdentity(this.cursor, c)
    let overlay = this.overlay && sameIdentity(this.overlay.identity, c) ? this.overlay : new RecordOverlay(c)
    if (answer.runtime) overlay = overlay.receive(answer.runtime)
    for (const buffered of this.runtimeBuffer) if (sameIdentity(c, buffered.frame))
      overlay = overlay.receive(buffered.frame, buffered.trusted)
    const candidate = new RecordStore().change(answer.records, [], [], set => set === 'shared')
    this.commit(candidate, { ...c }, readStartedAt, overlay)
    this.runtimeBuffer = []
    if (replaced) this.io.identityChanged?.()
    for (const s of this.subscriptions.values()) if (s.sent || s.active) this.renew(s)
    this.sendPending()
  }

  /** Snapshot and HTTP answers share this entry with websocket frames. */
  receive(answer: RecordEvent, readStartedAt = 0): void {
    if (this.disposed) return
    if (answer.type === 'agent_runtime' || answer.type === 'record_subscribed') {
      this.receiveEvent(answer, false, readStartedAt); return
    }
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
        if (answer.runtime) this.runtimeFrame(answer.runtime)
        if (readStartedAt) this.commit(this.store, c, readStartedAt)
        return
      }
      if (answer.from > c.rev) {
        this.gapTarget = { ...c, rev: Math.max(this.gapTarget?.rev ?? 0, answer.to) }
        void this.reconnect(false)
        return
      }
      const candidate = this.store.change(answer.upserts, answer.tombstones, answer.replacements, this.allowed)
      const overlay = answer.runtime ? this.overlay!.receive(answer.runtime) : this.overlay!
      this.commit(candidate, { org_uuid: c.org_uuid, incarnation: c.incarnation, rev: answer.to }, readStartedAt, overlay)
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
    this.dropSubscriptions()
    this.recovery = null
    this.gapTarget = null
    const readStartedAt = Date.now()
    return this.io.snapshot().then(answer => {
      if (this.disposed || run !== this.generation) return
      this.baseline(answer, readStartedAt)
      const pending = this.buffer
      this.buffer = []
      this.buffering = false
      this.sendPending()
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
    // Gap bursts coalesce without forgetting the highest observed revision.
    // A new socket must ask again even if an older HTTP
    // snapshot is in flight: that snapshot may predate writes made while offline.
    if (this.recovery && !force) return this.recovery
    const run = this.generation
    const cursor = { ...this.cursor }
    const readStartedAt = Date.now()
    let answered = false
    const pending = this.io.catchup(cursor, this.declarations()).then(answer => {
      if (this.disposed || run !== this.generation) return
      answered = true
      this.receive(answer, readStartedAt)
    }).catch(e => {
      if (!this.disposed && run === this.generation)
        this.io.error(e instanceof Error ? e : new Error(String(e)))
    }).finally(() => {
      if (this.recovery === pending) this.recovery = null
      // The answer's snapshot may predate another gap received while it was
      // pending. Recover that remembered revision without needing a later write.
      if (answered && !this.disposed && run === this.generation
          && this.gapTarget && this.cursor && sameIdentity(this.cursor, this.gapTarget)
          && this.cursor.rev < this.gapTarget.rev) void this.reconnect(false)
    })
    this.recovery = pending
    return pending
  }

  dispose(): void {
    this.disposed = true; ++this.generation; ++this.socketGeneration; this.buffer = []
    for (const s of this.subscriptions.values()) if (s.sent)
      this.socketSend?.({ type: 'unsubscribe', sub: s.declaration.sub })
    this.subscriptions.clear(); this.socketSend = null; this.runtimeBuffer = []
    this.listeners.clear()
  }
}

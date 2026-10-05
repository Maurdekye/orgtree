import type { RecordEvent, RecordFeed, SubscriptionMessage } from './recordfeed'

/** The existing org socket may precede capability detection. Retain its
 * bounded ordered frames until the per-org controller is attached, including
 * the first full host copy. Old connection callbacks cannot reach a new org.
 */
export class RecordSocketLink<T> {
  private serial = 0
  private feed: RecordFeed<T> | null = null
  private connection: { id: number; send: (message: SubscriptionMessage) => void;
    token: number | null; pending: RecordEvent[] } | null = null

  open(send: (message: SubscriptionMessage) => void): number {
    if (this.connection) this.close(this.connection.id)
    const connection = { id: ++this.serial, send, token: null as number | null, pending: [] as RecordEvent[] }
    this.connection = connection
    if (this.feed) connection.token = this.feed.socketOpened(send)
    return connection.id
  }

  attach(feed: RecordFeed<T>): void {
    if (this.feed === feed) return
    this.detach()
    this.feed = feed
    const c = this.connection
    if (!c) return
    c.token = feed.socketOpened(c.send)
    const pending = c.pending
    c.pending = []
    for (const event of pending) feed.receiveSocket(event, c.token)
  }

  detach(): void {
    const c = this.connection
    if (c?.token !== null && c?.token !== undefined) this.feed?.socketClosed(c.token)
    if (c) c.token = null
    this.feed = null
  }

  receive(event: RecordEvent, connection: number): void {
    const c = this.connection
    if (!c || c.id !== connection) return
    if (this.feed && c.token !== null) this.feed.receiveSocket(event, c.token)
    else if (c.pending.length < 256) c.pending.push(event)
    else {
      // A missing interval demands a fresh baseline when detection completes.
      // Retain the connection's epoch anchor: the HTTP runtime copy can then
      // restore current values without being allowed to establish an epoch.
      const first = c.pending.find(event => event.type === 'agent_runtime' && event.full)
      c.pending = first ? [first, { type: 'record_reset' }] : [{ type: 'record_reset' }]
    }
  }

  close(connection: number): void {
    const c = this.connection
    if (!c || c.id !== connection) return
    if (c.token !== null) this.feed?.socketClosed(c.token)
    this.connection = null
  }
}

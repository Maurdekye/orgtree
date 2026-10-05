/** One app transport shared by browser and Electron adapters. Timers only
 * reconnect or bound a silent handshake; no timer fetches domain state. */
import { AppFeedState, type AppFrame, type AppSnapshot } from './app-feed'

export type AppConnectionStatus = 'connecting' | 'current' | 'offline' | 'unsupported' | 'stopped'
export interface AppConnectionIO {
  copy(): Promise<AppSnapshot>
  socket(receive: (text: string) => void, closed: () => void): { close(): void }
  changed(): void
  later?(callback: () => void, milliseconds: number): () => void
}
const later = (callback: () => void, milliseconds: number) => {
  const id = setTimeout(callback, milliseconds)
  return () => clearTimeout(id)
}

export class AppFeedConnection {
  readonly state = new AppFeedState()
  status: AppConnectionStatus = 'stopped'
  error: string | null = null
  private generation = 0
  private stopped = true
  private socket: { close(): void } | null = null
  private timer: (() => void) | null = null
  private attempt = 0
  constructor(private io: AppConnectionIO) {}

  private change(status: AppConnectionStatus, error: string | null = null) {
    this.status = status; this.error = error; this.io.changed()
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.connect()
  }

  private retireSocket() {
    this.timer?.(); this.timer = null
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private async connect() {
    const generation = ++this.generation
    this.change('connecting')
    try {
      // Probe capability once per connection attempt. HTTP never establishes
      // epoch: only this socket's first complete frame is trusted to do that.
      await this.io.copy()
      if (this.stopped || generation !== this.generation) return
      let first = true
      this.timer = (this.io.later ?? later)(() => this.retry(generation, 'app feed handshake timed out'), 10000)
      this.socket = this.io.socket(text => {
        if (this.stopped || generation !== this.generation) return
        try {
          const frame = JSON.parse(text) as AppFrame
          if (!frame || typeof frame !== 'object' || typeof frame.epoch !== 'string'
              || !['app_snapshot', 'registry_snapshot', 'org_summary', 'org_notices', 'app_runtime'].includes(frame.type)
              || (first && frame.type !== 'app_snapshot')) throw new Error('invalid app feed frame')
          if (!this.state.apply(frame, first)) throw new Error('app identity changed')
          first = false
          this.attempt = 0
          this.timer?.(); this.timer = null
          this.change('current')
        } catch (error) {
          this.retry(generation, error instanceof Error ? error.message : 'invalid app feed frame')
        }
      }, () => this.retry(generation, 'app feed disconnected'))
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      if ((error as { status?: number }).status === 501) {
        this.state.clear()
        this.change('unsupported')
        return
      }
      this.retry(generation, error instanceof Error ? error.message : 'app feed unavailable')
    }
  }

  private retry(generation: number, error: string) {
    if (this.stopped || generation !== this.generation) return
    ++this.generation // Ignore callbacks and HTTP replies from the closed socket.
    this.retireSocket()
    this.change('offline', error)
    this.timer = (this.io.later ?? later)(() => {
      this.timer = null
      if (!this.stopped) void this.connect()
    }, Math.min(10000, 250 * 2 ** Math.min(this.attempt++, 6)))
  }

  async refresh() {
    const generation = this.generation
    const frame = await this.io.copy()
    if (this.stopped || generation !== this.generation || this.status !== 'current') return
    if (!this.state.apply(frame)) {
      this.retry(generation, 'app identity changed')
      return
    }
    this.io.changed()
  }

  stop() {
    this.stopped = true
    ++this.generation
    this.retireSocket()
    this.change('stopped')
  }
}

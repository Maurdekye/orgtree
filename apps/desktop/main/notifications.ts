import type { DesktopNotification } from '../../../packages/contracts/index'
import { notificationEnabled, type NotificationPreferences } from '../../../packages/contracts/notifications'

interface OwnedWindow {
  isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean
}
export function anyOrgtreeWindowFocused(windows: OwnedWindow[]): boolean {
  return windows.some(w => !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused())
}

function identity(n: { org: string; id: string }) { return JSON.stringify([n.org, n.id]) }

export function notification(value: unknown): DesktopNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification')
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (!['id', 'title', 'body', 'org', 'agent', 'item', 'kind', 'source_id', 'generation'].includes(key)) throw new Error('Unknown notification field')
  const text = (key: string, max: number) => {
    if (typeof v[key] !== 'string' || !v[key] || (v[key] as string).length > max) throw new Error('Invalid notification ' + key)
    return v[key] as string
  }
  const kind = text('kind', 30)
  if (!['question', 'urgent-mail', 'work-attention', 'routine', 'document', 'agent-frozen'].includes(kind)) throw new Error('Unknown notification kind')
  const result: DesktopNotification = { id: text('id', 200), title: text('title', 200), body: text('body', 2000), org: text('org', 128), kind: kind as DesktopNotification['kind'] }
  for (const key of ['agent', 'item', 'source_id'] as const) if (v[key] !== undefined) result[key] = text(key, 128)
  if (v.generation !== undefined) {
    if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0) throw new Error('Invalid notification generation')
    result.generation = v.generation as number
  }
  if (kind === 'agent-frozen' && (!result.agent || result.generation === undefined)) throw new Error('Missing frozen agent identity')
  if (kind === 'document' && !result.source_id) throw new Error('Missing document identity')
  return result
}

export class NotificationGate {
  private seen = new Set<string>()
  take(value: unknown, prefs: NotificationPreferences): DesktopNotification | null {
    const n = notification(value), key = identity(n)
    if (!notificationEnabled(n.kind, prefs) || this.seen.has(key)) return null
    this.seen.add(key)
    return n
  }
  forget(key: string) { this.seen.delete(key) }
  retain(active: Set<string>) {
    for (const key of this.seen) if (!active.has(key)) this.seen.delete(key)
  }
}

/** Keep the native objects until their attention items resolve, even after a
 * banner times out: the OS may still list it in its notification center. */
interface NativeAlert {
  on(event: 'show' | 'failed' | 'click', listener: () => void): unknown
  show(): void
  close(): void
}
interface PendingAlert { notice: NativeAlert; data: DesktopNotification; delivered: boolean; cancel(): void }
export class NativeNotifications {
  private gate = new NotificationGate()
  private active: Set<string> | null = null
  private shown = new Map<string, PendingAlert>()
  constructor(private create: (data: DesktopNotification) => NativeAlert,
    private open: (data: DesktopNotification) => void,
    private focused: () => boolean = () => false) {}

  configure(prefs: NotificationPreferences) {
    for (const [key, pending] of this.shown) if (!notificationEnabled(pending.data.kind, prefs)) {
      this.shown.delete(key)
      pending.cancel()
      if (!pending.delivered) this.gate.forget(key)
      try { pending.notice.close() } catch { /* already removed */ }
    }
  }

  sync(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('Invalid notification identities')
    const active = new Set(value.map(n => {
      if (!n || typeof n !== 'object' || Object.keys(n).some(k => !['org', 'id'].includes(k))
        || typeof n.org !== 'string' || !n.org || n.org.length > 128
        || typeof n.id !== 'string' || !n.id || n.id.length > 200)
        throw new Error('Invalid notification identity')
      return identity(n)
    }))
    this.active = active
    this.gate.retain(active)
    for (const [key, pending] of this.shown) if (!active.has(key)) {
      this.shown.delete(key)
      pending.cancel()
      try { pending.notice.close() } catch { /* already removed by the OS */ }
    }
  }

  notify(value: unknown, prefs: NotificationPreferences): Promise<boolean> {
    const data = notification(value), key = identity(data)
    if ((!prefs.notifyWhileFocused && this.focused()) || (this.active && !this.active.has(key))
      || !this.gate.take(data, prefs)) return Promise.resolve(false)
    let notice: NativeAlert
    try { notice = this.create(data) }
    catch { this.gate.forget(key); return Promise.resolve(false) }
    return new Promise(resolve => {
      let settled = false
      const settle = (shown: boolean) => {
        if (settled) return
        settled = true; clearTimeout(timer); resolve(shown)
      }
      const pending = { notice, data, delivered: false, cancel: () => settle(false) }
      const fail = () => {
        if (this.shown.get(key) !== pending) return
        this.shown.delete(key); this.gate.forget(key)
        settle(false)
        try { notice.close() } catch { /* unavailable native service */ }
      }
      // A missing native event must not leave the renderer's delivery pending.
      const timer = setTimeout(fail, 5000)
      this.shown.set(key, pending)
      notice.on('show', () => {
        if (this.shown.get(key) === pending) { pending.delivered = true; settle(true) }
      })
      notice.on('failed', fail)
      notice.on('click', () => { if (this.shown.get(key) === pending) this.open(data) })
      try { notice.show() } catch { fail() }
    })
  }
}

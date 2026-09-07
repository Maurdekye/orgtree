import type { DesktopNotification } from '../../../packages/contracts/index'

export function notification(value: unknown): DesktopNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification')
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (!['id', 'title', 'body', 'org', 'agent', 'item', 'kind'].includes(key)) throw new Error('Unknown notification field')
  const text = (key: string, max: number) => {
    if (typeof v[key] !== 'string' || !v[key] || (v[key] as string).length > max) throw new Error('Invalid notification ' + key)
    return v[key] as string
  }
  const kind = text('kind', 30)
  if (!['question', 'urgent-mail', 'work-attention', 'routine'].includes(kind)) throw new Error('Unknown notification kind')
  const result: DesktopNotification = { id: text('id', 200), title: text('title', 200), body: text('body', 2000), org: text('org', 128), kind: kind as DesktopNotification['kind'] }
  for (const key of ['agent', 'item'] as const) if (v[key] !== undefined) result[key] = text(key, 128)
  return result
}

export class NotificationGate {
  private seen = new Set<string>()
  take(value: unknown, routine: boolean): DesktopNotification | null {
    const n = notification(value), key = JSON.stringify([n.org, n.id])
    if ((n.kind === 'routine' && !routine) || this.seen.has(key)) return null
    this.seen.add(key)
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
    return n
  }
}

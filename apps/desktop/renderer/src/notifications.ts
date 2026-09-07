import { useEffect, useRef } from 'react'
import { req } from './api'
import { onLiveBump } from './livebus'
import { desktop } from './desktop'
import type { NativeNotice } from './desktop'

const KEY = 'orgtree-native-notices-v1'
const seen = new Set<string>()
const inFlight = new Set<string>()
function identity(n: NativeNotice) { return JSON.stringify([n.org, n.id]) }
export async function notifyOnce(notice: NativeNotice): Promise<boolean> {
  const bridge = desktop()
  if (!bridge?.notify) return false
  try { for (const key of JSON.parse(localStorage.getItem(KEY) ?? '[]')) if (typeof key === 'string') seen.add(key) } catch { /* optional history */ }
  const key = identity(notice)
  if (seen.has(key) || inFlight.has(key)) return false
  inFlight.add(key)
  try {
    const shown = await bridge.notify({ ...notice, id: notice.id.slice(0, 200), title: notice.title.slice(0, 200), body: notice.body.slice(0, 2000) })
    if (shown) {
      seen.add(key)
      while (seen.size > 1000) seen.delete(seen.values().next().value!)
      try { localStorage.setItem(KEY, JSON.stringify([...seen])) } catch { /* native dedup remains active */ }
    }
    return shown
  } catch { return false }
  finally { inFlight.delete(key) }
}

export interface DesktopNotice extends NativeNotice { source_id?: string }
/** Inbox question rows use a namespace so ask IDs cannot collide with mail. */
export function notificationInboxTarget(notice: DesktopNotice): string {
  const source = notice.source_id ?? notice.id.replace(/^(mail|ask):/, '')
  return notice.kind === 'question' ? `ask:${source}` : source
}
interface NoticePage { notices: DesktopNotice[]; total: number; truncated: boolean }

/** One bounded engine projection covers every organization. The owner frame
 * performs all reads and deduplicates only notifications actually shown. */
export function useNativeNotifications(open: (notice: DesktopNotice) => void) {
  const target = useRef(open); target.current = open
  const sources = useRef(new Map<string, string>())
  const bridge = desktop()
  useEffect(() => bridge?.onEvent(event => {
    if ((event.type as string) !== 'notification-click') return
    const n = event.data as NativeNotice
    if (n && typeof n.id === 'string' && typeof n.org === 'string' && typeof n.kind === 'string')
      target.current({ ...n, source_id: sources.current.get(identity(n)) })
  }), [bridge])
  useEffect(() => {
    if (!bridge?.notify) return
    let alive = true, running = false
    const poll = async () => {
      if (!alive || running) return
      running = true
      try {
        const page = await req<NoticePage>('/api/desktop/notifications')
        if (!alive) return
        for (const n of page.notices) {
          const { source_id, ...notice } = n
          if (source_id) sources.current.set(identity(notice), source_id)
          while (sources.current.size > 1000) sources.current.delete(sources.current.keys().next().value!)
          void notifyOnce(notice)
        }
      } catch { /* the next poll retries; no user action is lost */ }
      finally { running = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 6000)
    const off = onLiveBump(() => { void poll() })
    return () => { alive = false; clearInterval(timer); off() }
  }, [bridge])
}

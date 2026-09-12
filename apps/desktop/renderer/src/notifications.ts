import { useEffect, useRef } from 'react'
import { req } from './api'
import { onLiveBump } from './livebus'
import { desktop } from './desktop'
import type { NativeNotice } from './desktop'
import type { NotificationIdentity } from '../../../../packages/contracts'

const KEY = 'orgtree-native-notices-v1'
const seen = new Set<string>()
const inFlight = new Set<string>()
function identity(n: NotificationIdentity) { return JSON.stringify([n.org, n.id]) }
function readHistory() {
  try { for (const key of JSON.parse(localStorage.getItem(KEY) ?? '[]')) if (typeof key === 'string') seen.add(key) } catch { /* optional history */ }
}
function saveHistory() {
  try { localStorage.setItem(KEY, JSON.stringify([...seen])) } catch { /* native dedup remains active */ }
}
function retainHistory(active: Set<string>) {
  readHistory()
  for (const key of seen) if (!active.has(key)) seen.delete(key)
  saveHistory()
}
export async function notifyOnce(notice: NativeNotice): Promise<boolean> {
  const bridge = desktop()
  if (!bridge?.notify) return false
  readHistory()
  const key = identity(notice)
  if (seen.has(key) || inFlight.has(key)) return false
  inFlight.add(key)
  try {
    const shown = await bridge.notify({ ...notice, id: notice.id.slice(0, 200), title: notice.title.slice(0, 200), body: notice.body.slice(0, 2000) })
    if (shown) {
      seen.add(key)
      saveHistory()
    }
    return shown
  } catch { return false }
  finally { inFlight.delete(key) }
}

export type DesktopNotice = NativeNotice
/** Inbox question rows use a namespace so ask IDs cannot collide with mail. */
export function notificationInboxTarget(notice: DesktopNotice): string {
  const source = notice.source_id ?? notice.id.replace(/^(mail|ask):/, '')
  return notice.kind === 'question' ? `ask:${source}` : source
}
interface NoticePage {
  notices: DesktopNotice[]; total: number; truncated: boolean; next_offset?: number | null
  active?: NotificationIdentity[]
}
async function readNotices() {
  const notices = new Map<string, DesktopNotice>()
  let offset = 0, active: NotificationIdentity[] | null = null
  while (true) {
    const page = await req<NoticePage>('/api/desktop/notifications' + (offset ? `?offset=${offset}` : ''))
    for (const notice of page.notices) notices.set(identity(notice), notice)
    // Membership covers the whole projection, including rows beyond this page.
    // Use the latest page's membership if attention changed during pagination.
    active = page.active ?? null
    if (!page.truncated) {
      active ??= [...notices.values()].map(({ org, id }) => ({ org, id }))
      return { notices, active }
    }
    // Older engines have no paging contract: never mistake a partial list for
    // proof that an alert resolved, or keep fetching the same first page.
    if (page.next_offset == null || page.next_offset <= offset) return { notices, active }
    offset = page.next_offset
  }
}

/** The native clock drives attention reads even while the owner is hidden.
 * Only successful native deliveries are remembered across renderer reloads. */
export function useNativeNotifications(open: (notice: DesktopNotice) => void) {
  const target = useRef(open); target.current = open
  const bridge = desktop()
  useEffect(() => {
    if (!bridge?.notify) return
    let alive = true, running = false, dirty = false, click = 0
    const poll = async (mutation = false) => {
      if (!alive) return
      if (running) { dirty ||= mutation; return }
      running = true
      try {
        do {
          dirty = false
          const { notices, active } = await readNotices()
          if (!alive) return
          if (dirty) continue
          const keys = active && new Set(active.map(identity))
          if (active) {
            await bridge.syncNotifications?.(active)
            if (!alive) return
            if (dirty) continue
            retainHistory(keys!)
          }
          await Promise.all([...notices.values()]
            .filter(n => !keys || keys.has(identity(n))).map(n => notifyOnce(n)))
        } while (alive && dirty)
      } catch { /* the next poll retries; no user action is lost */ }
      finally { running = false }
    }
    void poll()
    const offNative = bridge.onEvent(event => {
      if (event.type === 'notification-poll') { void poll(); return }
      if (event.type !== 'notification-click') return
      const n = event.data as NativeNotice
      if (!n || typeof n.id !== 'string' || typeof n.org !== 'string') return
      const request = ++click
      // The OS can retain a banner while its request is answered elsewhere.
      // Recheck on activation and recover the exact source after a reload.
      void readNotices().then(({ notices, active }) => {
        if (!alive || click !== request) return
        const current = notices.get(identity(n))
        if (current && (!active || active.some(a => identity(a) === identity(n)))) target.current(current)
      }).catch(() => { /* the main window is still shown if the engine is down */ })
    })
    // Compatibility with shells predating the native poll/cleanup contract.
    const timer = bridge.syncNotifications ? undefined : setInterval(() => { void poll() }, 6000)
    const off = onLiveBump(() => { void poll(true) })
    return () => { alive = false; clearInterval(timer); off(); offNative() }
  }, [bridge])
}

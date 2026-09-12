import { useEffect, useRef } from 'react'
import { req } from './api'
import { onLiveBump } from './livebus'
import { desktop } from './desktop'
import type { NativeNotice } from './desktop'
import type { NotificationIdentity } from '../../../../packages/contracts'
import { notificationEnabled, notificationPreferences } from '../../../../packages/contracts/notifications'
import { questionVisible } from './notification-visibility'
import { pendingAttention, publishPending, summarizePending } from './pending-attention'

const KEY = 'orgtree-native-notices-v1'
const DOCUMENT_BASELINE = 'orgtree-native-documents-observed-v1'
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
    // A reloaded renderer starts with an empty aggregate that may match what it
    // is about to read, so the first pass always reports, even unchanged.
    let alive = true, running = false, dirty = false, click = 0, attentionSent = false
    let prefs = notificationPreferences(), prefsReady = !bridge.getPreferences, prefsRevision = 0, loadingPrefs = false
    let documentsObserved = false
    try { documentsObserved = localStorage.getItem(DOCUMENT_BASELINE) === 'true' } catch { /* memory baseline */ }
    async function loadPrefs() {
      if (!bridge?.getPreferences || loadingPrefs || !alive) return
      loadingPrefs = true
      const revision = prefsRevision
      try {
        const value = await bridge.getPreferences()
        if (!alive || revision !== prefsRevision) return
        prefs = notificationPreferences(value); prefsReady = true; void poll(true)
      } catch { /* retry on the next native tick; do not guess disabled choices */ }
      finally { loadingPrefs = false }
    }
    const poll = async (mutation = false) => {
      if (!alive) return
      if (!prefsReady) { void loadPrefs(); return }
      if (running) { dirty ||= mutation; return }
      running = true
      // A mutation landed while this pass was reading, so the response may
      // already be stale and a withdrawn request must not alert. Re-read —
      // but DEFERRING IS NOT FREE: a busy organization saves continuously, so
      // every pass is dirtied before it finishes and an unbounded skip means
      // no alert ever reaches the operating system at all (user report
      // 2026-09-12: nothing arrived for hours while agents worked). After a
      // few attempts, act on the newest read instead of waiting for a quiet
      // moment that never comes; anything that did resolve in the meantime is
      // retracted by the very next `sync`, which closes it natively.
      let deferrals = 0
      const defer = () => dirty && deferrals++ < 3
      try {
        do {
          dirty = false
          const { notices, active } = await readNotices()
          if (!alive) return
          if (defer()) continue
          const keys = active && new Set(active.map(identity))
          const candidates = [...notices.values()].filter(n => !keys || keys.has(identity(n)))
          // BOTH STANDING INDICATORS (user ruling 2026-09-12) — the taskbar
          // pulse and the toolbar dot — read this one aggregate, so resolving
          // one request cannot clear either while another still waits. It is
          // the whole projection, NOT the preference-filtered dispatch list:
          // muting a category for the operating system does not mean the work
          // stopped waiting. An unchanged aggregate is not sent, so a poll
          // that finds the same items cannot restart the pulse.
          if (publishPending(summarizePending(candidates)) || !attentionSent) {
            attentionSent = true
            await bridge.setPendingAttention?.(pendingAttention().ids)
            if (!alive) return
          }
          // A card already on screen has reached the user. Remember it until
          // it resolves, so closing the desk cannot create a late interruption.
          // New-document alerts start after a first inventory, avoiding an old
          // document flood on installation or when enabling the category.
          readHistory()
          const visible = new Set(candidates.filter(n => n.kind === 'question'
            && questionVisible(n.org, n.source_id ?? n.id)).map(identity))
          for (const n of candidates) if (visible.has(identity(n)) ||
            (n.kind === 'document' && (!documentsObserved || !prefs.notifyDocuments))) seen.add(identity(n))
          documentsObserved = true
          try { localStorage.setItem(DOCUMENT_BASELINE, 'true') } catch { /* optional history */ }
          saveHistory()
          const eligible = candidates.filter(n => notificationEnabled(n.kind, prefs) && !visible.has(identity(n)))
          if (active) {
            await bridge.syncNotifications?.(eligible.map(({ org, id }) => ({ org, id })))
            if (!alive) return
            if (defer()) continue
            retainHistory(keys!)
          }
          await Promise.all(eligible.map(n => {
            // Recheck at dispatch: the card can mount while IPC sync awaits.
            if (n.kind === 'question' && questionVisible(n.org, n.source_id ?? n.id)) {
              seen.add(identity(n)); saveHistory(); return false
            }
            return notifyOnce(n)
          }))
        } while (alive && dirty)
      } catch { /* the next poll retries; no user action is lost */ }
      finally { running = false }
    }
    void poll()
    const offNative = bridge.onEvent(event => {
      if (event.type === 'preferences') {
        prefsRevision++; prefs = notificationPreferences(event.data as Parameters<typeof notificationPreferences>[0]); prefsReady = true
        void poll(true); return
      }
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
        if (current && notificationEnabled(current.kind, prefs)
          && (!active || active.some(a => identity(a) === identity(n)))) target.current(current)
      }).catch(() => { /* the main window is still shown if the engine is down */ })
    })
    // Compatibility with shells predating the native poll/cleanup contract.
    const timer = bridge.syncNotifications ? undefined : setInterval(() => { void poll() }, 6000)
    const off = onLiveBump(() => { void poll(true) })
    return () => { alive = false; clearInterval(timer); off(); offNative() }
  }, [bridge])
}

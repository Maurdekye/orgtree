import { useEffect, useRef } from 'react'
import { req } from './api'
import { useAppFeed } from './appfeed'
import { onLiveBump } from './livebus'
import { desktop } from './desktop'
import { onHeldEvent } from './events/heldbus'
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
async function readLegacyNotices() {
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
 * Only successful native deliveries are remembered across renderer reloads.
 *
 * ⚠ TWO HALVES, AND ONLY ONE OF THEM IS PER-WINDOW (v3 multi-window).
 *
 * The GLOBAL half — paging `/api/desktop/notifications`, which is the
 * CROSS-ORGANIZATION attention projection; `setPendingAttention`, which writes
 * the taskbar aggregate; `syncNotifications`, which tells the operating system
 * which notifications should still exist; and `notifyOnce`, which dispatches
 * them — must run in EXACTLY ONE window. Several windows doing it means N
 * renderers racing one reconciliation: the taskbar is written by whichever
 * finished last, and two windows disagreeing about the eligible set retract
 * each other's notifications. The `seen` dedup set is shared through
 * localStorage but guarded only by an in-process `inFlight`, so concurrent
 * windows are a real duplicate-alert race rather than a theoretical one.
 *
 * The PER-WINDOW half is the `notification-click` branch. Every window handles
 * the click aimed at it, owner or not — that is how a targeted reveal reaches
 * the organization window it belongs to.
 *
 * `owner` gates the first and never the second. It defaults to true so a plain
 * browser, the shipped single-window shell, and every existing caller behave
 * exactly as before. Losing ownership tears this effect down, which sets
 * `alive` false, and every `await` in the poll is followed by an `alive`
 * check — so a pass in flight when the duty moves completes without writing.
 */
export function useNativeNotifications(open: (notice: DesktopNotice) => void,
  owner = true) {
  const target = useRef(open); target.current = open
  const bridge = desktop()
  const feed = useAppFeed(Boolean(bridge?.notify))
  const feedRef = useRef(feed); feedRef.current = feed
  const ready = feed.status === 'current' || feed.status === 'unsupported'
  const wake = useRef<(() => void) | null>(null)
  const noticeVersion = JSON.stringify([feed.status, feed.state.allNotices()])
  useEffect(() => { wake.current?.() }, [noticeVersion])
  useEffect(() => {
    if (!bridge?.notify || !ready) return
    // A reloaded renderer starts with an empty aggregate that may match what it
    // is about to read, so the first pass always reports, even unchanged.
    let alive = true, running = false, dirty = false, click = 0, attentionSent = false
    let prefs = notificationPreferences(), prefsReady = !bridge.getPreferences, prefsRevision = 0, loadingPrefs = false
    let documentsObserved = false
    const observedOrgs = new Set<string>()
    let retry: ReturnType<typeof setTimeout> | undefined
    try { documentsObserved = localStorage.getItem(DOCUMENT_BASELINE) === 'true' } catch { /* memory baseline */ }
    const readNotices = async (fresh = false) => {
      const current = feedRef.current
      if (current.status === 'unsupported') return { ...await readLegacyNotices(), unloaded: [] as NotificationIdentity[] }
      if (fresh) await current.refresh()
      if (current.status !== 'current' || !current.state.registry) throw new Error('App notices are not current')
      const rows = current.state.allNotices() as DesktopNotice[]
      // A first host copy can arrive before one active org's initial read.
      // Unknown membership is not proof that a previously delivered item was
      // resolved: retain its dedup/native identity until that org answers.
      const unknown = new Set(current.state.registry.records.filter(row => row.body.state === 'active'
        && current.state.notices.get(row.id)?.value?.org_uuid !== row.body.org_uuid).map(row => row.body.slug))
      readHistory()
      const unloaded: NotificationIdentity[] = []
      for (const key of seen) {
        try {
          const [org, id] = JSON.parse(key)
          if (typeof org === 'string' && typeof id === 'string' && unknown.has(org)) unloaded.push({ org, id })
        } catch { /* old malformed history is ignored */ }
      }
      return { notices: new Map(rows.map(n => [identity(n), n])),
        active: [...rows.map(({ org, id }) => ({ org, id })), ...unloaded], unloaded }
    }
    async function loadPrefs() {
      if (!bridge?.getPreferences || loadingPrefs || !alive) return
      loadingPrefs = true
      const revision = prefsRevision
      try {
        const value = await bridge.getPreferences()
        if (!alive || revision !== prefsRevision) return
        prefs = notificationPreferences(value); prefsReady = true; void poll(true)
      } catch {
        // Native preference failure is retried locally; it must not require
        // another domain change, and must never guess disabled choices.
        if (alive && feedRef.current.status === 'current') {
          clearTimeout(retry)
          retry = setTimeout(() => { void poll() }, 5000)
        }
      }
      finally { loadingPrefs = false }
    }
    const poll = async (mutation = false) => {
      // the global half. A non-owner window reads nothing, syncs nothing and
      // writes no taskbar state — see the note on the hook.
      if (!alive || !owner) return
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
          const { notices, active, unloaded } = await readNotices()
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
            // ids AND the same rows with their organization said out loud, so
            // the taskbar pulse can flash the affected item's own window
            // rather than every main window (user ruling 2026-09-21). One
            // call, one projection pass, no second read.
            const aggregate = pendingAttention()
            await bridge.setPendingAttention?.(aggregate.ids, aggregate.items)
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
            (n.kind === 'document' && ((!documentsObserved && !observedOrgs.has(n.org)) || !prefs.notifyDocuments))) seen.add(identity(n))
          // Startup app copies may precede an org's first notice read. A
          // partial inventory must not turn its existing documents into new
          // arrivals when that read completes. Each loaded org earns its own
          // baseline; persist completion only once all active orgs are known.
          if (feedRef.current.status === 'unsupported') documentsObserved = true
          else {
            const state = feedRef.current.state
            const activeRows = state.registry?.records.filter(r => r.body.state === 'active') ?? []
            for (const row of activeRows) {
              const frame = state.notices.get(row.id)?.value
              if (frame?.org_uuid === row.body.org_uuid) observedOrgs.add(row.body.slug)
            }
            documentsObserved ||= activeRows.every(row => observedOrgs.has(row.body.slug))
          }
          if (documentsObserved) try { localStorage.setItem(DOCUMENT_BASELINE, 'true') } catch { /* optional history */ }
          saveHistory()
          const eligible = candidates.filter(n => notificationEnabled(n.kind, prefs) && !visible.has(identity(n)))
          if (active) {
            await bridge.syncNotifications?.([...eligible.map(({ org, id }) => ({ org, id })), ...unloaded])
            if (!alive) return
            if (defer()) continue
            retainHistory(keys!)
          }
          const delivered = await Promise.all(eligible.map(n => {
            // Recheck at dispatch: the card can mount while IPC sync awaits.
            if (n.kind === 'question' && questionVisible(n.org, n.source_id ?? n.id)) {
              seen.add(identity(n)); saveHistory(); return false
            }
            return notifyOnce(n)
          }))
          // Retry an unsuccessful OS delivery from this same in-memory feed.
          // This timer never reads an endpoint; seen items need no retry.
          if (alive && feedRef.current.status !== 'unsupported'
              && delivered.some((ok, i) => !ok && !seen.has(identity(eligible[i])))) {
            clearTimeout(retry)
            retry = setTimeout(() => { void poll() }, 5000)
          }
        } while (alive && dirty)
      } catch { /* the next poll retries; no user action is lost */ }
      finally { running = false }
    }
    wake.current = () => { void poll(true) }
    void poll()
    // A NON-OWNER STILL NEEDS PREFERENCES. `poll` is what used to load them,
    // and it now returns immediately in a window without the duty — so the
    // click branch below would filter with defaults and could reveal an item
    // whose category the user has muted. Load them directly instead.
    if (!owner) void loadPrefs()
    // ⚠ THE TWO CHANNELS ARE SPLIT BY WHETHER NATIVE HOLDS THE TYPE, and the
    // split is not cosmetic. `preferences` and `notification-poll` are live
    // facts a renderer can simply re-read, so they take the ordinary
    // subscription. `notification-click` is HELD — it is the one event in this
    // hook that cannot be rediscovered, and it is the one most likely to
    // arrive before this effect has ever run, because clicking a notification
    // is what COLD-STARTS the window. It comes through the held bus, which was
    // listening from the document's first statement and hands over whatever
    // was waiting the moment this line runs. See events/heldbus.ts.
    const offNative = bridge.onEvent(event => {
      if (event.type === 'preferences') {
        prefsRevision++; prefs = notificationPreferences(event.data as Parameters<typeof notificationPreferences>[0]); prefsReady = true
        void poll(true); return
      }
      if (event.type === 'notification-poll') { void poll(); return }
    })
    const offClick = onHeldEvent('notification-click', (event) => {
      const n = event.data as NativeNotice
      if (!n || typeof n.id !== 'string' || typeof n.org !== 'string') return
      const request = ++click
      // The OS can retain a banner while its request is answered elsewhere.
      // Recheck on activation and recover the exact source after a reload.
      void readNotices(true).then(({ notices, active }) => {
        if (!alive || click !== request) return
        const current = notices.get(identity(n))
        if (current && notificationEnabled(current.kind, prefs)
          && (!active || active.some(a => identity(a) === identity(n)))) target.current(current)
      }).catch(() => { /* the main window is still shown if the engine is down */ })
    })
    // Compatibility with shells predating the native poll/cleanup contract.
    const timer = owner && feedRef.current.status === 'unsupported' && !bridge.syncNotifications
      ? setInterval(() => { void poll() }, 6000) : undefined
    const off = onLiveBump(() => {
      if (feedRef.current.status === 'unsupported') void poll(true)
    })
    return () => { alive = false; wake.current = null; clearTimeout(retry); clearInterval(timer); off(); offNative(); offClick() }
  }, [bridge, owner, ready, feed.status === 'unsupported'])
}

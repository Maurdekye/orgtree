import { useEffect, useRef } from 'react'
import { getInbox, getWorkItems } from './api'
import { desktop } from './desktop'
import type { NativeNotice } from './desktop'
import type { TreePayload } from './types'

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

/** Polls are already coalesced by App. Fetch detail only when its tree summary
 * changes; no extra timer and no provider work. The native preference decides
 * whether routine notices are enabled. */
export function useNativeNotifications(tree: TreePayload | null, open: (notice: NativeNotice) => void) {
  const target = useRef(open); target.current = open
  const bridge = desktop()
  useEffect(() => bridge?.onEvent(event => {
    if ((event.type as string) !== 'notification-click') return
    const n = event.data as NativeNotice
    if (n && typeof n.org === 'string' && typeof n.kind === 'string') target.current(n)
  }), [bridge])
  const asks = tree?.asks
  useEffect(() => {
    if (!tree || !bridge?.notify) return
    for (const ask of asks ?? []) if (ask.status === 'open' || ask.status === 'pending') {
      void notifyOnce({ id: `ask:${ask.id}`, org: tree.slug, agent: ask.node,
        title: `${ask.node} needs your answer`, body: ask.question || ask.questions?.[0]?.question || 'A request is waiting in your inbox.', kind: 'question' })
    }
  }, [asks, tree?.slug, bridge])
  useEffect(() => {
    if (!tree || !bridge?.notify || !tree.user_inbox_count) return
    let alive = true
    void getInbox(tree.slug).then(inbox => {
      if (!alive) return
      for (const mail of inbox.pending ?? []) void notifyOnce({
        id: `mail:${mail.id}`, org: tree.slug, agent: mail.from,
        title: mail.urgent ? `Urgent mail from ${mail.from}` : `Mail from ${mail.from}`,
        body: mail.urgent_reason || mail.body, kind: mail.urgent ? 'urgent-mail' : 'routine',
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [tree?.slug, tree?.user_inbox_count, tree?.user_inbox_newest, tree?.urgent_unread, bridge])
  useEffect(() => {
    if (!tree || !bridge?.notify || !tree.work_items_summary?.attention) return
    let alive = true
    void getWorkItems(tree.slug).then(work => {
      if (!alive) return
      for (const item of work.items) if (item.manual_attention) void notifyOnce({
        id: `work:${item.slug}:${item.manual_attention.set_rev}`, org: tree.slug, item: item.slug,
        title: item.title, body: item.manual_attention.reason, kind: 'work-attention',
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [tree?.slug, tree?.work_items_summary, bridge])
}

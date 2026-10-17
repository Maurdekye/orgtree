import type { ReactNode } from 'react'
import { useMemo, useRef } from 'react'
import type { ChatMessage, PendingMail } from '../types'
import { SystemRuns, systemEntry, transcriptEntries, noticeMailKey } from '../events/systemruns'
import type { SystemEntry, TranscriptEntry } from '../events/systemruns'
import { PendingRun } from './pendingrun'

interface FlowEntry extends SystemEntry { content: ReactNode }

/** Group presentation after the desk's existing ordering and deduplication.
 * Delivery carriers are not boundaries; actual live output is. Non-system
 * pending mail retains its independent six-row disclosure. */
export function TranscriptFlow({ messages, now, later, live, hasLive, divider,
  renderMessage, renderPending, onToggle }: {
  messages: ChatMessage[]; now: PendingMail[]; later: PendingMail[]
  live: ReactNode; hasLive: boolean; divider: ReactNode
  renderMessage: (entry: TranscriptEntry) => ReactNode
  renderPending: (mail: PendingMail) => ReactNode
  onToggle: () => void
}) {
  // Another row may grow while the earlier mail carrier is unchanged. Keep
  // its segmented message objects too, not just the outer list's projection.
  const cache = useRef(new WeakMap<ChatMessage, { index: number; entries: TranscriptEntry[] }>())
  const projected = useMemo(() => messages.flatMap((message, index) => {
    let item = cache.current.get(message)
    if (!item || item.index !== index) {
      item = { index, entries: transcriptEntries([message], index) }
      cache.current.set(message, item)
    }
    return item.entries
  }), [messages])
  const entries: FlowEntry[] = projected.map(entry => ({
    ...entry, content: renderMessage(entry),
  }))
  let divided = false
  const appendPending = (rows: PendingMail[], phase: string) => {
    let ordinary: PendingMail[] = []
    let ordinaryRun = 0
    const append = (entry: FlowEntry) => {
      entries.push({ ...entry, content: <>{!divided && divider}{entry.content}</> })
      divided = true
    }
    const flush = () => {
      if (!ordinary.length) return
      append({ key: `pending/${phase}/${ordinaryRun++}`,
        system: false, label: '', content: <PendingRun count={ordinary.length} onToggle={onToggle}>
          {ordinary.map(renderPending)}
        </PendingRun> })
      ordinary = []
    }
    rows.forEach((mail, i) => {
      const classification = systemEntry(mail)
      if (!classification.system) { ordinary.push(mail); return }
      flush()
      append({ ...classification, key: noticeMailKey(mail) ?? `${phase}/${i}`,
        content: renderPending(mail) })
    })
    flush()
  }
  appendPending(now, 'now')
  if (hasLive) entries.push({ key: 'live-tail', system: false, label: '', content: live })
  appendPending(later, 'later')
  return <SystemRuns entries={entries} render={entry => entry.content} onToggle={onToggle} />
}

import type { ReactNode } from 'react'
import { useMemo, useRef } from 'react'
import type { ChatMessage, PendingMail } from '../types'
import { SystemRuns, transcriptEntries, noticeMailKey } from '../events/systemruns'
import type { SystemEntry, TranscriptEntry } from '../events/systemruns'
import { PendingRun } from './pendingrun'

interface FlowEntry extends SystemEntry { content: ReactNode }

/** Delivered system notices retain their history grouping. Current-turn input
 * and live output are always visible; all undelivered rows share one disclosure. */
export function TranscriptFlow({ messages, now, later, live, hasLive, divider,
  waitingCount, pendingTail, renderMessage, renderPending, onToggle }: {
  messages: ChatMessage[]; now: PendingMail[]; later: PendingMail[]
  live: ReactNode; hasLive: boolean; divider: ReactNode
  waitingCount: number; pendingTail: ReactNode
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
  now.forEach((mail, i) => entries.push({ key: noticeMailKey(mail) ?? `now/${i}`,
    system: false, label: '', content: renderPending(mail) }))
  if (hasLive) entries.push({ key: 'live-tail', system: false, label: '', content: live })
  if (waitingCount > 0) entries.push({ key: 'pending/undelivered', system: false, label: '',
    content: <PendingRun count={waitingCount} divider={divider} onToggle={onToggle}>
      {later.map(renderPending)}{pendingTail}
    </PendingRun> })
  return <SystemRuns entries={entries} render={entry => entry.content} onToggle={onToggle} />
}

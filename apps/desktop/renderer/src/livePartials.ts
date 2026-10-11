import type { Convo } from './convo'
import type { ChatTransient } from './types'

const thought = (kind: string) => ['thinking', 'thinking_start', 'thought'].includes(kind)
const draft = (kind: string) => ['draft', 'delta'].includes(kind)

/** HTTP snapshots and websocket accumulators describe the same live tail.
 * Project them together, ordered by the actor's per-partial ordinal. */
export function livePartials(rows: ChatTransient[], c: Convo): ChatTransient[] {
  const other = rows.filter(r => !thought(r.kind) && !draft(r.kind))
  const parts = rows.filter(r => thought(r.kind) || draft(r.kind)).map(r => {
    const thinking = thought(r.kind)
    const text = thinking ? c.thinking : c.draft
    const id = thinking ? c.thinkingEventId : c.draftEventId
    return text && (!id || id === r.event_id) ? { ...r, text,
      stream_order: (thinking ? c.thinkingOrder : c.draftOrder) ?? r.stream_order } : r
  })
  if (!parts.some(r => thought(r.kind)) && c.thinkSecs !== null && c.chat?.busy) parts.push({
    event_id: c.thinkingEventId ?? '', reply_quote: c.thinkingReplyQuote,
    role: 'assistant', kind: 'thinking', text: c.thinking, stream_order: c.thinkingOrder })
  if (!parts.some(r => draft(r.kind)) && c.draft) parts.push({
    event_id: c.draftEventId ?? '', reply_quote: c.draftReplyQuote,
    role: 'assistant', kind: 'draft', text: c.draft, stream_order: c.draftOrder })
  return [...other, ...parts.map((row, index) => ({ row, order: row.stream_order ?? index }))
    .sort((a, b) => a.order - b.order).map(({ row }) => row)]
}

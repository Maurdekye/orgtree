/** Server-issued identity. Display positions and rendered text never identify a source. */
export interface EventSourceRef { org: string; agent: string; generation: number; eventId: string }
export interface ReplyContext extends EventSourceRef { quote: string }
export interface EventReplyWire { source_event_ref: EventSourceRef; quoted_context: string }
export const MAX_REPLY_QUOTE = 4000

export function validReply(value: unknown): value is ReplyContext {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<ReplyContext>
  return typeof r.org === 'string' && !!r.org && typeof r.agent === 'string' && !!r.agent
    && Number.isInteger(r.generation) && Number(r.generation) >= 0
    && typeof r.eventId === 'string' && !!r.eventId
    && typeof r.quote === 'string' && r.quote.length <= MAX_REPLY_QUOTE
}

export function replyWire(r: ReplyContext): EventReplyWire {
  return { source_event_ref: { org: r.org, agent: r.agent, generation: r.generation, eventId: r.eventId },
    quoted_context: r.quote.slice(0, MAX_REPLY_QUOTE) }
}

export function replyContext(value: unknown): ReplyContext | null {
  if (!value || typeof value !== 'object') return null
  const wire = value as Partial<EventReplyWire>
  const context = { ...wire.source_event_ref, quote: wire.quoted_context }
  return validReply(context) ? context : null
}

export function replyFromRow(org: string, agent: string, generation: number,
  row: { event_id?: string }, visibleText: string): ReplyContext | null {
  if (typeof row.event_id !== 'string' || !row.event_id) return null
  return { org, agent, generation, eventId: row.event_id, quote: visibleText.trim().slice(0, MAX_REPLY_QUOTE) }
}

export function readReply(key: string): ReplyContext | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}-reply`) || 'null')
    return validReply(value) ? value : null
  } catch { return null }
}

export function storeReply(key: string, reply: ReplyContext | null): void {
  try {
    if (reply) localStorage.setItem(`${key}-reply`, JSON.stringify(reply))
    else localStorage.removeItem(`${key}-reply`)
  } catch { /* Same best-effort persistence as the text draft. */ }
}

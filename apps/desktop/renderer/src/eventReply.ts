/** Server-issued identity. Display positions and rendered text never identify a source. */
export interface EventSourceRef { org: string; agent: string; generation: number; eventId: string }
export interface ReplyContext extends EventSourceRef { quote: string; sender?: string; mailId?: string }
export interface EventReplyWire { source_event_ref: EventSourceRef; quoted_context: string; mail_id?: string }
/** Mailbox/object replies retain a small source snapshot independently of delivery. */
export interface MailReplySnapshot {
  id: string; kind: 'mail' | 'document' | 'work_item'; from: string; at: string; gist: string
  org?: string; box?: 'user' | 'org' | 'node'; node?: string
}
export type MailReplyWire = EventReplyWire | MailReplySnapshot
export const MAX_REPLY_QUOTE = 4000

export function validReply(value: unknown): value is ReplyContext {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<ReplyContext>
  return typeof r.org === 'string' && !!r.org && typeof r.agent === 'string' && !!r.agent
    && Number.isInteger(r.generation) && Number(r.generation) >= 0
    && typeof r.eventId === 'string' && !!r.eventId
    && typeof r.quote === 'string' && r.quote.length <= MAX_REPLY_QUOTE
    && (r.sender === undefined || (typeof r.sender === 'string' && !!r.sender))
    && (r.mailId === undefined || (typeof r.mailId === 'string' && !!r.mailId))
}

export function replyWire(r: ReplyContext): EventReplyWire {
  return { source_event_ref: { org: r.org, agent: r.agent, generation: r.generation, eventId: r.eventId },
    quoted_context: r.quote.slice(0, MAX_REPLY_QUOTE), ...(r.mailId ? { mail_id: r.mailId } : {}) }
}

export function replyContext(value: unknown): ReplyContext | null {
  if (!value || typeof value !== 'object') return null
  const wire = value as Partial<EventReplyWire>
  const context = { ...wire.source_event_ref, quote: wire.quoted_context, mailId: wire.mail_id }
  return validReply(context) ? context : null
}

export function replyFromRow(org: string, agent: string, generation: number,
  row: { event_id?: string }, visibleText: string): ReplyContext | null {
  if (typeof row.event_id !== 'string' || !row.event_id) return null
  return { org, agent, generation, eventId: row.event_id, quote: visibleText.slice(0, MAX_REPLY_QUOTE) }
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

/** Several durable targets, with legacy singleton persistence kept readable. */
export function readReplies(key: string): ReplyContext[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${key}-replies`) || 'null')
    if (Array.isArray(value) && value.length <= 50 && value.every(validReply)) return value
  } catch { /* Legacy single target below. */ }
  const one = readReply(key); return one ? [one] : []
}
export function storeReplies(key: string, replies: ReplyContext[]): void {
  try {
    if (replies.length) localStorage.setItem(`${key}-replies`, JSON.stringify(replies))
    else localStorage.removeItem(`${key}-replies`)
  } catch { /* Best-effort draft persistence. */ }
  storeReply(key, replies[0] ?? null)
}
export function appendReplyTarget(current: ReplyContext[], next: ReplyContext): ReplyContext[] {
  const sender = (r: ReplyContext) => r.sender || r.agent
  if (current.some(r => r.org !== next.org || sender(r) !== sender(next))) throw Error('A multi-reply can only answer messages from the same sender.')
  if (current.some(r => r.agent === next.agent && r.generation === next.generation && r.eventId === next.eventId && r.mailId === next.mailId)) return current
  if (current.length >= 50) throw Error('A multi-reply can answer at most 50 messages.')
  return [...current, next]
}

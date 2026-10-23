import type { SelectionDraft, SelectionSnapshot, SelectionTarget } from './replySelection'

/** Server-issued identity. Display positions and rendered text never identify a source. */
export interface EventSourceRef { org: string; agent: string; generation: number; eventId: string }
export interface ReplyContext extends EventSourceRef { quote: string; sender?: string; mailId?: string; docId?: string; workItemId?: string; selection?: SelectionSnapshot }
export interface EventReplyWire { source_event_ref: EventSourceRef; quoted_context: string; mail_id?: string; sender?: string; selection?: SelectionSnapshot }
/** Mailbox/object replies retain a small source snapshot independently of delivery. */
export interface MailReplySnapshot {
  id: string; kind: 'mail' | 'document' | 'work_item'; from: string; at: string; gist: string
  org?: string; box?: 'user' | 'org' | 'node'; node?: string
  slug?: string
}
export type MailReplyWire = EventReplyWire | MailReplySnapshot | SelectionTarget
export const MAX_REPLY_QUOTE = 4000

/** Object references answer in the owning composer's conversation. The object
 * identity, rather than its presenter/owner's current name, identifies the reply. */
export function objectReplyContext(agent: string, generation: number,
  target: { kind: 'document' | 'work_item'; org: string; id: string; title: string; sender?: string }): ReplyContext {
  return { org: target.org, agent, generation, eventId: `${target.kind}:${target.id}`,
    quote: target.title.slice(0, MAX_REPLY_QUOTE), ...(target.sender ? { sender: target.sender } : {}),
    ...(target.kind === 'document' ? { docId: target.id } : { workItemId: target.id }) }
}

export function validReply(value: unknown): value is ReplyContext {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<ReplyContext>
  return typeof r.org === 'string' && !!r.org && typeof r.agent === 'string' && !!r.agent
    && Number.isInteger(r.generation) && Number(r.generation) >= 0
    && typeof r.eventId === 'string' && !!r.eventId
    && typeof r.quote === 'string' && r.quote.length <= MAX_REPLY_QUOTE
    && (r.sender === undefined || (typeof r.sender === 'string' && !!r.sender))
    && (r.mailId === undefined || (typeof r.mailId === 'string' && !!r.mailId))
    && (r.docId === undefined || (typeof r.docId === 'string' && !!r.docId))
    && (r.workItemId === undefined || (typeof r.workItemId === 'string' && !!r.workItemId))
    && !(r.workItemId && (r.docId || r.mailId))
    && (!r.selection || (r.selection.version === 1 && typeof r.selection.excerpt === "string" && r.selection.selector?.projection === "source-v1"))
}

export function replyWire(r: ReplyContext): MailReplyWire | SelectionTarget {
  if (r.selection) return { target: r.docId ? { kind: "document", org: r.org, id: r.docId }
    : r.workItemId ? { kind: "work_item", org: r.org, slug: r.workItemId }
    : { source_event_ref: { org:r.org, agent:r.agent, generation:r.generation, eventId:r.eventId }, ...(r.mailId ? { mail_id:r.mailId } : {}) }, selection:r.selection.selector }
  if (r.docId || r.workItemId) {
    return {
      id: (r.docId || r.workItemId)!,
      kind: r.workItemId ? 'work_item' : 'document',
      ...(r.workItemId ? { slug: r.workItemId } : {}),
      org: r.org,
      from: r.sender ?? r.agent,
      at: '',
      gist: r.quote.slice(0, MAX_REPLY_QUOTE),
    }
  }
  return { source_event_ref: { org: r.org, agent: r.agent, generation: r.generation, eventId: r.eventId },
    quoted_context: r.quote.slice(0, MAX_REPLY_QUOTE), ...(r.mailId ? { mail_id: r.mailId } : {}),
    ...(r.sender ? { sender: r.sender } : {}) }
}

export function replyContext(value: unknown): ReplyContext | null {
  if (!value || typeof value !== 'object') return null
  const wire = value as Partial<EventReplyWire> & { from?: string }
  const sender = typeof wire.sender === 'string' && wire.sender ? wire.sender
    : typeof wire.from === 'string' && wire.from ? wire.from : undefined
  const context = { ...wire.source_event_ref, quote: wire.quoted_context, mailId: wire.mail_id,
    ...(sender ? { sender } : {}), ...(wire.selection ? { selection: wire.selection } : {}) }
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
  if (current.some(r => r.org !== next.org || r.agent !== next.agent || r.generation !== next.generation)) throw Error('A multi-reply can only answer events in this transcript.')
  if (current.some(r => r.agent === next.agent && r.generation === next.generation && r.eventId === next.eventId && r.mailId === next.mailId && r.docId === next.docId && r.workItemId === next.workItemId && JSON.stringify(r.selection?.selector) === JSON.stringify(next.selection?.selector))) return current
  const selections = [...current, next].filter(r => r.selection)
  if (selections.length > 8 || new TextEncoder().encode(JSON.stringify(selections.map(r=>r.selection))).length > 48*1024) throw Error("A reply allows 8 selected passages and 48 KiB of selection metadata.")
  if (current.length >= 50) throw Error('A multi-reply can answer at most 50 messages.')
  return [...current, next]
}

export function selectionReplyContext(draft: SelectionDraft, desk: EventSourceRef): ReplyContext {
  const target=draft.target
  const identity=typeof target==='object' && 'source_event_ref' in target ? target.source_event_ref : { ...desk,eventId:typeof target==='object' && 'kind'in target ? `${target.kind}:${'slug'in target?target.slug:target.id}` : `mail:${target}` }
  return {...identity,quote:draft.snapshot.excerpt.slice(0,MAX_REPLY_QUOTE),selection:draft.snapshot,
    ...(typeof target==='object' && 'mail_id' in target ? {mailId:target.mail_id}:{}),
    ...(typeof target==='object' && 'kind' in target && target.kind==='document' ? {docId:target.id}:{}),
    ...(typeof target==='object' && 'kind' in target && target.kind==='work_item' ? {workItemId:target.slug}:{})}
}

/** Optimistic display keeps the captured quote; outgoing replyWire remains
 * identity/selector-only so the server never trusts caller-owned prose. */
export function displayReplyWire(reply:ReplyContext):MailReplyWire {
  const wire=replyWire({...reply,selection:undefined})
  return reply.selection ? {...wire,selection:reply.selection} as MailReplyWire : wire
}

/** Panel projections consume the org's ordered records; no fetching or timers. */
import type { RecordTable } from './recordfeed'
import type { RuntimeTable } from './recordoverlay'
import type { EventsPayload, HistoryItem, InboxPayload, MailEntry, SentMailEntry } from './types'

const numericId = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
const rows = <T>(records: RecordTable, entity: string): T[] =>
  [...(records.get(entity) ?? [])].sort(([a], [b]) => numericId(a, b)).map(([, value]) => value as T)

export function projectUserInbox(records: RecordTable): InboxPayload {
  return {
    pending: rows<MailEntry>(records, 'user_inbox'),
    delivered: rows<MailEntry>(records, 'user_mail_log:shared'),
    sent: rows<SentMailEntry>(records, 'user_outbox:shared'),
  }
}

export function projectEvents(records: RecordTable): EventsPayload {
  const count = records.get('org')?.get('events_count') as { events_count: number } | undefined
  return { total: count?.events_count ?? 0, events: rows(records, 'event:shared') }
}

export function projectHistory(records: RecordTable, agent: string): HistoryItem[] {
  return [...(records.get(`agent_history:${agent}`) ?? [])].sort(([a, av], [b, bv]) => {
    const at = (av as HistoryItem).at, bt = (bv as HistoryItem).at
    if (at !== bt) return at < bt ? -1 : 1
    const [ak, ai] = a.split(':'), [bk, bi] = b.split(':')
    return ak === bk ? numericId(ai, bi) : ak === 'event' ? -1 : 1
  }).map(([, body]) => body as HistoryItem)
}

interface MailRecord {
  folder: 'pending' | 'delivered' | 'sent'
  order: (number | string)[]
  mail: MailEntry | SentMailEntry
  batch?: string
}
function order(a: MailRecord['order'], b: MailRecord['order']) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length - b.length
}

export function projectMailbox(records: RecordTable, runtime: RuntimeTable, agent: string): InboxPayload {
  const result: InboxPayload = { pending: [], delivered: [], sent: [] }
  const stages = runtime.get(agent)?.mail_stages as Record<string, string> | undefined
  const values = [...(records.get(`agent_mail:${agent}`)?.values() ?? [])] as MailRecord[]
  for (const body of values.sort((a, b) => a.folder === b.folder ? order(a.order, b.order) : a.folder < b.folder ? -1 : 1)) {
    const stage = body.batch === undefined ? undefined : stages?.[body.batch]
    const mail = stage ? { ...body.mail, stage } : body.mail
    if (body.folder === 'sent') result.sent.push(mail as SentMailEntry)
    else result[body.folder].push(mail)
  }
  return result
}

import type { Segment } from '../generated/events'
import { decodeEventRow, isEvent, record } from './decode'
import type { EventProfile } from './decode'

type AnySegment = Segment
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key)
const optionalString = (o: Record<string, unknown>, key: string) => !own(o, key) || typeof o[key] === 'string'
function validError(value: unknown): boolean {
  return record(value) && typeof value.code === 'string'
    && typeof value.path === 'string' && typeof value.expected === 'string'
}
function validEventFields(row: Record<string, unknown>, segment = false): boolean {
  const key = segment ? 'event' : 'ev'
  if (own(row, 'ev_error') && !validError(row.ev_error)) return false
  return !own(row, key) || isEvent(row[key])
}
/** Wire composition is validated separately from its leaves. An unknown shape
 * keeps the original transcript text; it never enters the exhaustive renderer. */
export function isSegments(value: unknown, profile: EventProfile): value is AnySegment[] {
  if (!Array.isArray(value)) return false
  return value.every(segment => {
    if (!record(segment) || typeof segment.kind !== 'string') return false
    switch (segment.kind) {
      case 'text': return typeof segment.text === 'string'
      case 'state': case 'drive': return typeof segment.text === 'string' && validEventFields(segment, true)
      case 'mail': case 'notices': return Array.isArray(segment.rows) && segment.rows.every(row => {
        if (!record(row) || typeof row.at !== 'string' || !validEventFields(row)) return false
        if (segment.kind === 'notices') return typeof row.text === 'string'
        return typeof row.from === 'string' && typeof row.kind === 'string' && typeof row.body === 'string'
          && optionalString(row, 'id') && optionalString(row, 'via') && optionalString(row, 'stage') && optionalString(row, 'ref')
          && (!own(row, 'relationship') || row.relationship === null || typeof row.relationship === 'string')
          && (!own(row, 'attachments') || Array.isArray(row.attachments))
          && (!own(row, 'attachments_missing') || (Array.isArray(row.attachments_missing) && row.attachments_missing.every(x => typeof x === 'string')))
          && (!own(row, 'reply_to') || record(row.reply_to))
          && ['model_only','retracted','delivering'].every(k => !own(row, k) || typeof row[k] === 'boolean')
      })
      default: return false
    }
  })
}
/** Durable identities only: prose and display titles never match a typed send. */
export function segmentMailIds(value: unknown, profile: EventProfile): Set<string> {
  const ids = new Set<string>()
  if (isSegments(value, profile)) for (const segment of value) {
    if (segment.kind === 'mail') for (const row of segment.rows) {
      if (row.id && decodeEventRow(row, profile).kind === 'known') ids.add(row.id)
    }
  }
  return ids
}

/** The composer-minted submission names carried by mail segment rows
 *  (PendingMail.client_op — the server stores the value post_mail was given
 *  and journal copies carry it into every projection). Unlike a mail id this
 *  is OUR OWN minted string: recognizing it needs no event decode — presence
 *  on a validated segment row is the evidence, and a legacy row simply never
 *  carries one. */
export function segmentClientOps(value: unknown, profile: EventProfile): Set<string> {
  const ops = new Set<string>()
  if (isSegments(value, profile)) for (const segment of value) {
    if (segment.kind === 'mail') for (const row of segment.rows) {
      const op = (row as { client_op?: unknown }).client_op
      if (typeof op === 'string' && op) ops.add(op)
    }
  }
  return ops
}

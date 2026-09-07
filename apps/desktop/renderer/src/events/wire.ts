import type { Segment, PublicSegment } from '../generated/events'
import { decodeEventRow, isEvent, isPublicEvent, record } from './decode'
import type { EventProfile } from './decode'

type AnySegment = Segment | PublicSegment
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key)
const optionalString = (o: Record<string, unknown>, key: string) => !own(o, key) || typeof o[key] === 'string'
function validError(value: unknown, profile: EventProfile): boolean {
  return record(value) && typeof value.code === 'string'
    && (profile === 'public' ? Object.keys(value).every(k => k === 'code')
      : typeof value.path === 'string' && typeof value.expected === 'string')
}
function validEventFields(row: Record<string, unknown>, profile: EventProfile, segment = false): boolean {
  const key = profile === 'operator' ? segment ? 'event' : 'ev' : segment ? 'event_public' : 'ev_public'
  const wrong = profile === 'operator' ? segment ? 'event_public' : 'ev_public' : segment ? 'event' : 'ev'
  if (own(row, wrong) || (profile === 'public' && own(row, 'ev_raw'))) return false
  if (own(row, 'ev_error') && !validError(row.ev_error, profile)) return false
  return !own(row, key) || (profile === 'operator' ? isEvent(row[key]) : isPublicEvent(row[key]))
}
/** Wire composition is validated separately from its leaves. An unknown shape
 * keeps the original transcript text; it never enters the exhaustive renderer. */
export function isSegments(value: unknown, profile: EventProfile): value is AnySegment[] {
  if (!Array.isArray(value)) return false
  return value.every(segment => {
    if (!record(segment) || typeof segment.kind !== 'string') return false
    switch (segment.kind) {
      case 'text': return typeof segment.text === 'string'
      case 'state': case 'drive': return typeof segment.text === 'string' && validEventFields(segment, profile, true)
      case 'mail': case 'notices': return Array.isArray(segment.rows) && segment.rows.every(row => {
        if (!record(row) || typeof row.at !== 'string' || !validEventFields(row, profile)) return false
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

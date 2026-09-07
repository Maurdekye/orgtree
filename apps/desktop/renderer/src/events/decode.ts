import schema from '../generated/events.schema.json'
import type { Event, PublicEvent } from '../generated/events'

export type EventProfile = 'operator' | 'public'
export type DecodeResult<T> =
  | { kind: 'known'; event: T; fallback: string }
  | { kind: 'legacy'; fallback: string }
  | { kind: 'unsupported'; fallback: string; code: 'profile' | 'version' | 'variant' | 'invalid' }

type Shape = {
  $ref?: string; type?: string; const?: unknown; enum?: readonly unknown[]
  oneOf?: readonly Shape[]; anyOf?: readonly Shape[]
  properties?: Readonly<Record<string, Shape>>; required?: readonly string[]
  additionalProperties?: boolean; items?: Shape; minItems?: number
}
// This is the generated schema's vocabulary, not an event cast. Unknown
// schema keywords fail closed so a generator change cannot weaken validation.
const defs: Readonly<Record<string, Shape>> = schema.$defs
const keywords = new Set(['$ref', 'type', 'const', 'enum', 'oneOf', 'anyOf',
  'properties', 'required', 'additionalProperties', 'items', 'minItems'])
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matches(value: unknown, shape: Shape | undefined, budget: { left: number }, depth = 0): boolean {
  if (!shape || --budget.left < 0 || depth > 96) return false
  if (Object.keys(shape).some(k => !keywords.has(k))) return false
  if (shape.$ref) {
    if (!shape.$ref.startsWith('#/$defs/')) return false
    return matches(value, defs[shape.$ref.slice(8)], budget, depth + 1)
  }
  if (shape.oneOf) return shape.oneOf.filter(s => matches(value, s, budget, depth + 1)).length === 1
  if (shape.anyOf) return shape.anyOf.some(s => matches(value, s, budget, depth + 1))
  if (own(shape, 'const')) return value === shape.const
  if (shape.enum) return shape.enum.some(v => value === v)
  switch (shape.type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'array': return Array.isArray(value) && value.length >= (shape.minItems ?? 0)
      && value.every(v => matches(v, shape.items, budget, depth + 1))
    case 'object': {
      if (!record(value) || !shape.properties || shape.additionalProperties !== false) return false
      if (shape.required?.some(k => !own(value, k))) return false
      return Object.keys(value).every(k => own(shape.properties!, k)
        && matches(value[k], shape.properties![k], budget, depth + 1))
    }
    default: return false
  }
}

function indexLeaves(name: 'Event' | 'PublicEvent') {
  const leaves = new Map<string, Shape>()
  for (const branch of defs[name]?.oneOf ?? []) {
    const leaf = branch.$ref && defs[branch.$ref.slice(8)]
    const variant = leaf && leaf.properties?.variant?.const
    if (leaf && typeof variant === 'string') leaves.set(variant, leaf)
  }
  return leaves
}
const privateLeaves = indexLeaves('Event')
const publicLeaves = indexLeaves('PublicEvent')
export function isEvent(value: unknown): value is Event {
  return record(value) && typeof value.variant === 'string'
    && matches(value, privateLeaves.get(value.variant), { left: 200000 })
}
export function isPublicEvent(value: unknown): value is PublicEvent {
  return record(value) && typeof value.variant === 'string'
    && matches(value, publicLeaves.get(value.variant), { left: 200000 })
}

export function decodeEventRow(row: unknown, profile: 'operator'): DecodeResult<Event>
export function decodeEventRow(row: unknown, profile: 'public'): DecodeResult<PublicEvent>
export function decodeEventRow(row: unknown, profile: EventProfile): DecodeResult<Event | PublicEvent>
export function decodeEventRow(row: unknown, profile: EventProfile): DecodeResult<Event | PublicEvent> {
  const fallback = record(row)
    ? typeof row.body === 'string' ? row.body : typeof row.text === 'string' ? row.text : '' : ''
  if (!record(row)) return { kind: 'unsupported', fallback, code: 'invalid' }
  const key = profile === 'public' ? 'ev_public' : 'ev'
  const wrongKey = profile === 'public' ? 'ev' : 'ev_public'
  if (own(row, wrongKey)) return { kind: 'unsupported', fallback, code: 'profile' }
  if (!own(row, key)) return own(row, 'ev_error') || own(row, 'ev_raw')
    ? { kind: 'unsupported', fallback, code: 'invalid' } : { kind: 'legacy', fallback }
  const value = row[key]
  if (!record(value)) return { kind: 'unsupported', fallback, code: 'invalid' }
  if (value.v !== 1) return { kind: 'unsupported', fallback, code: 'version' }
  const leaves = profile === 'public' ? publicLeaves : privateLeaves
  if (typeof value.variant !== 'string' || !leaves.has(value.variant))
    return { kind: 'unsupported', fallback, code: 'variant' }
  if (profile === 'operator' && isEvent(value)) return { kind: 'known', event: value, fallback }
  if (profile === 'public' && isPublicEvent(value)) return { kind: 'known', event: value, fallback }
  return { kind: 'unsupported', fallback, code: 'invalid' }
}

/** Transport sender USER also carries engine work; only explicit origin is authorship. */
export function isAuthoredUser(event: Event | PublicEvent): boolean {
  return event.actor.kind === 'user'
}

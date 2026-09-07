import { MANIFEST } from '../generated/events'
import { isEvent, isPublicEvent, record } from './decode'
import type { EventProfile } from './decode'
import type { KnownEvent } from './project'

export type HumanValue =
  | { kind: 'text'; text: string }
  | { kind: 'scalar'; value: number | boolean | null }
  | { kind: 'list'; items: HumanValue[] }
  | { kind: 'record'; fields: { key: string; label: string; value: HumanValue }[] }
  | { kind: 'event'; event: KnownEvent }
  | { kind: 'unavailable' }

interface FieldSpec { type: string; disposition: string; public: boolean }
type Fields = Readonly<Record<string, FieldSpec>>
const records: Readonly<Record<string, Fields>> = MANIFEST.records
const refs: Readonly<Record<string, Fields>> = MANIFEST.refs
const unions: Readonly<Record<string, readonly string[]>> = MANIFEST.unions
const leaves: Readonly<Record<string, { fields: Fields }>> = MANIFEST.leaves

export function fieldType(variant: string, key: string): string {
  const spec = leaves[variant]?.fields[key]
  if (!spec) throw new Error('Missing event field disposition')
  return spec.type
}

function recordValue(value: unknown, fields: Fields | undefined, profile: EventProfile): HumanValue {
  if (!record(value) || !fields) return { kind: 'unavailable' }
  return { kind: 'record', fields: Object.entries(fields)
    .filter(([key, spec]) => Object.hasOwn(value, key)
      && (spec.disposition === 'both' || spec.disposition === 'human_only')
      && (profile === 'operator' || spec.public))
    .map(([key, spec]) => ({ key, label: key.replaceAll('_', ' '),
      value: humanValue(value[key], spec.type, profile) })) }
}

/** Interpret the generated type vocabulary, never message text. Every nested
 * field uses its explicit disposition; unknown schema forms display no data. */
export function humanValue(value: unknown, type: string, profile: EventProfile): HumanValue {
  if (value === null) return { kind: 'scalar', value: null }
  if (type.endsWith('?')) return humanValue(value, type.slice(0, -1), profile)
  if (type.startsWith('[')) {
    const end = type.lastIndexOf(']')
    return Array.isArray(value) && end > 0
      ? { kind: 'list', items: value.map(v => humanValue(v, type.slice(1, end), profile)) }
      : { kind: 'unavailable' }
  }
  if (type === 'E:Event') {
    if (profile === 'operator' && isEvent(value)) return { kind: 'event', event: value }
    if (profile === 'public' && isPublicEvent(value)) return { kind: 'event', event: value }
    return { kind: 'unavailable' }
  }
  if (type.startsWith('N:')) return recordValue(value, records[type.slice(2)], profile)
  if (type.startsWith('R:')) return recordValue(value, refs[type.slice(2)], profile)
  if (type.startsWith('U:') && record(value)) {
    for (const name of unions[type.slice(2)] ?? []) {
      const fields = records[name]
      const discriminator = fields?.kind?.type
      if (discriminator?.startsWith('L[') && typeof value.kind === 'string'
        && discriminator.slice(2, -1).split('|').includes(value.kind))
        return recordValue(value, fields, profile)
    }
    return { kind: 'unavailable' }
  }
  if ((type === 'str' || type.startsWith('L[')) && typeof value === 'string') return { kind: 'text', text: value }
  if ((type === 'int' || type === 'float') && typeof value === 'number') return { kind: 'scalar', value }
  if (type === 'bool' && typeof value === 'boolean') return { kind: 'scalar', value }
  return { kind: 'unavailable' }
}

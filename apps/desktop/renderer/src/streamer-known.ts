import { knownScreenValues } from '../../../../packages/contracts/streamer'
const values = new Set<string>(), listeners = new Set<() => void>()
let overflow = false
export function rememberScreenValues<T>(value: T): T {
  let changed = false
  for (const item of knownScreenValues(value)) {
    if (values.has(item)) continue
    if (values.size >= 10_000) { overflow = true; changed = true; break }
    values.add(item); changed = true
  }
  if (changed) for (const listener of listeners) listener()
  return value
}
export const screenKnownValues = () => [...values]
export const screenKnownReady = () => !overflow
export function watchScreenKnown(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

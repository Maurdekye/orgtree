import { useSyncExternalStore } from 'react'
import type { ProviderTier } from '../types'

let tiers = new Map<string, ProviderTier>()
let revision = 0, signature = ''
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const FAST_MODE_HELP = 'Faster responses at higher usage. Applies next turn; keeps the same model and conversation. Provider eligibility still applies.'

/** Replace rather than accumulate: loss of advertised support hides old controls. */
export function syncFastModes(providers: { tiers?: ProviderTier[] }[]): void {
  const rows = providers.flatMap(p => p.tiers ?? [])
  const next = JSON.stringify(rows.map(t => [t.tier, t.fast_mode, t.fast_mode_versions, t.legacy_version]))
  if (next === signature) return
  signature = next; tiers = new Map(rows.map(t => [t.tier, t])); revision++
  listeners.forEach(fn => fn())
}
export function fastModeSupported(tier?: string | null, version?: string | null, catalog?: ProviderTier): boolean {
  const row = catalog ?? tiers.get(tier ?? '')
  return version ? row?.fast_mode_versions?.[version] === true : row?.fast_mode === true
}
/** What a blank version means on a seat that exists, when it is not the latest (Fable: "5.1"). */
export function tierLegacyVersion(tier?: string | null): string | undefined {
  return tiers.get(tier ?? '')?.legacy_version ?? undefined
}
/** The version a seat that exists runs: its pin, else the legacy default its tier names. */
export function seatVersion(tier?: string | null, version?: string | null): string | undefined {
  return version || tierLegacyVersion(tier)
}
export function useFastMode(tier?: string | null, version?: string | null): boolean {
  useSyncExternalStore(subscribe, () => revision)
  return fastModeSupported(tier, version)
}

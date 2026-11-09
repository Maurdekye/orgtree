import { MODEL_VERSIONS } from './shared'
import { tierLegacyVersion } from './fastmode'

/**
 * The blank option of the gear's Model version row. On a seat that exists, blank means what the tier's legacy default
 * is (Fable: 5.1), so it says so; on a move into a tier, blank is a new hire's choice and the engine pins the latest.
 */
export function blankVersionLabel(tier: string, switching: boolean): string {
  const legacy = switching ? undefined : tierLegacyVersion(tier)
  return legacy ? `default (${legacy})` : `latest (${(MODEL_VERSIONS[tier] ?? [])[0]})`
}

/**
 * The gear save's model_version. An explicit pick (or an explicit blank on a seat that exists) is sent as chosen; a
 * switch with no pick is left to the engine when the target tier pins a version for a new hire (Fable 5.2) and
 * otherwise clears a stale version as before; an edit that never touched the version sends none.
 */
export function versionScopePayload(a: { tier: string, switching: boolean, edited: boolean, version: string }): { model_version?: string } {
  const versions = MODEL_VERSIONS[a.tier] ?? []
  const picked = versions.includes(a.version) ? a.version : ''
  if (a.edited) return { model_version: picked }
  if (!a.switching) return {}
  if (!picked && tierLegacyVersion(a.tier)) return {}
  return { model_version: picked }
}

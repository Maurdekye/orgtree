import { MODEL_VERSIONS } from './shared'

/** (stub in the red commit) */
export function blankVersionLabel(tier: string, _switching: boolean): string {
  return `latest (${(MODEL_VERSIONS[tier] ?? [])[0]})`
}
/** (stub in the red commit) */
export function versionScopePayload(a: { tier: string, switching: boolean, edited: boolean, version: string }): { model_version?: string } {
  const versions = MODEL_VERSIONS[a.tier] ?? []
  return a.edited || a.switching ? { model_version: versions.includes(a.version) ? a.version : '' } : {}
}

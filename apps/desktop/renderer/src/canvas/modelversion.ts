import { MODEL_VERSIONS } from './shared'

/**
 * The blank option of a Model version row. Blank is LATEST everywhere: on a seat, on a move into a tier and on a
 * retired seat, it follows the tier's newest version as releases add them; a picked version is a pin that never
 * changes (USER 2026-11-18 m62f2d7627923: 'there should be no "default" setting').
 */
export function blankVersionLabel(tier: string): string {
  return `latest (${(MODEL_VERSIONS[tier] ?? [])[0]})`
}

/**
 * The gear save's model_version. An explicit pick (an explicit blank included: back to latest) is sent as chosen; a
 * switch with no pick clears a version of the old tier, so the seat starts on the new tier's latest; an edit that
 * never touched the version sends none.
 */
export function versionScopePayload(a: { tier: string, switching: boolean, edited: boolean, version: string }): { model_version?: string } {
  const versions = MODEL_VERSIONS[a.tier] ?? []
  const picked = versions.includes(a.version) ? a.version : ''
  if (a.edited) return { model_version: picked }
  if (!a.switching) return {}
  return { model_version: picked }
}

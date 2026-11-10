import type { UsageLimit } from '../types'

/**
 * THE FABLE PIP (USER 2026-11-10 18:11:26Z ma76204ba37d2; formula ruled
 * 18:15:42Z m9c19aae87fb3 "Yes, r = ½"; docket
 * usage-fable-pip-on-the-claude-weekly-meter).
 *
 * A Claude account can carry a separate Fable weekly limit (`weekly_scoped`,
 * model "Fable …") beside its all-models weekly limit (`weekly_all`). Fable
 * use counts against both. Once weekly (all models) usage passes
 *
 *     p = (1 + f) / 2      f = the Fable weekly fraction used, 0..1
 *
 * the rest of the Fable allowance can no longer be used up before the
 * all-models limit is reached (one full Fable allowance is taken as half of
 * the weekly limit: the fixed r = ½ the user ruled, not a measured ratio).
 *
 * Returns p as a percentage of the weekly (all models) bar, or null when no
 * pip is shown:
 *   - the readout has no weekly (all models) bar, or it is not shown;
 *   - no Fable weekly reading, or it is unknown or stale-unreadable (the
 *     caller's `known`: the same rule that decides whether that bar renders);
 *   - Fable is at 100% used: nothing is left to exhaust.
 * Only Fable scopes count. Other providers' scoped windows (Gemini model
 * groups, Codex named limits) never produce a pip, because only Claude has
 * a Fable model.
 */
export const FABLE_PIP_TITLE =
  "Past this point, the rest of this week's Fable allowance can't be used up before the weekly limit"

/** The pip's hover text (USER 2026-11-10 23:45:52Z m62522a70ecb4 "make
 *  hovering the pip show the usage percentage"): the pip's own position as a
 *  weekly-usage percentage, then the Fable share used (f = 2p - 1, exact for
 *  p = (1 + f) / 2), then the explanation. Both are whole numbers. A missing
 *  or non-finite position shows no number at all, never "0%". */
export const fablePipTitle = (at: number | null): string => {
  if (at == null || !Number.isFinite(at)) return FABLE_PIP_TITLE
  const fable = Math.max(0, Math.min(100, 2 * at - 100))
  return `${Math.round(at)}% weekly usage · Fable ${Math.round(fable)}% used · ${FABLE_PIP_TITLE}`
}

export const isFableWeekly = (l: UsageLimit): boolean =>
  l.kind === 'weekly_scoped' && /\bfable\b/i.test(l.model ?? '')

export const fablePipPercent = (limits: readonly UsageLimit[],
  known: (l: UsageLimit) => boolean): number | null => {
  const weekly = limits.find(l => l.kind === 'weekly_all')
  if (!weekly || !known(weekly)) return null
  const fable = limits.find(l => isFableWeekly(l) && known(l))
  if (!fable || fable.percent == null || !Number.isFinite(fable.percent)) return null
  const f = Math.max(0, Math.min(1, fable.percent / 100))
  if (f >= 1) return null
  return ((1 + f) / 2) * 100
}

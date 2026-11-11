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
 * The engine computes the same pip for usage watchdogs: engine/rs/orgtree-engine/src/usage/fable_pip.rs (keep the two in step).
 * Only Fable scopes count. Other providers' scoped windows (Gemini model
 * groups, Codex named limits) never produce a pip, because only Claude has
 * a Fable model.
 */
export const FABLE_PIP_TITLE =
  "Past this point, the rest of this week's Fable allowance can't be used up before the weekly limit"

/** The pip's hover text (USER 2026-11-10 23:51:33Z ma05bce0c2983 "keep the
 *  existing caption just add the percentage to the phrase"): the caption word
 *  for word, with the pip's own weekly-usage position, as a whole percent,
 *  after "this point". A missing or non-finite position leaves the caption
 *  unchanged, never "0%". */
export const fablePipTitle = (at: number | null): string =>
  at == null || !Number.isFinite(at) ? FABLE_PIP_TITLE
    : FABLE_PIP_TITLE.replace('Past this point,', `Past this point (${Math.round(at)}%),`)

/** THE UNREACHABLE END (USER 2026-11-11 11:04:55Z m49c4c03b6da4 "highlight
 *  the end of the fable bar in red that can't be reached because the weekly
 *  limit would be hit first"). With w = weekly (all models) used and f = Fable
 *  used, the weekly room left buys at most 2(1 - w) of Fable (the same r = ½),
 *  so Fable can reach at most c = f + 2(1 - w). Once weekly is past the pip
 *  (w > (1 + f) / 2) that is under 100%, and the Fable bar is red from
 *  max(f, c) to 100%; at w >= 100% that is f. Returns that start as a
 *  percentage of the Fable bar, or null: no pip (the pip's own rules), weekly
 *  not past it, or nothing left to mark. */
export const fableUnreachableFrom = (limits: readonly UsageLimit[],
  known: (l: UsageLimit) => boolean): number | null => {
  const pip = fablePipPercent(limits, known)
  if (pip == null) return null
  const weekly = limits.find(l => l.kind === 'weekly_all')?.percent
  const fable = limits.find(l => isFableWeekly(l) && known(l))?.percent
  if (weekly == null || fable == null || !Number.isFinite(weekly) || !(weekly > pip)) return null
  const f = Math.max(0, fable)
  const from = Math.max(f, f + 2 * (100 - weekly))
  return from < 100 ? from : null
}

/** Its hover text (USER 2026-11-11 11:05:21Z "put the max percentage there on
 *  hover"): the most Fable can reach this week as a whole percent; no number
 *  when the value is unknown. */
export const fableUnreachableTitle = (from: number | null): string =>
  from == null || !Number.isFinite(from)
    ? "Fable can't reach the rest of this bar this week: the weekly limit comes first"
    : `Fable can reach at most ${Math.round(from)}% this week: the weekly limit comes first`

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

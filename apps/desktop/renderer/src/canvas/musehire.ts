// canvas/musehire.ts — where a Muse hire that names no account should go.
//
// A Muse seat runs only on a login whose own catalog offers its model
// (independent review 2026-10-13, round 2): Wonder Full on a profile is not
// Wonder Full on the user's own login. A hire that names no account lands on
// the org's default Muse account, else the user's own login, and the engine
// refuses it there when that login does not offer the model. So when the
// warm availability already says that login cannot run it, the hire surfaces
// name an eligible login instead: the first SUBSCRIPTION login (by the
// engine's order) that offers it. A metered API key is never picked for the
// user; it is chosen explicitly. When the landing login's catalog is not
// known, nothing is named and the engine decides at the door.
import { MUSE_TIERS, museLogin, museOffersOn } from './shared'
import { peekStaffingOptions } from './staffingoptions'

/** The login a Muse hire naming no account lands on: the org's default
 *  account when it is a Muse login, else the user's own (null). */
export const museLandingAccount = (orgDefault: string | null | undefined): string | null =>
  orgDefault && museLogin(orgDefault)?.account === orgDefault ? orgDefault : null

/** The account a hire of `tier` in `org` should name, or undefined to name
 *  none (not a Muse tier, the landing login offers it or is not known, or no
 *  eligible subscription login offers it — the engine then says why). */
export function museHireAccount(org: string, tier: string, orgDefault: string | null | undefined): string | undefined {
  if (!MUSE_TIERS.includes(tier)) return undefined
  if (museOffersOn(tier, null, museLandingAccount(orgDefault)) !== false) return undefined
  const offered = peekStaffingOptions(org)?.tiers?.find((t) => t.tier === tier)
  return offered?.accounts?.find((a) => a.kind !== 'apikey' && museOffersOn(tier, null, a.value) !== false)?.value
}

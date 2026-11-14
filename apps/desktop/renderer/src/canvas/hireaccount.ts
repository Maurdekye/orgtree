// canvas/hireaccount.ts: the account a hire names by itself.
//
// USER RULING 2026-11-14 08:44:53Z, "Pre-select an account". A hire that names
// no account lands on the organization's default account, else on the engine's
// own sign-in. On an engine whose own sign-in is signed out (a headless engine
// is signed in to account folders) that hire was made and its first turn
// failed. So the hire surfaces name an account that can run the model, where
// the form shows it and the user can change it:
//
//   1. the organization's default account, when it can run the model;
//   2. else nothing, when the engine's own sign-in can run it (as before);
//   3. else the first account the engine lists for the model.
//
// The engine lists only accounts that can run it now (switched on, signed in,
// not at a limit) and, from 4.6.0 on, in the order of room: sooner reset
// first, then lower usage, an account whose usage is not known after those
// that are (`domain::staffing::eligible_accounts`). An older engine lists them
// by name. A metered API key is never picked for the user, as with Muse.
//
// Everything comes from the warm staffing answer: nothing is fetched when a
// form opens. With no answer yet, or a model it does not list, nothing is
// named and the engine decides at the door.
import { MUSE_TIERS } from './shared'
import { museHireAccount } from './musehire'
import { peekStaffingOptions } from './staffingoptions'

/** The account a hire of `tier` in `org` should name, or undefined to name none. */
export function hireAccount(org: string, tier: string, orgDefault: string | null | undefined): string | undefined {
  // a Muse seat goes by each login's own catalog (`museHireAccount`)
  if (MUSE_TIERS.includes(tier)) return museHireAccount(org, tier, orgDefault)
  const offered = peekStaffingOptions(org)?.tiers?.find((t) => t.tier === tier)
  if (!offered) return undefined
  if (orgDefault && offered.accounts.some((a) => a.value === orgDefault)) return orgDefault
  // `native_ok` adds the own sign-in's usage to `default_ok`; an engine from before it has only the latter
  if (offered.native_ok ?? offered.default_ok) return undefined
  return offered.accounts.find((a) => !a.ambient && a.kind !== 'apikey')?.value
}

// canvas/hireaccount.ts: the account a hire names by itself.
//
// USER RULING 2026-11-14 08:44:53Z, "Pre-select an account" (order ruled by
// the coordinator the same day). A hire that names no account lands on the
// organization's default account, else on the engine's own sign-in, whether
// or not that one can run the model. On an engine whose own sign-in is signed
// out (a headless engine is signed in to account folders) that hire was made
// and its first turn failed. So the hire surfaces pick who runs it, the form
// shows the pick in its Account row, and the user can change it there:
//
//   1. the organization's default account, when it can run the model (a
//      metered key too: the user chose it as the default);
//   2. else the one with the most room among the engine's own sign-in and the
//      accounts that can run the model, ranked together: a reset within a day
//      first, then lower usage; one whose usage is not known after every one
//      that is. An account or sign-in with a window the model spends at 100%
//      is not among them. A metered key is never picked for the user.
//   3. nothing can run it: nothing is named (and the tile is greyed).
//
// The engine does the ranking (`by_room` of the staffing answer,
// `domain::staffing::room_order`, 4.6.0 on). An engine from before it lists
// the accounts by name and says nothing of room: there the own sign-in comes
// first when it can run the model, as a hire went before, else the first
// account by name.
//
// WHAT IS RETURNED is what the hire must say to land on the pick. A hire that
// says nothing already lands on the default account or, with none, on the own
// sign-in: when that is the pick, nothing is named, and the form shows that
// sign-in as it always did. In every other case the pick is named, the own
// sign-in too (`<provider>/primary`), so a hire can never fall through to a
// default account that cannot run the model.
//
// Everything comes from the warm staffing answer: nothing is fetched when a
// form opens. With no answer yet, or a model it does not list, nothing is
// named and the engine decides at the door.
import { primaryAccount } from '../accountidentity'
import { MUSE_TIERS, providerOf } from './shared'
import { museHireAccount } from './musehire'
import { peekStaffingOptions } from './staffingoptions'

/** The organization's default account as an account id: null when there is
 *  none, or when it is the engine's own sign-in under one of its names. */
const defaultAccountId = (orgDefault: string | null | undefined): string | null => {
  const value = orgDefault?.trim()
  return !value || value === 'primary' || value === 'default' || value.endsWith('/primary') ? null : value
}

/** The account a hire of `tier` in `org` should name, or undefined to name none. */
export function hireAccount(org: string, tier: string, orgDefault: string | null | undefined): string | undefined {
  // a Muse seat goes by each login's own catalog (`museHireAccount`)
  if (MUSE_TIERS.includes(tier)) return museHireAccount(org, tier, orgDefault)
  const offered = peekStaffingOptions(org)?.tiers?.find((t) => t.tier === tier)
  if (!offered) return undefined
  const own = primaryAccount(offered.provider ?? providerOf(tier))
  const chosen = defaultAccountId(orgDefault)
  // 1. the default account can run it: a plain hire lands there, and the form shows it
  if (chosen && offered.accounts.some((a) => a.value === chosen)) return undefined
  // 2. the most room, as the engine ranks it; an older engine has no ranking
  const ownOk = offered.native_ok ?? offered.default_ok
  const ranked = offered.by_room
    ?? [...(ownOk ? [own] : []), ...offered.accounts.filter((a) => !a.ambient && a.kind !== 'apikey').map((a) => a.value)]
  const pick = ranked[0]
  if (pick === undefined) return undefined
  // saying nothing lands on the own sign-in only while there is no default account
  return pick === own && !chosen ? undefined : pick
}

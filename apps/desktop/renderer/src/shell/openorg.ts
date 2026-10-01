// shell/openorg.ts — what the renderer does about each way of opening an
// organization.
//
// `requestOrg` is the ONLY route: the Homepage list, the compact menu, the
// tray and a notification target all go through it, and it answers by
// MUTATING the native registry as it decides — which is what makes "two
// windows asking for the same organization in the same tick focus exactly one
// window" true rather than hopeful.
//
// ⚠ EXACTLY ONE OUTCOME CHANGES THE CALLING WINDOW. `bound` means this window
// is now that organization's Canvas. `focused`, `opened` and `pending` all
// mean the native side has it in hand somewhere else and this window does
// nothing at all — in particular it does NOT fall back to switching its own
// organization, which is the v2 behaviour the whole window model replaces.
//
// ⚠ AND THE RENDERER NEVER TOUCHES A RESERVATION TICKET. Native reservations
// are host-internal. An `opened` outcome is information, not a job.
import { desktop } from '../desktop'
import type { OrgOpenOutcome } from '../desktop'

export interface OpenOrgEffect {
  /** bind THIS window to this organization — the only window-changing case */
  bind?: string
  /** a short, non-blocking thing to say */
  notice?: string
  /** something went wrong and the person needs to be able to act on it */
  error?: string
}

/** Refusal reasons in words somebody can act on. An unknown reason is
 *  reported verbatim rather than swallowed: a refusal nobody can read is
 *  worse than an ugly one. */
export function refusalText(reason: string, name: string): string {
  switch (reason) {
    case 'invalid-org':
      return `${name} is not a valid organization.`
    case 'already-open':
      return `${name} is already open in another window.`
    case 'already-bound':
      return 'This window already belongs to an organization. Use New window to open another.'
    case 'not-a-creation-window':
      return 'Only a creation window can finish creating an organization.'
    case 'unknown-window':
      return 'This window is no longer registered. Reopen it and try again.'
    default:
      return `Could not open ${name}: ${reason}`
  }
}

/** Translate one outcome into what this window should do about it. */
export function openOrgEffect(outcome: OrgOpenOutcome, name: string): OpenOrgEffect {
  switch (outcome.action) {
    case 'bound':
      return { bind: outcome.org }
    case 'focused':
      // the Homepage that asked stays exactly where it was — the settled rule
      // is one main window per organization and this window is not it
      return { notice: `${name} is already open — brought its window to the front.` }
    case 'opened':
    case 'pending':
      return {}
    case 'refused':
      return { error: refusalText(outcome.reason, name) }
    default:
      return {}
  }
}

/** Ask to open an organization, and say what this window should do.
 *
 *  ⚠ WITHOUT THE v3 BRIDGE THIS BINDS. A plain browser and the shipped
 *  single-window shell have exactly one window, so "open this organization"
 *  has always meant "show it here" and must go on meaning that. The window
 *  model is what makes binding conditional, and where there is no window model
 *  there is nothing to condition it on. */
export async function requestOpenOrg(org: string, name = org): Promise<OpenOrgEffect> {
  const bridge = desktop()
  if (!bridge?.requestOrg) return { bind: org }
  try {
    return openOrgEffect(await bridge.requestOrg(org), name)
  } catch (e) {
    return { error: `Could not open ${name}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

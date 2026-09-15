import fs from 'node:fs'

/** THE HARMLESS DUAL-ENTRY UPDATE FIXTURE.
 *
 *  Both supported upgrade entry points — the in-app Update button's self-update
 *  handoff, and a manually launched installer — must be able to target ONE
 *  harmless fixture executable, so their arguments, process ancestry,
 *  visibility, durable phase logs, shutdown behaviour and relaunch behaviour can
 *  be compared directly instead of argued about.
 *
 *  THE MANUAL ROUTE NEEDS NOTHING FROM THIS MODULE, and that is the point of
 *  the contract rather than an omission: the fixture is an ordinary
 *  installer-shaped executable, so running it by hand IS the manual route, on
 *  the same binary the in-app route hands off to. Only the in-app route needs a
 *  substitution, and this decides whether it may have one.
 *
 *  ⚠ WHY THE SWITCH IS PACKAGING METADATA AND NOT AN ENVIRONMENT VARIABLE.
 *  The requirement is that a production build must not EXPOSE or ACCEPT the
 *  substitution mechanism. An environment variable read by shipped code is a
 *  mechanism a production build accepts — the guard would be the variable's
 *  value, set by whoever is running the app, and not the build itself. So the
 *  CAPABILITY lives in the build-info.json that packaging writes beside the
 *  app, in the same place and shape the release/dev channel already lives, and
 *  the published packaging path never writes it. The environment variable then
 *  only chooses WHICH fixture to use on a build that was already built to
 *  permit one; on a published build it decides nothing at all.
 *
 *  ⚠ AND IT FAILS CLOSED, in the same direction readBuildChannel fails. A
 *  missing file, unreadable JSON, or an absent or non-`true` field is NOT
 *  capable. Failing the other way would turn a corrupt metadata file into a
 *  build that accepts a substituted installer, which is the single outcome this
 *  must never produce.
 *
 *  ⚠ A REFUSAL IS NOT SILENCE. When a build that may not substitute is asked to,
 *  the decision says so and carries the reason, because the caller records it.
 *  A stray variable in an operator's environment must never change what an
 *  installed release does AND must never do so invisibly — "it was ignored" has
 *  to be readable afterwards, or the next person debugging an update has one
 *  more indistinguishable hypothesis. */

/** Names the fixture executable to hand off to. Read only on a build whose
 *  packaging metadata already permits a substitution. */
export const UPDATE_FIXTURE_ENV = 'ORGTREE_UPDATE_FIXTURE'

/** Whether THIS BUILD was packaged to permit an update-fixture substitution.
 *  Published artifacts never carry the field, so they are never capable. */
export function readFixtureCapability(
  file: string, io: Pick<typeof fs, 'readFileSync'> = fs): boolean {
  try {
    const parsed: unknown = JSON.parse(io.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object'
      && (parsed as Record<string, unknown>).updateFixture === true
  } catch { return false }
}

export type FixtureDecision =
  /** No fixture was asked for. The ordinary handoff runs untouched. */
  | { kind: 'off' }
  /** Hand off to this executable instead of the downloaded installer. */
  | { kind: 'active', installer: string }
  /** A fixture was asked for and this build may not have one, or the one it
   *  named is not there. The ordinary handoff runs untouched and the caller
   *  records the reason. */
  | { kind: 'refused', reason: string }

export interface FixtureInputs {
  /** The raw environment value, if any. */
  requested?: string
  /** readFixtureCapability against this build's own metadata. */
  capable: boolean
  /** Injected so the decision stays pure and testable. */
  exists: (file: string) => boolean
}

export function updateFixtureDecision(
  { requested, capable, exists }: FixtureInputs): FixtureDecision {
  const named = (requested ?? '').trim()
  if (!named) return { kind: 'off' }
  if (!capable) {
    return {
      kind: 'refused',
      reason: `${UPDATE_FIXTURE_ENV} named [${named}] but this build was not `
        + 'packaged to accept an update-fixture substitution; the ordinary '
        + 'installer handoff was used unchanged',
    }
  }
  if (!exists(named)) {
    return {
      kind: 'refused',
      reason: `${UPDATE_FIXTURE_ENV} named [${named}], which does not exist; `
        + 'the ordinary installer handoff was used unchanged',
    }
  }
  return { kind: 'active', installer: named }
}

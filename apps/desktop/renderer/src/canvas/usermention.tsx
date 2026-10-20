// canvas/usermention.tsx — the USER, drawn the one way an @user mention is
// drawn, wherever the user holds a slot, keeps a listener or watch, or listens
// to a mail queue where an agent's name would stand (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20 13:50Z,
// coordinator m0c7ed2b83916: "render the standard user mention, the same chip
// an @user mention gets elsewhere. Don't use the word 'you'").
//
// The engine names these rows "user": a word no agent can be given
// (`valid_name` reserves it), so it is unambiguous in a slot list, a line or a
// listener table. This is the DESK'S one place that turns it into the chip, and
// the chip is the app's own: `RefChip` of the user's inbox reference, exactly
// what a mention of @user in prose resolves to (refmd.tsx), so its class, label,
// tooltip and click are the standard ones. A surface that cannot open the
// inbox draws it inert, still @user.

import { RefChip, resolveRef } from './reflinks'
import { USER_NAME, isUserName } from './username'
import type { RefRoutes, RefWorld, ResolvedRef } from './reflinks'

export { USER_NAME, isUserName }

/** The user's inbox reference as an @user mention resolves it (refmd.tsx
 *  `@user`): a ready mail ref, labelled "@user". */
export function userMentionRef(world: RefWorld): ResolvedRef {
  const resolved = resolveRef({ kind: 'mail', org: world.org, box: 'user', id: '@user' }, world)
  return {
    ...resolved,
    token: '@user',
    label: '@user',
    why: resolved.outcome === 'ready' ? "open the user's inbox" : resolved.why,
  }
}

/** The user as the standard @user mention chip. With the surface's `refs` it is
 *  a control that opens the user's inbox; without them, the same chip inert. */
export function UserMention({ refs }: { refs?: RefRoutes }) {
  const r = userMentionRef(refs?.world ?? { org: '' })
  return <RefChip r={refs ? r : { ...r, outcome: 'ready' }} onOpen={refs?.onOpen} />
}

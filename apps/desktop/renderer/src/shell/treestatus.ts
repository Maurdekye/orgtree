// shell/treestatus.ts — how fresh the organization tree on screen is.
//
// The Attention view's queue has THREE sources. Two of them — attention-marked
// tickets and urgent mail — it polls itself. The third, unanswered questions,
// it reads out of the `tree` prop that App owns. So a completeness gate built
// only from its own two feeds can answer cleanly and empty while the tree is a
// poll behind or its refresh has failed, and print "nothing is waiting on you
// here" with a question actually waiting. That is the one claim the gate
// exists to protect, and it is the reassuring one, which is what makes it
// worth a signal rather than a comment.
//
// ⚠ WHAT THIS MEANS, AND THE THREE THINGS IT DOES NOT.
//
// It is the status of the LATEST OBSERVED READ of the tree: did the last fetch
// succeed, and when. It is NOT a coherent snapshot across sources — App's tree
// and Attention's feeds are separate requests with separate sample times, and
// nothing here pretends otherwise. It is NOT knowledge that no question has
// been raised since; nothing can know that, and a gate claiming it would be
// the same over-claim in a new place. And ORDINARY POLLING LATENCY IS NOT A
// GAP: only a FAILED refresh is stale. If plain age counted, the hedge would
// be permanent, and a permanent hedge is one nobody reads — which costs
// exactly the trust it was added for.
import type { TreePayload } from '../types'

/** ⚠ THE CANONICAL TYPE, IMPORTED — NOT MIRRORED. This file used to declare
 *  its own structural copy of `PolledStatus`, because `canvas/shared.ts` was
 *  in another worktree when it was written. The copy compiled, matched
 *  field-for-field, and was exactly the shape that drifts silently: nothing
 *  would have failed on the day the two stopped agreeing. v3-attention-opus
 *  asked for the import the moment their module landed here, and they were
 *  right — their own §6 exists because "I compared the two interfaces" had
 *  already been false once.
 *
 *  The DERIVATION below stays here. It rides App's one coalesced `getTree`
 *  and applies the same applicability rule the fetch path uses to decide
 *  whether to paint a body, which `usePolledStatus` cannot know about. Type
 *  theirs, derivation ours. */
export type { PolledStatus } from '../canvas/shared'
import type { PolledStatus } from '../canvas/shared'

/** What App records from the one coalesced tree fetch. */
export interface TreeRead {
  /** when an APPLICABLE body last landed — not when a request last returned */
  at: number | null
  error: string | null
}

/** Derive the published status.
 *
 *  ⚠ "HELD" IS SCOPED TO THE ORGANIZATION ON SCREEN. A tree for the
 *  organization we have since left is not a value we hold for this one, so a
 *  window mid-switch reports `loading` rather than certifying its
 *  predecessor's payload. That is the same applicability rule the fetch path
 *  uses to decide whether to paint a body at all, applied to the claim about
 *  it — one rule, not two that can drift.
 *
 *  Kept pure and exported so the four cases that matter can be tested without
 *  a clock, a server or a mounted tree. */
export function treeStatusOf(read: TreeRead, tree: TreePayload | null,
  slug: string | null): PolledStatus {
  const held = !!tree && !!slug && tree.slug === slug
  const failed = read.error !== null
  return {
    loading: !held && !failed,
    failed,
    stale: held && failed,
    unavailable: !held && failed,
    at: read.at,
    error: read.error,
  }
}

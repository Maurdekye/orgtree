// canvas/effort.tsx — ONE answer to "is this agent's thinking effort
// non-default, and what level is it actually running at", shared verbatim by
// the zoomed-out canvas card (cards.tsx) and the desk header (desk.tsx).
//
// THE PROBLEM (docket `show-non-default-effort-level-on-agent-headers`). An
// agent's configured reasoning effort was invisible everywhere except the
// composer's own effort control, which you only see once the desk is open and
// which says what the turn WILL run at rather than whether that is unusual.
// So an agent deliberately pinned above or below the org default looked
// exactly like every other agent on the canvas.
//
// ⚠ THE DEFAULT IS NOT A CONSTANT IN THIS FILE, AND MUST NOT BECOME ONE.
// `ledger.Org.effective_effort` resolves a turn's effort as
//
//     scope.effort || org.default_effort || ""      → clamped to EFFORTS,
//                                                      else DEFAULT_EFFORT
//
// and the tree payload ships BOTH halves of that fallback — `default_effort`
// (the org's own override, "" = fall through) and `effort_default` (what ""
// resolves to, which ledger.py annotates "so no UI string has to hardcode
// it"). An org that sets `default_effort: low` has a default of low, and a
// renderer with `high` baked into it would then put an "Effort" card on every
// agent that was left alone and omit it from the one that was changed —
// precisely inverted. The org default therefore arrives through
// `OrgDefaultEffort` from the tree, and this module holds no level of its own.
//
// ⚠ AND THE VALUE SHOWN IS `effort_effective`, NOT `scope.effort`. That is the
// same lesson desk.tsx's EffortButton records after being reported three times
// (read the value that CAUSES the behaviour, not one that correlates with it):
// `effort_effective` is `Org.effective_effort` computed server-side, so it is
// clamped the way the runtime clamps and it cannot disagree with the --effort
// flag the turn is launched with. `scope.effort` is read for exactly one
// question — "was this agent pinned at a SUPPORTED level at all" — because an
// unset agent FOLLOWS the default live and has nothing to report, however that
// default later changes.
//
// ⚠ AN UNSUPPORTED STORED LEVEL IS TREATED AS NO CONFIGURATION AT ALL, and the
// clamp is why that is not the same statement as "it runs at the org default".
// `effective_effort` falls back to `Org.DEFAULT_EFFORT` for a value outside
// EFFORTS — NOT to `org.default_effort` — so in an org whose default is `low`,
// an agent carrying a junk level actually runs at `high`, and a card reading
// only the effective value would advertise "Effort high, set on this agent"
// for a level nobody ever chose. The configured value is therefore validated
// against the supported list first, and anything else renders nothing
// (multi-window-design, 2026-09-21).

import { createContext, useContext } from 'react'
import type { CanvasNode } from './shared'
import type { OpResult } from '../types'

/** the levels orgtree offers, in order — mirrors `ledger.Org.EFFORTS` and is
 *  the one list the composer's five-dot effort control (desk.tsx) and these
 *  cards share, so the two can never offer or describe different levels.
 *  Typed `readonly string[]` rather than a literal tuple on purpose: every
 *  reader here compares it against a plain string coming off the payload. */
export const EFFORT_LEVELS: readonly string[] =
  ['low', 'medium', 'high', 'xhigh', 'max']

/** one supported level, or not — the single validity test in this file, so
 *  "is this a level orgtree offers" is asked the same way everywhere */
const validLevel = (v: string | null | undefined): v is string =>
  !!v && EFFORT_LEVELS.includes(v)

/** THE ORG'S ORDINARY DEFAULT, ALREADY RESOLVED — the level an agent with no
 *  setting of its own actually runs at. `''` means "this render has not been
 *  told", and the helpers below then decline to call anything non-default
 *  rather than guess a level and be confidently wrong about which agents are
 *  unusual.
 *
 *  ⚠ RESOLVED, NOT RAW. Put `resolveOrgDefault(tree.default_effort,
 *  tree.effort_default)` in here — never one of those fields on its own and
 *  never an `||` of the two; see the function for why that is not the same
 *  thing.
 *
 *  Provided once, in OrgCanvas, beside `OrgKillswitchContext` — that provider
 *  wraps every mount site of both surfaces (canvas cards, the canvas desk,
 *  switchboard panels, the mobile sheet and pinned desk windows), which is
 *  what makes "the two surfaces cannot disagree" structural rather than a
 *  convention two call sites have to keep. */
export const OrgDefaultEffort = createContext<string>('')

export const useOrgDefaultEffort = (): string => useContext(OrgDefaultEffort)

/**
 * The org's ordinary default, resolved exactly as `ledger.Org.effective_effort`
 * resolves it with `scope.effort` empty: the org's own `default_effort` when it
 * names a supported level, else `effort_default`, which the payload ships as
 * what `""` resolves to "so no UI string has to hardcode it".
 *
 * ⚠ THE TWO FIELDS ARE NOT INTERCHANGEABLE AND `||` CANNOT JOIN THEM. `||`
 * cannot tell "unset" from "unsupported": a truthy but unsupported override
 * short-circuits it and takes the authoritative fallback with it, leaving this
 * function nothing to resolve from — and the backend does the OPPOSITE there,
 * clamping to DEFAULT_EFFORT, which is precisely the fallback that was thrown
 * away. Written the `||` way, one junk org field made the entire feature go
 * silent for every agent in the org instead of degrading (measured 2026-09-21,
 * caught in review of the first candidate).
 *
 * ⚠ AND THIS IS NOT THE INVALID-AGENT-SETTING RULE. An unsupported value on an
 * AGENT means "no configured level to report", and silence there is deliberate.
 * An unsupported value on the ORG means "fall through", because the org default
 * is a fact about what everyone else runs at, not a claim this agent made.
 *
 * `''` only when neither field names a level this renderer supports. Note that
 * `EFFORT_LEVELS` is hand-copied from the backend (`Org.EFFORTS` is not in the
 * tree payload), so a level added server-side would land here as unrecognised;
 * falling through to `effort_default` keeps the rest of the org described
 * instead of blanking all of it, which is the best a stale list can do.
 */
export function resolveOrgDefault(
  override: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (validLevel(override)) return override
  if (validLevel(fallback)) return fallback
  return ''
}

/** What this agent's turns ACTUALLY launch at, preferring the server-derived
 *  answer over the stored one. `own` is already known-supported by the time
 *  this is called, so the two normally agree; the fallback covers payload
 *  shapes that predate `effort_effective` and the synthetic bearer/draft cards
 *  that carry a stub scope, and it gives up rather than inventing a level. */
function runningEffort(
  node: Pick<CanvasNode, 'effort_effective'>, own: string,
): string {
  if (validLevel(node.effort_effective)) return node.effort_effective
  return validLevel(own) ? own : ''
}

/**
 * THE WHOLE RULE, in one place: the level to show on the headers, or `null`
 * for "render nothing at all" — no card, and no reserved space for one.
 *
 * `null` covers four distinct cases, deliberately collapsed because the header
 * has the same thing to say about all of them (nothing):
 *
 *   · the agent has no effort of its own — it follows the org default live,
 *     so there is no configured level to report;
 *   · what it carries is not a supported level, so it is not a configuration
 *     this card can report (see the clamp note at the top of the file);
 *   · its own level and the org default are the SAME — it is running at the
 *     ordinary default, which is not news;
 *   · this render was given no org default, so "non-default" is not a claim
 *     it can support.
 *
 * `orgDefault` is the ALREADY-RESOLVED default (see `resolveOrgDefault`); it is
 * validated here rather than re-resolved, so a call site that hands over a raw
 * field goes quiet instead of comparing against something the runtime would
 * never use.
 */
export function nonDefaultEffort(
  node: Pick<CanvasNode, 'scope' | 'effort_effective'>,
  orgDefault: string | null | undefined,
): string | null {
  const own = node.scope?.effort || ''
  if (!validLevel(own)) return null
  if (!validLevel(orgDefault)) return null
  const running = runningEffort(node, own)
  if (!running || running === orgDefault) return null
  return running
}

/**
 * The compact header card itself — the same `.badge` language as the account,
 * route, cost and lifecycle chips beside it, a SIGN and never an action (the
 * card's badge row is a row of signs; `ActionBadge` in cards.tsx records why).
 * The control that CHANGES the level stays where it was, in the composer, on
 * the open desk.
 *
 * ⚠ ONE COMPONENT SERVES BOTH SURFACES, mounted unchanged in `.sq-badges` and
 * in `.cc-head-meta`, so the text, the tooltip and the appear/disappear rule
 * are single-sourced. It reads the org default from context rather than from a
 * prop for the same reason: there is no second path for a call site to get
 * wrong, and a live change to either the agent's effort or the org default
 * re-renders both surfaces from the one fact.
 */
export function EffortLevelBadge({ node }: {
  node: Pick<CanvasNode, 'scope' | 'effort_effective'>
}) {
  const orgDefault = useOrgDefaultEffort()
  const level = nonDefaultEffort(node, orgDefault)
  // `level` is non-null only once nonDefaultEffort has validated BOTH it and
  // `orgDefault`, so everything below is working with supported levels.
  if (!level) return null
  // ⚠ THE NAME, AND NOTHING ELSE. The first candidate also carried the
  // DIRECTION — an `above`/`below` class that coloured the chip, and a tooltip
  // reading "(above the org default, medium)" — on the reasoning that the
  // ticket's problem statement is about telling when an agent runs "above or
  // below the default". The user ruled against it directly on the item
  // (2026-09-21): "no just the effort name no need for extra info". So the card
  // states the level and stops, and `orgDefault` is used for the one thing it
  // is still needed for — deciding whether to appear at all.
  const detail = `thinking effort — ${level}`
  return (
    <span className="badge effort-level" data-effort-level={level}
      title={detail} aria-label={detail}>
      Effort {level}
    </span>
  )
}

/** What changing an agent's effort did, as the one-line toast the composer's
 *  effort control shows (item support-changing-a-claude-agent-s-effort-level-m).
 *
 *  The server answers a saved effort with `effort_delivery`: `sent` means the
 *  level was written to the agent's RUNNING Claude process, `next_turn` means
 *  it applies when its next turn starts. ⚠ "SENT", NEVER "APPLIED": the CLI
 *  acknowledges the request, which proves it was accepted, not that the turn
 *  used it — the Agent SDK documents the change as taking effect next turn.
 *  A reply without the field (an older engine) keeps the plain wording. */
export function effortChangeToast(
  nodeId: string, requested: string, result: OpResult | undefined,
): string {
  const d = result?.effort_delivery as
    { delivery?: string, effort?: string } | undefined
  const level = validLevel(d?.effort) ? d.effort : ''
  const what = requested
    ? `${nodeId} thinking effort: ${requested}`
    : `${nodeId} thinking effort: back to the org default${level ? ` (${level})` : ''}`
  if (d?.delivery === 'sent') return `${what} — sent to the running agent`
  if (d?.delivery === 'next_turn') return `${what} — applies from its next turn`
  return what
}

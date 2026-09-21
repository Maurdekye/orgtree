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

/** the levels orgtree offers, in order — mirrors `ledger.Org.EFFORTS` and is
 *  the one list the composer's five-dot effort control (desk.tsx) and these
 *  cards share, so the two can never offer or describe different levels.
 *  Typed `readonly string[]` rather than a literal tuple on purpose: every
 *  reader here compares it against a plain string coming off the payload. */
export const EFFORT_LEVELS: readonly string[] =
  ['low', 'medium', 'high', 'xhigh', 'max']

/** THE ORG'S ORDINARY DEFAULT, raw from the tree — `tree.default_effort ||
 *  tree.effort_default`. Empty string means "this render has not been told",
 *  which is NOT the same as "the default is unset": every real tree payload
 *  carries `effort_default`, and the helpers below decline to call anything
 *  non-default while the value is missing rather than guessing a level and
 *  being confidently wrong about which agents are unusual.
 *
 *  Provided once, in OrgCanvas, beside `OrgKillswitchContext` — that provider
 *  wraps every mount site of both surfaces (canvas cards, the canvas desk,
 *  switchboard panels, the mobile sheet and pinned desk windows), which is
 *  what makes "the two surfaces cannot disagree" structural rather than a
 *  convention two call sites have to keep. */
export const OrgDefaultEffort = createContext<string>('')

export const useOrgDefaultEffort = (): string => useContext(OrgDefaultEffort)

/** the org default as the RUNTIME would resolve it for an agent that has no
 *  setting of its own: `Org.effective_effort` with `scope.effort` empty. `''`
 *  only when the caller has no usable tree fact to resolve from. */
export function resolveOrgDefault(raw: string | null | undefined): string {
  const eff = raw || ''
  if (!eff) return ''
  return EFFORT_LEVELS.includes(eff)
    ? eff
    // an org-level value outside EFFORTS is clamped by the backend exactly
    // like a node-level one, and this renderer cannot name what it clamps TO
    // without hardcoding DEFAULT_EFFORT — so the render simply has no default
    // to compare against, and says nothing.
    : ''
}

/** What this agent's turns ACTUALLY launch at, preferring the server-derived
 *  answer over the stored one. `own` is already known-supported by the time
 *  this is called, so the two normally agree; the fallback covers payload
 *  shapes that predate `effort_effective` and the synthetic bearer/draft cards
 *  that carry a stub scope, and it gives up rather than inventing a level. */
function runningEffort(
  node: Pick<CanvasNode, 'effort_effective'>, own: string,
): string {
  const derived = node.effort_effective || ''
  if (EFFORT_LEVELS.includes(derived)) return derived
  return EFFORT_LEVELS.includes(own) ? own : ''
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
 */
export function nonDefaultEffort(
  node: Pick<CanvasNode, 'scope' | 'effort_effective'>,
  orgDefaultRaw: string | null | undefined,
): string | null {
  const own = node.scope?.effort || ''
  if (!EFFORT_LEVELS.includes(own)) return null
  const orgDefault = resolveOrgDefault(orgDefaultRaw)
  if (!orgDefault) return null
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
  const orgDefaultRaw = useOrgDefaultEffort()
  const level = nonDefaultEffort(node, orgDefaultRaw)
  if (!level) return null
  const orgDefault = resolveOrgDefault(orgDefaultRaw)
  // "above"/"below" is exactly what the ticket's problem statement asks a
  // reader to be able to tell at a glance. Both indexes are known-good here
  // (`level` reached us through the runtime's own clamp, `orgDefault` through
  // resolveOrgDefault), so the comparison is a fact rather than a guess.
  const dir = EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(orgDefault)
    ? 'above' : 'below'
  const detail = `thinking effort — ${level}, set on this agent `
    + `(${dir} the org default, ${orgDefault})`
  return (
    <span className={'badge effort-level ' + dir}
      data-effort-level={level}
      title={detail} aria-label={detail}>
      Effort {level}
    </span>
  )
}

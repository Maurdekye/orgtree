// canvas/bulkcompact.tsx — CHEAP-COMPACT MANY AGENTS AT ONCE (docket
// `add-bulk-cheap-compact-context-menu-actions`, user request 2026-09-23:
// "cheap-compacting agents one at a time is cumbersome when the intended target
// is every agent or an entire branch of the organization").
//
// TWO DOORS, ONE IMPLEMENTATION. "Cheap-compact all agents…" on the eye card
// and "Cheap-compact subtree…" in every agent's menu (agentmenu.tsx, so the
// card, the Agents List row and every agent-nav chip carry it alike) both
// build a target list and hand it to the SAME plan, confirm and executor here.
//
// ⚠ NOTHING HERE IS A NEW DEFINITION OF "MAY BE CHEAP-COMPACTED". Each target
// goes through the one existing operator op, `cheap_compact`, which keeps every
// backend check it already had (authority, live seat, no open background
// tasks). The plan's skip rules follow the desk's own `canCompactContext` gate
// (desk.tsx; planBulkCompact names the one, safe-side difference) — the only
// door the single action has — plus ONE rule the single
// action does not need: an agent that is MID-TURN is skipped, never interrupted
// and never has its session swapped out from under the running turn. The
// single op has no in-flight guard (supervisor.py says so at the cli-compaction
// site), so the bulk run asks the backend for one explicitly (`if_idle`), which
// re-checks under the document lock and refuses with 409 instead — that covers
// an agent that STARTED a turn between the confirm and its turn in the queue.
//
// SEQUENTIAL, ON PURPOSE. Each compaction is a locked load-mutate-save of the
// whole org document plus a transcript export, so running them in parallel
// would only queue them on the same lock while making the outcome order
// unreadable. One at a time, and a failure is recorded and the run carries on:
// one refusal never aborts an otherwise eligible batch.

import type { ReactNode } from 'react'
import type { ToastFn } from '../types'
import { ConfirmModal } from './modals'
import type { CanvasNode, OpFn } from './shared'

/** why a target was left out of a bulk run, in words the operator reads */
export const SKIP_BUSY = 'mid-turn — never interrupted for a bulk compaction'
export const SKIP_UNRUN = 'already compacted — its session has not run since'
export const SKIP_EMPTY = 'no measured context to compact'

export interface BulkCompactPlan {
  /** the agents the run will attempt, in tree order */
  eligible: CanvasNode[]
  /** the agents it will NOT attempt, each with its reason */
  skipped: { id: string; reason: string }[]
}

/** A real, live seat — not the eye, a draft, a lineage ghost or a retired
 *  agent. Those are not "agents of the org" for this purpose at all, so they
 *  are left out silently rather than listed as skipped. */
function isLiveSeat(n: CanvasNode): boolean {
  return n.state === 'live' && !n.isBearerOf && !n.bearer_state
}

/** `root` and every live agent below it, in tree order (the root first). The
 *  selected agent is PART of its own subtree: "compact this branch" includes
 *  the branch's head. */
export function subtreeAgents(root: CanvasNode): CanvasNode[] {
  const out: CanvasNode[] = []
  const seen = new Set<string>()
  const walk = (n: CanvasNode) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    if (isLiveSeat(n)) out.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  return out
}

/** Every live agent in `map` — the "all agents" door's target list. */
export function allAgents(map: Map<string, CanvasNode>): CanvasNode[] {
  return [...map.values()].filter(isLiveSeat)
}

/**
 * Split `targets` into what the run will attempt and what it will skip.
 * The skip rules follow `canCompactContext` in desk.tsx — the gate that decides
 * whether the single cheap-compact is offered at all — plus the mid-turn rule.
 * ⚠ ONE DIFFERENCE, on the safe side: an open desk reads the context size from
 * its chat payload first (`chat?.occupancy ?? node.occupancy`), and a menu has
 * no chat payload, so this reads the tree's `occupancy` only. An agent whose
 * size is known only to its open desk is skipped as "no measured context"
 * rather than compacted.
 */
export function planBulkCompact(targets: CanvasNode[]): BulkCompactPlan {
  const eligible: CanvasNode[] = []
  const skipped: BulkCompactPlan['skipped'] = []
  for (const n of targets) {
    if (!isLiveSeat(n)) continue
    if (n.busy) skipped.push({ id: n.id, reason: SKIP_BUSY })
    else if (n.compacted_unrun) skipped.push({ id: n.id, reason: SKIP_UNRUN })
    else if (!(typeof n.occupancy === 'number' && n.occupancy > 0)
      || !(typeof n.context_window === 'number' && n.context_window > 0)) {
      skipped.push({ id: n.id, reason: SKIP_EMPTY })
    } else eligible.push(n)
  }
  return { eligible, skipped }
}

export interface BulkCompactOutcome {
  compacted: string[]
  /** skipped before sending (the plan) or refused as mid-turn by the backend */
  skipped: { id: string; reason: string }[]
  failed: { id: string; reason: string }[]
}

/** One bulk run at a time. A second request while one is running would
 *  interleave two queues over the same agents; it is refused with a toast
 *  instead. Module-level, like agentmenu.tsx's `continuing`. */
let running = false

/** for tests: whether a run is in flight */
export const bulkCompactRunning = (): boolean => running

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

const listed = (rows: { id: string; reason: string }[]) =>
  rows.map((r) => `${r.id} (${r.reason})`).join('; ')

/** The final report — every target named under exactly one outcome. */
export function bulkCompactSummary(scope: string, o: BulkCompactOutcome): string[] {
  const lines: string[] = []
  if (o.compacted.length) {
    lines.push(`Cheap-compacted ${plural(o.compacted.length, 'agent')} (${scope}): `
      + `${o.compacted.join(', ')}. Each old session is consultable in its lineage.`)
  }
  if (o.skipped.length) {
    lines.push(`Skipped ${plural(o.skipped.length, 'agent')}: ${listed(o.skipped)}.`)
  }
  if (o.failed.length) {
    lines.push(`Could not cheap-compact ${plural(o.failed.length, 'agent')}: `
      + `${listed(o.failed)}.`)
  }
  if (!lines.length) lines.push(`No agents to cheap-compact (${scope}); nothing changed.`)
  return lines
}

/**
 * Execute the plan: one normal `cheap_compact` op per eligible agent, in
 * order, each with `if_idle` so the backend refuses (409) rather than swap the
 * session of an agent that became busy after the plan was made. Returns the
 * outcome and toasts a start line and the final per-target summary.
 */
export async function cheapCompactAgents(scope: string, plan: BulkCompactPlan,
  op: OpFn, toast: ToastFn): Promise<BulkCompactOutcome | null> {
  if (running) {
    toast(['A bulk cheap-compaction is already running; wait for its summary '
      + 'before starting another.'])
    return null
  }
  running = true
  const outcome: BulkCompactOutcome = {
    compacted: [], skipped: [...plan.skipped], failed: [],
  }
  try {
    if (plan.eligible.length) {
      toast([`Cheap-compacting ${plural(plan.eligible.length, 'agent')} (${scope}), `
        + 'one at a time — a summary follows when the run finishes.'])
    }
    for (const target of plan.eligible) {
      try {
        // quiet: the final summary reports every refusal, so the shared op
        // wrapper must not also toast "error: …" for a target the summary
        // calls a skip
        await op({ op: 'cheap_compact', node: target.id, if_idle: true },
          { quiet: true })
        outcome.compacted.push(target.id)
      } catch (e) {
        const err = e as Error & { status?: number }
        if (err.status === 409) outcome.skipped.push({ id: target.id, reason: SKIP_BUSY })
        else outcome.failed.push({ id: target.id, reason: err.message || 'refused' })
      }
    }
  } finally {
    running = false
  }
  toast(bulkCompactSummary(scope, outcome))
  return outcome
}

/** The confirm both doors raise: it states the exact selection — who will be
 *  compacted and who will be skipped, and why — before anything happens. */
export function BulkCompactConfirm({ title, scope, targets, op, toast, close }: {
  title: ReactNode
  /** short words for the selection, used in the toasts ("all agents",
   *  "subtree of lead") */
  scope: string
  targets: CanvasNode[]
  op: OpFn
  toast: ToastFn
  close: () => void
}) {
  const plan = planBulkCompact(targets)
  const n = plan.eligible.length
  const body = <>
    <p>{n
      ? `${plural(n, 'agent')} will be cheap-compacted, one at a time: `
        + `${plan.eligible.map((t) => t.id).join(', ')}. Each keeps its seat, `
        + 'name, team, charter and mailbox and starts its next turn with a fresh, '
        + 'empty session; its old session is archived in place as a consultable '
        + 'knowledge bearer.'
      : 'No agent in this selection can be cheap-compacted right now; nothing '
        + 'will change.'}</p>
    {plan.skipped.length > 0 && (
      <p>{`Skipped (${plan.skipped.length}): ${listed(plan.skipped)}.`}</p>)}
    {n > 0 && <p>No running turn is interrupted: an agent that is mid-turn when
      its compaction comes up is skipped. A refusal for one agent does not stop
      the others; the final summary names every outcome.</p>}
  </>
  return (
    <ConfirmModal title={title} body={body}
      confirmLabel={n ? `cheap-compact ${plural(n, 'agent')}` : 'ok'}
      onConfirm={() => { if (n) void cheapCompactAgents(scope, plan, op, toast) }}
      close={close} />
  )
}

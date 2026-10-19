// One target plan, confirmation and run guard for every bulk Compact menu.
// Cheap retains the existing operator op and if_idle guard. Normal checks the
// actual per-agent harness capability and uses the existing admission endpoint.
// Both run sequentially and report every target; neither interrupts a busy turn.

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { compactCapability, compactNode } from '../api'
import { useCurrentOrg } from '../popout'
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
  // a project node runs no turns: nothing to halt or compact
  return n.state === 'live' && !n.isBearerOf && !n.bearer_state && n.kind !== 'project'
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
    toast(['A bulk compaction is already running; wait for its summary '
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

/** Normal results distinguish admission from completion and refusal from a
 *  failed transport. The actor still rechecks current session/turn state. */
export async function normalCompactAgents(scope: string, plan: BulkCompactPlan,
  slug: string, toast: ToastFn): Promise<(BulkCompactOutcome & {
    refused: { id: string; reason: string }[]
  }) | null> {
  if (running) {
    toast(['A bulk compaction is already running; wait for its summary before starting another.'])
    return null
  }
  running = true
  const outcome = { compacted: [] as string[], skipped: [...plan.skipped],
    failed: [] as { id: string; reason: string }[], refused: [] as { id: string; reason: string }[] }
  try {
    if (plan.eligible.length) toast([`Requesting normal compaction for ${plural(plan.eligible.length, 'agent')} (${scope}), one at a time; a summary follows.`])
    for (const target of plan.eligible) {
      try {
        const result = await compactNode(slug, target.id)
        if (result.started) outcome.compacted.push(target.id)
        else outcome.refused.push({ id: target.id, reason: result.reason ?? 'the request was not admitted' })
      } catch (e) {
        outcome.failed.push({ id: target.id, reason: (e as Error).message || 'request failed' })
      }
    }
  } finally { running = false }
  const lines: string[] = []
  if (outcome.compacted.length) lines.push(`Started normal compaction for ${plural(outcome.compacted.length, 'agent')} (${scope}): ${outcome.compacted.join(', ')}.`)
  if (outcome.skipped.length) lines.push(`Skipped ${plural(outcome.skipped.length, 'agent')}: ${listed(outcome.skipped)}.`)
  if (outcome.refused.length) lines.push(`Refused normal compaction for ${plural(outcome.refused.length, 'agent')}: ${listed(outcome.refused)}.`)
  if (outcome.failed.length) lines.push(`Could not request normal compaction for ${plural(outcome.failed.length, 'agent')}: ${listed(outcome.failed)}.`)
  toast(lines.length ? lines : [`No agents to compact (${scope}); nothing changed.`])
  return outcome
}

/** Presentation-only grouping: plans and admission keep their original reasons. */
function conciseSkip(reason: string): { key: string; suffix: string } {
  if (reason === SKIP_BUSY) return { key: 'busy', suffix: 'mid-turn will not be compacted.' }
  if (reason === SKIP_EMPTY) return { key: 'empty', suffix: 'with no measured context.' }
  if (reason === SKIP_UNRUN) return { key: 'unrun', suffix: 'already compacted and not run since.' }
  if (reason === 'no conversation session to compact') return { key: 'sessionless', suffix: 'with no conversation session.' }
  if (reason === 'the organization is unavailable') return { key: 'org', suffix: 'with an unavailable organization.' }
  if (reason.startsWith('Could not check normal compaction:')) {
    return { key: 'support-check', suffix: 'whose normal-compaction support could not be checked.' }
  }
  if (/unsupported|no normal support|(?:normal compaction|harness|codex).*(?:not available|unavailable|not supported|cannot|does not support|doesn't support)/i.test(reason)) {
    return { key: 'unsupported', suffix: 'on harnesses that do not support compaction.' }
  }
  return { key: reason, suffix: ': ' + reason }
}

const coveredNames = (rows: { id: string }[]) => rows.map(row => row.id).join(', ')

function SkipCounts({ rows }: { rows: BulkCompactPlan['skipped'] }) {
  const groups = new Map<string, { ids: string[]; suffix: string }>()
  for (const row of rows) {
    const { key, suffix } = conciseSkip(row.reason)
    const group = groups.get(key)
    if (group) group.ids.push(row.id)
    else groups.set(key, { ids: [row.id], suffix })
  }
  return <>{[...groups].map(([key, group]) =>
    <p key={key} data-compact-skip={key} title={group.ids.join(', ')}>
      {plural(group.ids.length, 'agent') + (group.suffix.startsWith(':') ? '' : ' ') + group.suffix}
    </p>)}</>
}

/** Two explicit actions with simultaneous previews. Preview reads never compact; confirmation snapshots the
 *  selected plan, while each backend action retains its existing admission. */
export function BulkCompactConfirm({ title, scope, targets, op, toast, close, slug: explicitSlug }: {
  title: ReactNode
  scope: string
  targets: CanvasNode[]
  op: OpFn
  toast: ToastFn
  close: () => void
  slug?: string
}) {
  const currentOrg = useCurrentOrg()
  const slug = explicitSlug ?? currentOrg
  const base = useMemo(() => planBulkCompact(targets), [targets])
  const capKey = JSON.stringify([slug, base.eligible.map(n => [n.id, n.session_id, n.tier, n.model_id, n.scope?.model_version])])
  const [caps, setCaps] = useState<{ key: string; reasons: Record<string, string | null> } | null>(null)
  useEffect(() => {
    setCaps(null)
    let live = true
    const check = async () => {
      const reasons: Record<string, string | null> = Object.create(null)
      for (const target of base.eligible) {
        if (!live) return
        if (!target.session_id) reasons[target.id] = 'no conversation session to compact'
        else if (!slug) reasons[target.id] = 'the organization is unavailable'
        else {
          try {
            const cap = await compactCapability(slug, target.id)
            reasons[target.id] = cap.supported ? null : cap.reason ?? 'Normal compaction is unavailable for this harness.'
          } catch (e) {
            reasons[target.id] = `Could not check normal compaction: ${(e as Error).message}`
          }
        }
      }
      if (live) setCaps({ key: capKey, reasons })
    }
    void check()
    return () => { live = false }
    // The key contains every candidate identity/session/route input. A fresh
    // tree object alone must not restart all reads while a preview is loading.
  }, [capKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const reasons = caps?.key === capKey ? caps.reasons : null
  const checking = !reasons && base.eligible.length > 0
  const normal: BulkCompactPlan = {
    eligible: reasons ? base.eligible.filter(n => reasons[n.id] === null) : [],
    skipped: [...base.skipped, ...(reasons ? base.eligible.filter(n => reasons[n.id] !== null)
      .map(n => ({ id: n.id, reason: reasons[n.id] ?? 'Normal capability is unavailable.' })) : [])],
  }
  const cheapCount = base.eligible.length
  const normalCount = normal.eligible.length
  // These exclusions apply to either action; keep their hover names beside
  // each mode rather than visually attaching them only to Normal.
  const modeSkips = base.skipped.filter(row => row.reason === SKIP_BUSY || row.reason === SKIP_EMPTY)
  const sharedSkips = base.skipped.filter(row => row.reason !== SKIP_BUSY && row.reason !== SKIP_EMPTY)
  const body = <div className="bulk-compact-summary">
    <section data-compact-preview="cheap">
      <p><strong>Cheap compact:</strong> fresh session with a summary handoff (keeps settings and team)</p>
      <p data-compact-count="cheap" title={coveredNames(base.eligible)}>
        {plural(cheapCount, 'agent') + ' will be cheap-compacted, one at a time.'}
      </p>
      <SkipCounts rows={modeSkips} />
    </section>
    <section data-compact-preview="normal">
      <p><strong>Normal compact:</strong> the harness compacts its conversation</p>
      {checking
        ? <p role="status" title={coveredNames(base.eligible)}>
            {'Checking normal compaction support for ' + plural(base.eligible.length, 'agent') + '.'}
          </p>
        : <p data-compact-count="normal" title={coveredNames(normal.eligible)}>
            {plural(normalCount, 'agent') + ' will be compacted, one at a time.'}
          </p>}
      <SkipCounts rows={normal.skipped.slice(base.skipped.length)} />
      <SkipCounts rows={modeSkips} />
    </section>
    <div data-compact-shared-skips><SkipCounts rows={sharedSkips} /></div>
    <p className="bulk-compact-note">Running turns are never interrupted; you'll get a summary of every outcome.</p>
  </div>
  return <ConfirmModal title={title} body={body}
    confirmLabel={`compact ${plural(normalCount, 'agent')}`}
    confirmDisabled={checking || normalCount === 0}
    confirmTitle={checking ? 'Checking normal compaction support' : normalCount ? undefined : 'No eligible agents for normal compaction'}
    onConfirm={() => {
      if (!slug || checking || !normalCount) return
      void normalCompactAgents(scope, normal, slug, toast)
    }}
    altLabel={`cheap-compact ${plural(cheapCount, 'agent')}`} altDisabled={cheapCount === 0}
    onAlt={() => {
      if (!cheapCount) return
      void cheapCompactAgents(scope, base, op, toast)
    }} close={close} />
}

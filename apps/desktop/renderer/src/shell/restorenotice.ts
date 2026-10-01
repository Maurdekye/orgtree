// shell/restorenotice.ts — what restoration could not bring back, said once.
//
// Restoration restores what is available and skips what is not. The settled
// behaviour is that it then says so, briefly — not silently, and not with a
// modal. Two halves reach that one sentence from opposite directions:
//
//   NATIVE knows which saved ORGANIZATION WINDOWS it did not open, and sends
//   them (`restore-skipped`). It originates nothing else: contract v3 made the
//   panel list always empty after multi-window-design pointed out that a
//   native panel store was a second panel store wearing a different hat.
//
//   THE RENDERER knows which saved PANELS inside an organization could not be
//   restored, because the renderer is the only side that holds the saved
//   open-set and the only side that can resolve a panel's target against the
//   organization tree.
//
// ⚠ ONLY WHAT CAN ACTUALLY BE CHECKED IS CHECKED. A saved panel row carries an
// agent, a document or a watchdog. An agent target is resolvable — the tree
// says whether that agent is present and whether it is the same generation —
// so an agent panel that cannot come back is known and is reported. A document
// or watchdog target is NOT resolvable from the tree, so those rows are never
// called skipped. Reporting them on a guess would be worse than saying
// nothing: a notice that names panels which were actually fine teaches the
// reader to ignore the notice.
import type { SavedWindow, WindowRestore } from '../windowlayout'

/** Why a saved panel could not be restored. Both cases are the same to the
 *  reader — the desk they had open is not coming back — but they are
 *  different facts and the distinction is kept for anyone debugging one. */
export type SkipReason =
  /** the agent is not in this organization at all any more */
  | 'agent-gone'
  /** an agent of that name is present, but it is a different generation — a
   *  rehire is a new self, and restoring its predecessor's desk would show
   *  somebody else's conversation under the name the reader remembers */
  | 'agent-replaced'

export interface SkippedPanel {
  /** the saved row's kind, e.g. `desk:[...]` or `agent-gallery` */
  kind: string
  agent: string
  reason: SkipReason
}

type NodeLike = { generation?: number }

/** Resolve one saved row's target. `null` when the row has no agent target,
 *  which means there is nothing here that can be missing. */
export function panelSkip(row: SavedWindow, nodes: Map<string, NodeLike>): SkippedPanel | null {
  const target: WindowRestore | undefined = row.restore
  const agent = target?.agent
  // no agent target, or a target without a usable generation: not something
  // this function is able to call missing, so it does not
  if (!agent || !Number.isSafeInteger(target?.generation)) return null
  const node = nodes.get(agent)
  if (!node) return { kind: row.kind, agent, reason: 'agent-gone' }
  if (node.generation !== target!.generation) {
    return { kind: row.kind, agent, reason: 'agent-replaced' }
  }
  return null
}

/** Every saved panel for one organization that cannot be restored.
 *
 *  Takes the rows rather than reading them, so the caller decides which
 *  organization and which moment — and so this is testable without storage. */
export function skippedPanels(rows: readonly SavedWindow[],
  nodes: Map<string, NodeLike>): SkippedPanel[] {
  const out: SkippedPanel[] = []
  for (const row of rows) {
    // only rows that were OPEN were going to be restored; a closed row being
    // unrestorable is not news
    if (!row.open) continue
    const skip = panelSkip(row, nodes)
    if (skip) out.push(skip)
  }
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The whole notice, in one sentence, or `null` when there is nothing to say.
 *
 *  ⚠ `null` WHEN NOTHING WAS SKIPPED, and that is the common case by a long
 *  way. A restoration notice that appears every launch is furniture; the point
 *  of this one is that seeing it means something really did not come back. */
export function restoreNotice(skippedOrgs: readonly string[],
  panels: readonly SkippedPanel[]): string | null {
  const orgs = skippedOrgs.filter((o) => typeof o === 'string' && o)
  if (!orgs.length && !panels.length) return null
  const parts: string[] = []
  if (orgs.length) {
    parts.push(orgs.length <= 3
      ? `${orgs.join(', ')} could not be reopened`
      : `${plural(orgs.length, 'organization', 'organizations')} could not be reopened`)
  }
  if (panels.length) {
    // the agent is what the reader recognises, not the panel kind, so name
    // agents while there are few enough for a name to help
    const agents = [...new Set(panels.map((p) => p.agent))]
    parts.push(agents.length <= 3
      ? `${plural(panels.length, 'panel', 'panels')} could not be restored (${agents.join(', ')})`
      : `${plural(panels.length, 'panel', 'panels')} could not be restored`)
  }
  return `${parts.join('; ')}.`
}

/** Read a `restore-skipped` payload without trusting it.
 *
 *  Native sends `{ orgs: string[] }` and, per contract v3, an always-empty
 *  `panels`. Anything else in the payload is ignored rather than guessed at:
 *  a malformed event is not evidence that something was skipped, and the one
 *  thing this notice must not do is claim a loss that did not happen. */
export function readSkippedOrgs(payload: unknown): string[] {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray((payload as { orgs?: unknown } | null)?.orgs)
      ? (payload as { orgs: unknown[] }).orgs
      : null
  if (!rows) return []
  return rows.filter((o): o is string => typeof o === 'string' && !!o)
}

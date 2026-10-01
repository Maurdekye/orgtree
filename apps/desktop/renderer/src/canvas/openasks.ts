// canvas/openasks.ts — EVERY OPEN REQUEST WAITING ON THE USER, from one rule.
//
// Two surfaces list the user's open questions: the inbox (as ask rows among
// the mail) and the Attention view. They used to read them only off
// `node.ask`, the batched desk card the tree carries on each node. In v3 the
// tree is a SELECTED read (foregroundtree.ts: "only missing_requested proves
// absence"), so a node outside the selection has no `node.ask` in the payload
// at all — and its open question was listed nowhere (user report 2026-09-29:
// a question card was open while the Attention view listed only a ticket and
// an urgent mail).
//
// The header's `tree.asks` is not selected: it carries EVERY open row
// (ledger header: open questions, pending credit and scope requests) plus the
// recent resolved history. So:
//   • a node that IS in the tree keeps its batched card (FR-14: one card per
//     agent, the union of its open question, credit and scope requests);
//   • every open header row whose node has no batched card here is listed on
//     its own, as the raw row — the same rows the docket already renders with
//     the real AskCard for questions attached to an item.
// Both surfaces call this, so they cannot disagree about what is waiting.

import type { AskInfo, AskTab, TreeNode, TreePayload } from '../types'
import { askSubmitted } from '../asksubmitted'
import type { MailRow } from './shared'

export const askIsOpen = (a: AskInfo | undefined | null): boolean =>
  !!a && (a.status === 'open' || a.status === 'pending')

/** The open requests to list, one entry per batched card or unbatched row.
 *  `nodes` is every node of the tree, flattened.
 *
 *  A card the user has just submitted is not listed (point 31, 2026-09-29:
 *  it leaves every view on the click, ../asksubmitted). Callers re-render on
 *  that store with `useSubmittedAsks`. */
export function openAsks(tree: Pick<TreePayload, 'asks'> | null | undefined,
  nodes: Iterable<TreeNode>): AskInfo[] {
  return openCards(tree, nodes).filter(a => !askSubmitted(a.id))
}

/** How many of the tree's `asks_open` rows sit behind cards the user has
 *  just submitted. `asks_open` counts one per open store row (question,
 *  credit request, scope request), and a batch card resolves one row of each
 *  store it carries, which is exactly its `revs` keys. The header bell takes
 *  these off its count and glow, so an answer clears it on the click
 *  (user addendum 2026-09-30) instead of on the next tree read. */
export function submittedOpenCount(tree: Pick<TreePayload, 'asks'> | null | undefined,
  nodes: Iterable<TreeNode>): number {
  let n = 0
  for (const a of openCards(tree, nodes)) {
    if (!askSubmitted(a.id)) continue
    n += a.kind === 'batch' ? Math.max(1, Object.keys(a.revs ?? {}).length) : 1
  }
  return n
}

/** The open cards the user has just submitted: the ones `openAsks` drops.
 *  A list that keeps a submitted entry visible as answered reads them here
 *  (asksubmitted.answeredAsk). */
export function submittedCards(tree: Pick<TreePayload, 'asks'> | null | undefined,
  nodes: Iterable<TreeNode>): AskInfo[] {
  return openCards(tree, nodes).filter(a => askSubmitted(a.id))
}

function openCards(tree: Pick<TreePayload, 'asks'> | null | undefined,
  nodes: Iterable<TreeNode>): AskInfo[] {
  const out: AskInfo[] = []
  const batched = new Set<string>()
  for (const n of nodes) {
    if (askIsOpen(n.ask)) { out.push(n.ask!); batched.add(n.id) }
  }
  // an agent the tree does not hold: its open header rows, grouped per agent
  // and COMPOSED into the same one-card batch the server gives a held node
  // (FR-14 — never one card per request kind)
  const loose = new Map<string, AskInfo[]>()
  for (const a of tree?.asks ?? []) {
    if (askIsOpen(a) && !batched.has(a.node)) loose.set(a.node, [...(loose.get(a.node) ?? []), a])
  }
  for (const [node, rows] of loose) {
    // ⚠ A SERVER-COMPOSED BATCH WINS. The live-question primer
    // (askprime.patchNodeAsk) stores a node's detail `ask` — already kind
    // `batch`, with its real tabs and per-store revs — in the header when the
    // selected tree does not hold the node. Recomposing it would drop its tabs
    // and CAS stamps (review-sol, befede0), so it is listed as it came.
    const served = rows.find((r) => r.kind === 'batch')
    const batch = served ?? composeBatch(node, rows)
    if (batch) out.push(batch)
  }
  return out
}

/** The server's scope-item label (ledger `_scope_item_label`), for a scope tab
 *  composed here. Mirrors it word for word. */
function scopeLabel(it: NonNullable<AskTab['item']>): string {
  return it.kind === 'dir' ? `folder ${it.path} (${it.mode})`
    : it.kind === 'tool' ? `tool: ${it.tool}`
      : it.kind === 'mcp' ? `MCP server: ${it.server}`
        : `permission mode → ${it.mode}`
          + (it.mode === 'bypassPermissions' ? ' ⚠ UNGUARDED — removes every prompt' : '')
}

/** One agent's open requests as ONE composed batch card — a client copy of the
 *  server's `node_ask` (ledger.py), used only for an agent the selected tree
 *  does not carry, so it has no `node.ask` of its own. The first open question,
 *  the first pending credit request and the first pending scope request each
 *  contribute their tabs, and `revs` carries each store's CAS stamp exactly as
 *  the batch submit expects. */
export function composeBatch(node: string, rows: readonly AskInfo[]): AskInfo | null {
  const ask = rows.find((r) => r.kind !== 'credit' && r.kind !== 'scope' && r.status === 'open')
  const cr = rows.find((r) => r.kind === 'credit' && r.status === 'pending')
  const sr = rows.find((r) => r.kind === 'scope' && r.status === 'pending')
  if (!ask && !cr && !sr) return null
  const tabs: AskTab[] = []
  const revs: NonNullable<AskInfo['revs']> = {}
  if (ask) {
    revs.ask = ask.rev ?? 1
    // a row written before FR-04 carries its one question on itself
    const qs = ask.questions?.length ? ask.questions
      : ask.question ? [{ question: ask.question, header: ask.header, options: ask.options, multi: ask.multi }]
        : []
    for (const q of qs) tabs.push({ kind: 'question', ...q } as AskTab)
  }
  if (cr) {
    revs.credits = cr.rev ?? 1
    tabs.push({ kind: 'credits', id: cr.id, old: cr.old, new: cr.new, reason: cr.reason })
  }
  if (sr) {
    revs.scope = sr.rev ?? 1
    for (const it of (sr.items ?? []) as NonNullable<AskTab['item']>[]) {
      tabs.push({ kind: 'scope', id: sr.id, item: it, reason: sr.reason, label: scopeLabel(it) })
    }
  }
  const base = (ask ?? cr ?? sr)!
  const first = tabs[0]
  const at = [ask, cr, sr].filter(Boolean).map((x) => x!.at).sort()[0]!
  return {
    id: String(base.id), node, kind: 'batch', status: 'open', at, tabs, revs,
    // legacy mirror: older surfaces title the card off these
    question: first?.question || first?.label
      || (first?.kind === 'credits' ? `credits ${first.old} → ${first.new}` : ''),
    ...(ask ? { rev: revs.ask } : {}),
  } as AskInfo
}

/** An open or resolved request as a row of the user's mailbox (user ruling
 *  2026-08-04: asks ride the inbox as their OWN mail rows, interleaved with
 *  real mail; the reading pane shows the response UI instead of a reply box).
 *  The Attention view lists questions with this same row. */
export const askMailRow = (a: AskInfo): MailRow => ({
  id: 'ask:' + a.id, from: a.node, at: a.at,
  kind: a.kind === 'batch' ? 'request batch'
    : (a.kind === 'credit' || a.old != null) ? 'credit request'
    : a.kind === 'scope' ? 'scope request' : 'question',
  body: a.kind === 'batch'
    ? `${(a.tabs ?? []).length} request(s) awaiting one submit`
    : a.kind === 'scope'
      ? 'requests scope: ' + (a.items ?? [])
        .map((it) => it.kind === 'dir' ? it.path
          : it.kind === 'permission_mode' ? `mode ${it.mode}`
          : it.tool ?? it.server ?? it.kind).join(', ')
      : a.question ?? `asks for credits: ${a.old} → ${a.new}`,
  _ask: a,
} as MailRow)

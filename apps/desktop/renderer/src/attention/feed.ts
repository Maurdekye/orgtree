// attention/feed.ts — THE MIXED "NEEDS ATTENTION" FEED, AS A PURE MODEL.
//
// The Attention view's left panel is ONE list holding three different kinds of
// row. This file is the whole rule for what is in that list and when a row
// leaves it; the components below it only draw what this returns. Everything
// here is a pure function of data the renderer already fetches — there is no
// state of its own, no poller, and no second copy of any server truth.
//
// THE THREE FLAVOURS AND THEIR AUTHORITATIVE SOURCES (ticket, 2026-09-12):
//
//   ticket    every work item currently marked as needing USER attention.
//             Source: GET /work-items (api.getWorkItems), `manual_attention`.
//             Resolution: api.dismissWorkItemAttention -> `manual_attention`
//             becomes null -> the row is gone on the next poll.
//
//   mail      every UNREAD mail tagged urgent by its sender.
//             Source: GET /inbox (api.getInbox), `pending` (pending IS the
//             unread group) filtered on `urgent`. Resolution: api.markRead.
//
//   question  every unanswered question.
//             Source: the tree — a node whose `ask` is open or pending.
//             Resolution: the existing AskCard, which resolves the card.
//
// ⚠ WHY `manual_attention` AND NOT `effective_attention`. The backend defines
// `effective_attention = manual_attention != null || questions.length > 0`
// (types.ts, work docket section). The question half of that disjunction is
// ALREADY in this list as its own question row. Keying tickets on
// `effective_attention` would therefore list the same demand twice — once as a
// question the user can answer, and once as a ticket whose Dismiss control is
// disabled, because `attention_sources` would not include 'manual' and there
// is no manual flag to clear. A row you cannot resolve is exactly the stale
// row the ticket says this list must not retain. Keyed on the manual flag,
// every ticket row has a working resolution and leaves when it is used.
//
// ⚠ WHY ONLY MAIL IS RETAINED WHILE SELECTED. The ticket gives three different
// resolution rules on purpose: a dismissed ticket and an answered question
// disappear AT ONCE, but urgent mail disappears "once it has been read and is
// no longer selected". Reading a mail is how you resolve it, and it is also
// the act of looking at it — so without the retention the row would vanish out
// from under the reader mid-sentence. `retainSelected` below implements that
// one exception and nothing wider: it can only keep a row the caller was
// already showing, only while that row is the selected one, and only for mail.

import type { AskInfo, MailEntry, TreeNode, TreePayload, WorkItem } from '../types'

export type AttentionRowKind = 'ticket' | 'mail' | 'question'

export interface AttentionRow {
  /** stable across polls and unique across flavours — the list's React key,
   *  the selection token, and what `retainSelected` compares */
  key: string
  kind: AttentionRowKind
  /** ISO timestamp the row is ordered by */
  at: string
  /** the agent this row is about: the sender, the asker, or the item's owner.
   *  null when nothing in the payload names one (an unassigned ticket). */
  agent: string | null
  /** the row's one-line headline */
  title: string
  /** the supporting line under it — the reason, the urgency note, the status */
  subtitle: string
  /** exactly one of these is set, matching `kind` */
  item?: WorkItem
  mail?: MailEntry
  ask?: AskInfo
}

export interface AttentionSources {
  /** every group GET /work-items returned. Attention is counted over ACTIVE
   *  AND ARCHIVED items (types.ts), so all groups are scanned rather than
   *  only the active one — an attention flag raised on work that has since
   *  been archived is still waiting on the user. */
  items?: readonly WorkItem[] | null
  archived?: readonly WorkItem[] | null
  backlogged?: readonly WorkItem[] | null
  /** GET /inbox `pending` — the unread group of the USER's mailbox */
  pending?: readonly MailEntry[] | null
  /** every node in the open organization, for its open ask */
  nodes?: readonly TreeNode[] | null
}

const ASK_OPEN = (a: AskInfo | undefined | null): boolean =>
  !!a && (a.status === 'open' || a.status === 'pending')

/** Every node of the tree, flattened. Mirrors App.tsx's own `flatNodes`; kept
 *  here so this module depends on the payload and not on a component. */
export function attentionNodes(tree: TreePayload | null | undefined): TreeNode[] {
  if (!tree) return []
  const out: TreeNode[] = []
  const walk = (n: TreeNode) => { out.push(n); (n.children ?? []).forEach(walk) }
  for (const r of tree.roots ?? []) walk(r)
  return out
}

export const ticketRowKey = (item: WorkItem) => 'ticket:' + item.slug
export const mailRowKey = (id: string) => 'mail:' + id
export const askRowKey = (ask: AskInfo) => 'question:' + ask.id

/** the first line of a body, trimmed to something a row can hold without the
 *  list turning into a wall of prose. The full text is in the detail pane. */
export function oneLine(text: string | undefined | null, max = 140): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function ticketRow(item: WorkItem): AttentionRow {
  const flag = item.manual_attention
  return {
    key: ticketRowKey(item),
    kind: 'ticket',
    // the flag's own moment, not the item's — this row exists because the
    // flag was raised, and ordering it by an unrelated later edit would move
    // it around the list for reasons the reader cannot see
    at: flag?.at ?? item.updated_at ?? item.at ?? '',
    agent: flag?.by?.node ?? item.owner?.node ?? null,
    title: item.title,
    subtitle: oneLine(flag?.reason),
    item,
  }
}

function mailRow(m: MailEntry): AttentionRow {
  return {
    key: mailRowKey(m.id),
    kind: 'mail',
    at: m.at,
    agent: m.from,
    // the sender had to give a reason to mark it urgent, and that reason is
    // written FOR the user — it is the headline, with the body beneath it
    title: oneLine(m.urgent_reason) || 'urgent message',
    subtitle: oneLine(m.body),
    mail: m,
  }
}

function askRow(node: string, a: AskInfo): AttentionRow {
  const tabs = (a.tabs ?? []).length
  const title = a.question
    ?? a.questions?.[0]?.question
    ?? (a.kind === 'batch' ? `${tabs} request(s) awaiting one submit`
      : a.old != null ? `asks for credits: ${a.old} → ${a.new}`
        : 'question')
  return {
    key: askRowKey(a),
    kind: 'question',
    at: a.at,
    agent: node,
    title: oneLine(title),
    subtitle: a.header ? oneLine(a.header) : '',
    ask: a,
  }
}

/** NEWEST FIRST, with a total order.
 *
 *  The ticket does not specify an order, so this is a chosen default and is
 *  recorded as one: the most recent demand on the user is at the top, which is
 *  the same direction every mail surface in this app reads. The tie-break on
 *  `key` is not decoration — three independent sources can easily stamp the
 *  same second, and without it the list would re-order itself between polls
 *  for no visible reason. */
export function compareRows(a: AttentionRow, b: AttentionRow): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** The live list: everything currently qualifying, and nothing else. */
export function buildAttentionRows(src: AttentionSources): AttentionRow[] {
  const rows: AttentionRow[] = []
  const seen = new Set<string>()
  const push = (row: AttentionRow) => {
    // the same item can be served in two groups across a poll boundary
    // (an item archiving between the two reads); never list it twice
    if (seen.has(row.key)) return
    seen.add(row.key)
    rows.push(row)
  }
  for (const group of [src.items, src.archived, src.backlogged]) {
    for (const item of group ?? []) if (item.manual_attention) push(ticketRow(item))
  }
  for (const m of src.pending ?? []) if (m.urgent && m.id) push(mailRow(m))
  for (const n of src.nodes ?? []) if (ASK_OPEN(n.ask)) push(askRow(n.id, n.ask!))
  return rows.sort(compareRows)
}

/**
 * The urgent-mail exception: "disappears once it has been read AND is no
 * longer selected."
 *
 * `live` is what still qualifies; `shown` is what the panel had on screen a
 * moment ago; `selected` is the row the reader is in. A MAIL row that has left
 * `live` (it was just read) but is still the selected one is put back, in its
 * sorted place. Everything else is dropped the instant it stops qualifying,
 * which is what the ticket demands for tickets and questions.
 *
 * ⚠ IT CAN ONLY RESURRECT A ROW THE CALLER WAS ALREADY SHOWING. `shown` is the
 * panel's previous render, so this can never invent a row, reach into the
 * server, or hold one open past a selection change — deselect, and the next
 * call has nothing to put back.
 */
export function retainSelected(
  live: readonly AttentionRow[],
  shown: readonly AttentionRow[],
  selected: string | null,
): AttentionRow[] {
  if (!selected || live.some((r) => r.key === selected)) return [...live]
  const held = shown.find((r) => r.key === selected)
  if (!held || held.kind !== 'mail') return [...live]
  return [...live, held].sort(compareRows)
}

/** A retained row is one the feed no longer lists — it is on screen only
 *  because it is selected. The panel marks it, so a read message does not
 *  look like it is still waiting. */
export const isRetained = (row: AttentionRow, live: readonly AttentionRow[]): boolean =>
  row.kind === 'mail' && !live.some((r) => r.key === row.key)

/** Where the selection goes when the current row resolves: the next row down,
 *  else the one above, else nothing. Returned rather than applied so the
 *  caller stays the only writer of its own selection. */
export function nextSelection(
  shown: readonly AttentionRow[], resolved: string,
): string | null {
  const i = shown.findIndex((r) => r.key === resolved)
  if (i < 0) return null
  return shown[i + 1]?.key ?? shown[i - 1]?.key ?? null
}

export interface AttentionCounts { ticket: number; mail: number; question: number; total: number }

export function countRows(rows: readonly AttentionRow[]): AttentionCounts {
  const counts: AttentionCounts = { ticket: 0, mail: 0, question: 0, total: rows.length }
  for (const r of rows) counts[r.kind]++
  return counts
}

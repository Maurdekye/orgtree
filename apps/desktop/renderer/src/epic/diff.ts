/* EPIC Mode — what happened, read off two consecutive org trees.

   App.tsx publishes a fresh org tree whenever anything about the org changes
   (in record mode, at most every 40 ms of runtime traffic). Each publish is
   reduced to a small snapshot of the fields EPIC Mode cares about, and the
   difference between the last two snapshots is the list of events to stage.
   Pure functions, so every rule here is testable without a window.

   ⚠ A TREE IS A SELECTION, NOT A CENSUS. The engine may send only the nodes a
   window needs (treepresence.ts), so a node missing from a tree has NOT been
   removed and a node appearing has NOT been hired: it may simply have scrolled
   into the selection. Hence:
   • a hire is a node seen for the first time whose own `created` stamp is
     recent — an old node entering the selection stays silent;
   • a retirement is a node seen live and now seen archived — absence is never
     read as retirement;
   • org-level counts (docket, inbox, asks, watchdogs) are complete in every
     tree and are compared directly. */
import type { TreeNode, TreePayload } from '../types'

export type EventKind =
  // one agent
  | 'hire' | 'rehire' | 'retire' | 'move' | 'reorder' | 'rename'
  | 'freeze' | 'thaw' | 'limit' | 'halt' | 'unhalt' | 'interrupt'
  | 'turnStart' | 'turnEnd' | 'tool' | 'toolDone' | 'thinking' | 'writing'
  | 'compact' | 'error' | 'question' | 'answer' | 'docs'
  | 'model' | 'account' | 'effort' | 'credits' | 'wake' | 'sleep' | 'ready'
  | 'working' | 'blocked' | 'idle' | 'waiting' | 'queued' | 'mailbox'
  // between two endpoints (mail sparks)
  | 'zap' | 'userSend' | 'toUser' | 'bark' | 'orgInbox'
  // the org
  | 'killswitch' | 'killswitchOff' | 'ticket' | 'ticketDone' | 'attention'
  | 'userMail' | 'urgent' | 'externalMail' | 'dogNew' | 'dogGone' | 'dogFired'
  | 'audience' | 'unaudience' | 'creditRequest' | 'settings' | 'cost'

export interface EpicEvent {
  kind: EventKind
  /** the agent it happened to (a node id, which is its name) */
  node?: string
  /** the other end: a mover's old parent, a spark's sender, a grantor */
  other?: string
  /** a word worth showing: a tool's name, a tier, an effort */
  text?: string
  /** a number worth showing: credits moved, tickets opened */
  n?: number
}

export interface NodeSnap {
  id: string
  parent: string | null
  state: string
  created: number
  order: number
  busy: boolean
  frozen: boolean
  limited: boolean
  halt: string | null
  phase: string | null
  activity: string | null
  tool: string | null
  ask: string | null
  docs: number
  err: string | null
  tier: string
  model: string
  account: string | null
  effort: string | null
  occupancy: number | null
  compacted: boolean
  procLive: boolean
  procWarm: boolean
  waiting: boolean
  queued: number
  mail: number
  grant: number
  limitLocked: boolean
  status: string | null
  statusAt: string | null
  killedTurns: number
}

export interface OrgSnap {
  nodes: Map<string, NodeSnap>
  killswitch: boolean
  attention: number
  raises: number
  active: number
  userInbox: number
  urgent: number
  orgInbox: number
  dogs: Map<string, { owner: string; fired: number; spent: boolean }>
  audiences: Set<string>
  creditRequests: number
  cost: number
  settings: string
}

/** how recent a first-seen node's `created` must be to count as a hire */
export const HIRE_WINDOW_MS = 45_000

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

export function snapNode(n: TreeNode, parent: string | null): NodeSnap {
  const turns = Array.isArray(n.turns) ? n.turns : []
  let killed = 0
  for (const t of turns) if (t && (t as { killed?: boolean }).killed) killed++
  const frozen = n.frozen ?? null
  const f = frozen as (Record<string, unknown> | null)
  return {
    id: n.id,
    parent,
    state: n.state,
    created: time(n.created),
    order: num(n.ui_order),
    busy: n.busy === true,
    frozen: !!frozen,
    limited: !!f && (!!f.until || !!f.limit || f.cause === 'limit'),
    halt: n.halt?.phase ?? null,
    phase: str(n.phase),
    activity: str(n.activity?.phase),
    tool: str(n.activity?.tool),
    ask: n.ask && (n.ask.status === 'open' || n.ask.status === 'pending') ? n.ask.id : null,
    docs: num(n.documents_count, Array.isArray(n.documents) ? n.documents.length : 0),
    err: str(n.last_error),
    tier: n.tier ?? '',
    model: n.model_id ?? '',
    account: str(n.account),
    effort: str(n.effort_current),
    occupancy: typeof n.occupancy === 'number' ? n.occupancy : null,
    compacted: n.compacted_unrun === true,
    procLive: n.proc_live === true,
    procWarm: n.proc_warm === true,
    waiting: n.waiting === true,
    queued: num(n.queued),
    mail: num(n.mail_pending),
    grant: num(n.grant),
    limitLocked: n.limit_locked === true,
    status: str(n.last_status?.status),
    statusAt: str(n.last_status?.at),
    killedTurns: killed,
  }
}

/** The org-level settings worth a "settings changed" effect, as one string. */
function settingsKey(t: TreePayload): string {
  const pick = t as unknown as Record<string, unknown>
  return JSON.stringify([
    'name', 'workspace', 'max_top_grant', 'default_top_grant', 'compact_at', 'default_effort',
    'default_visibility', 'permission_mode', 'default_account', 'auto_resume', 'auto_resume_compact',
    'cascade_hire', 'cascade_alloc', 'fable_limit_policy', 'fable_filter_policy', 'prefer_reserve_default',
    'account_fallback_default',
  ].map(k => pick[k] ?? null).concat([
    Array.isArray(t.dirs) ? t.dirs.length : 0,
    JSON.stringify(t.default_tools ?? null).length,
    JSON.stringify(pick.auto_cheap_compact ?? null),
  ]))
}

export function snapshotOrg(t: TreePayload): OrgSnap {
  const nodes = new Map<string, NodeSnap>()
  const walk = (list: TreeNode[] | undefined, parent: string | null) => {
    for (const n of list ?? []) {
      if (!n || typeof n.id !== 'string') continue
      nodes.set(n.id, snapNode(n, parent))
      walk(n.children, n.id)
    }
  }
  walk(t.roots, null)
  const dogs = new Map<string, { owner: string; fired: number; spent: boolean }>()
  for (const d of t.watchdogs ?? []) {
    if (d && typeof d.id === 'string') dogs.set(d.id, { owner: d.owner, fired: num(d.fired), spent: d.spent === true })
  }
  const audiences = new Set<string>()
  for (const a of t.audiences ?? []) if (a) audiences.add(`${a.grantor}\u0000${a.grantee}`)
  return {
    nodes,
    killswitch: !!t.killswitch,
    attention: num(t.work_items_summary?.attention),
    raises: Array.isArray(t.work_items_summary?.raises) ? t.work_items_summary.raises.length : 0,
    active: num(t.work_items_summary?.active),
    userInbox: num(t.user_inbox_count),
    urgent: num(t.urgent_unread),
    orgInbox: num(t.org_inbox?.unread),
    dogs,
    audiences,
    creditRequests: Array.isArray(t.credit_requests)
      ? t.credit_requests.filter(r => !r?.status || r.status === 'open' || r.status === 'pending').length : 0,
    cost: num(t.cost_usd_total),
    settings: settingsKey(t),
  }
}

/** Everything that changed between two snapshots of one org. `prev` absent
 *  means this is the first look: it is the baseline and nothing is staged. */
export function diffOrg(prev: OrgSnap | undefined, next: OrgSnap, now = Date.now()): EpicEvent[] {
  if (!prev) return []
  const out: EpicEvent[] = []
  const reordered = new Set<string>()
  for (const [id, n] of next.nodes) {
    const p = prev.nodes.get(id)
    if (!p) {
      if (n.state === 'live' && n.created && now - n.created <= HIRE_WINDOW_MS && n.created - now <= HIRE_WINDOW_MS) {
        out.push({ kind: 'hire', node: id, other: n.parent ?? undefined, text: n.tier })
      }
      continue
    }
    if (p.state !== 'live' && n.state === 'live') { out.push({ kind: 'rehire', node: id }); continue }
    if (p.state === 'live' && n.state !== 'live') { out.push({ kind: 'retire', node: id }); continue }
    if (n.state !== 'live') continue
    if (p.parent !== n.parent) out.push({ kind: 'move', node: id, other: p.parent ?? undefined, text: n.parent ?? undefined })
    else if (p.order !== n.order && !reordered.has(n.parent ?? '')) {
      reordered.add(n.parent ?? '')
      out.push({ kind: 'reorder', node: id })
    }
    if (!p.frozen && n.frozen) out.push({ kind: n.limited ? 'limit' : 'freeze', node: id })
    if (p.frozen && !n.frozen) out.push({ kind: 'thaw', node: id })
    if (!p.halt && n.halt) out.push({ kind: 'halt', node: id })
    if (p.halt && !n.halt) out.push({ kind: 'unhalt', node: id })
    if (n.killedTurns > p.killedTurns && !n.halt) out.push({ kind: 'interrupt', node: id })
    if (!p.busy && n.busy) out.push({ kind: 'turnStart', node: id })
    if (p.busy && !n.busy) out.push({ kind: 'turnEnd', node: id })
    if (n.tool && (n.tool !== p.tool || p.activity !== 'tool')) {
      if (n.activity === 'tool' || n.activity === 'tool_writing') out.push({ kind: 'tool', node: id, text: n.tool })
    } else if (p.activity === 'tool' && n.activity !== 'tool' && n.activity !== 'tool_writing') {
      out.push({ kind: 'toolDone', node: id, text: p.tool ?? undefined })
    }
    if (n.activity !== p.activity) {
      if (n.activity === 'thinking' && p.activity !== 'tool') out.push({ kind: 'thinking', node: id })
      if (n.activity === 'writing') out.push({ kind: 'writing', node: id })
    }
    if ((n.phase === 'compacting' && p.phase !== 'compacting')
      || (n.activity === 'compacting' && p.activity !== 'compacting' && p.phase !== 'compacting')
      || (n.compacted && !p.compacted)) out.push({ kind: 'compact', node: id })
    if (n.err && n.err !== p.err) out.push({ kind: 'error', node: id, text: n.err })
    if (!p.ask && n.ask) out.push({ kind: 'question', node: id })
    if (p.ask && !n.ask) out.push({ kind: 'answer', node: id })
    if (n.docs > p.docs) out.push({ kind: 'docs', node: id, n: n.docs - p.docs })
    if (p.tier && (n.tier !== p.tier || (n.model && p.model && n.model !== p.model))) out.push({ kind: 'model', node: id, text: n.tier })
    else if (n.account !== p.account && n.account && p.account) out.push({ kind: 'account', node: id })
    if (n.effort && p.effort && n.effort !== p.effort) out.push({ kind: 'effort', node: id, text: n.effort })
    if (n.grant !== p.grant) out.push({ kind: 'credits', node: id, n: n.grant - p.grant })
    if (!p.procLive && n.procLive) out.push({ kind: 'wake', node: id })
    if (p.procLive && !n.procLive) out.push({ kind: 'sleep', node: id })
    if (!p.procWarm && n.procWarm && p.procLive === n.procLive) out.push({ kind: 'ready', node: id })
    if (!p.limitLocked && n.limitLocked && !(n.frozen && !p.frozen)) out.push({ kind: 'limit', node: id })
    if (n.statusAt && n.statusAt !== p.statusAt && n.status) {
      const s = n.status
      out.push({ kind: s === 'blocked' ? 'blocked' : s === 'working' ? 'working' : 'idle', node: id })
    }
    if (!p.waiting && n.waiting) out.push({ kind: 'waiting', node: id })
    if (n.queued > p.queued) out.push({ kind: 'queued', node: id, n: n.queued - p.queued })
    if (n.mail > p.mail) out.push({ kind: 'mailbox', node: id, n: n.mail - p.mail })
  }
  if (!prev.killswitch && next.killswitch) out.push({ kind: 'killswitch' })
  if (prev.killswitch && !next.killswitch) out.push({ kind: 'killswitchOff' })
  if (next.attention > prev.attention || next.raises > prev.raises) out.push({ kind: 'attention' })
  if (next.active > prev.active) out.push({ kind: 'ticket', n: next.active - prev.active })
  if (next.active < prev.active) out.push({ kind: 'ticketDone', n: prev.active - next.active })
  if (next.userInbox > prev.userInbox) out.push({ kind: 'userMail', n: next.userInbox - prev.userInbox })
  if (next.urgent > prev.urgent) out.push({ kind: 'urgent' })
  if (next.orgInbox > prev.orgInbox) out.push({ kind: 'externalMail', n: next.orgInbox - prev.orgInbox })
  for (const [id, d] of next.dogs) {
    const p = prev.dogs.get(id)
    if (!p) out.push(d.spent ? { kind: 'dogFired', node: d.owner, text: id } : { kind: 'dogNew', node: d.owner, text: id })
    else if (d.fired > p.fired || (d.spent && !p.spent)) out.push({ kind: 'dogFired', node: d.owner, text: id })
  }
  for (const [id, d] of prev.dogs) if (!next.dogs.has(id) && !d.spent) out.push({ kind: 'dogGone', node: d.owner, text: id })
  for (const pair of next.audiences) if (!prev.audiences.has(pair)) {
    const [grantor, grantee] = pair.split('\u0000')
    out.push({ kind: 'audience', node: grantee, other: grantor })
  }
  for (const pair of prev.audiences) if (!next.audiences.has(pair)) {
    const [grantor, grantee] = pair.split('\u0000')
    out.push({ kind: 'unaudience', node: grantee, other: grantor })
  }
  if (next.creditRequests > prev.creditRequests) out.push({ kind: 'creditRequest' })
  if (next.cost - prev.cost >= 0.5) out.push({ kind: 'cost', n: next.cost - prev.cost })
  if (next.settings !== prev.settings) out.push({ kind: 'settings' })
  return out
}

/** A mail spark frame, read as an event: `node` is always the recipient end
 *  and `other` the sender end, exactly as the frame names them (an agent,
 *  `@user`, `org_inbox` or `dog:<id>`). `null` for anything else. */
export function sparkEvent(frame: unknown): EpicEvent | null {
  const f = frame as { type?: unknown; from?: unknown; to?: unknown } | null
  if (!f || f.type !== 'mail' || typeof f.from !== 'string' || typeof f.to !== 'string') return null
  const spark = { node: f.to, other: f.from }
  if (f.from.startsWith('dog:')) return { kind: 'bark', ...spark }
  if (isUserEnd(f.from)) return { kind: 'userSend', ...spark }
  if (isUserEnd(f.to)) return { kind: 'toUser', ...spark }
  if (isInboxEnd(f.from) || isInboxEnd(f.to)) return { kind: 'orgInbox', ...spark }
  return { kind: 'zap', ...spark }
}

export const isUserEnd = (s: string): boolean => s === '' || s === 'user' || s === '@user' || s === 'user_inbox'
export const isInboxEnd = (s: string): boolean => s === 'org_inbox' || s === '__orginbox__'

/** A `node_event` pulse frame, read as an event. */
export function pulseEvent(frame: unknown): EpicEvent | null {
  const f = frame as { type?: unknown; node?: unknown; event?: unknown; was?: unknown } | null
  if (!f || f.type !== 'node_event' || typeof f.node !== 'string' || typeof f.event !== 'string') return null
  switch (f.event) {
    case 'renamed': return { kind: 'rename', node: f.node, other: typeof f.was === 'string' ? f.was : undefined }
    case 'turn_done': return { kind: 'turnEnd', node: f.node }
    case 'frozen': return { kind: 'freeze', node: f.node }
    default: return null
  }
}

/** A streamed transcript frame (watched agents only), read as an event. */
export function streamEvent(frame: unknown): EpicEvent | null {
  const f = frame as { type?: unknown; node?: unknown; kind?: unknown; id?: unknown; text?: unknown } | null
  if (!f || f.type !== 'node_stream' || typeof f.node !== 'string') return null
  if (f.kind === 'tool' && f.id) return { kind: 'tool', node: f.node, text: typeof f.text === 'string' ? f.text : undefined }
  if (f.kind === 'delta' || f.kind === 'text') return { kind: 'writing', node: f.node }
  if (f.kind === 'thinking_start') return { kind: 'thinking', node: f.node }
  return null
}

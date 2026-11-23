// dm/model.ts — THE USER MAILBOX AS DIRECT MESSAGES: its rules, no rendering.
//
// 4.7.0 (USER 2026-11-22 m200806e4af28): the user's mailbox panel looks and
// works like Hubchat. It is a frontend view of the same mail: nothing here
// asks the engine for anything the old panel did not already read. A chat is
// one counterparty of the user's mail (USER m1454e651500e):
//
//   • every top-level agent has one: it has a direct line to the user;
//   • every holder of an audience with the user has one (an agent or a
//     project), and closing it revokes that grant;
//   • an agent whose audience comes through its project has one once it has
//     written, and it cannot be closed here: the grant is the project's;
//   • Orgtree's own mail (`@system`) is one chat, once it has written;
//   • an agent or project that ASKS for an audience has one, first in the
//     list, until the user approves or denies it (USER 2026-11-23
//     mae2b1aa37a9b: "audience requests appear as new dms");
//   • any other sender shows only while something of its is unread or
//     unanswered, or while it is the chat on screen: unread mail is never
//     hidden, and a closed chat does not come back by having history.
//
// A PROJECT'S CHAT IS ONE THREAD (USER 2026-11-23 mb52269db6058, following a
// project that holds the org mailbox). The user's message to a project is a
// job in its queue, and the engine keeps a copy for every hand-out, relay and
// bundled follow-up, each of them "sent by the user":
//   • a copy folds into the message it copies, which then says who holds it;
//   • a member's answer to its copy, and the user's reply to that answer, are
//     in the project's chat, under the agent's name;
//   • a megaphone send is in each member's chat, and once in the project's.
// Mail a member writes on its own stays in its own chat.
//
// One panel per org (USER m321dab754e52): every input is one org's own tree,
// mail and audiences, so a chat is always with that org's agents.

import type { AskInfo, AudienceGrant, InboxPayload, MailEntry, TreeNode, TreePayload } from '../types'
import type { MailRow } from '../canvas/shared'
import { SYSTEM, USER } from '../canvas/shared'

export type DmKind = 'agent' | 'project' | 'system' | 'other'

/** One thing in a chat's timeline: a mail (received or sent) or a request. */
export interface DmEntry {
  /** the mail's id, or `ask:<id>` for a request (the row id the old panel uses) */
  key: string
  at: string
  /** the user sent it */
  out: boolean
  /** still waiting on the user: unread mail, or a request not yet answered */
  unread: boolean
  mail?: MailRow
  ask?: AskInfo
  /** in a PROJECT's chat, the agent this bubble is from, or was sent to: a
   *  member's answer in the project's thread, the user's reply to it, a
   *  follow-up that went straight to the job's holder */
  via?: string
  /** the user's message to a project is a job in its queue: where it stands */
  job?: DmJob
  /** a megaphone send: its copy in a member's chat, or its one record in the
   *  project's chat */
  megaphone?: DmMegaphone
}

/** Where the user's message to a project stands. `holders`: the agents the
 *  queue has handed it to, oldest first (a re-hand-out or a relay adds one). */
export interface DmJob {
  state: 'waiting' | 'held' | 'done' | 'dead'
  holders: string[]
}

export interface DmMegaphone {
  project: string
  /** true in the project's chat: the one record of the send */
  record: boolean
  /** how many agents the send went to, and those whose copy is loaded */
  to: number
  names: string[]
}

export interface DmChat {
  /** the counterparty: an agent's or project's id, `@system`, or another sender */
  peer: string
  kind: DmKind
  /** its node, when this org's tree holds one */
  node: DmNode | null
  /** it can be written to (a retired agent cannot) */
  live: boolean
  /** no agent is above it: it has a direct line to the user */
  topLevel: boolean
  /** it holds its own grant of the user's audience */
  grant: boolean
  /** the project its audience with the user comes through, when it has one */
  inherited: string | null
  /** unread mail from it */
  unread: number
  /** its open requests */
  asks: number
  /** oldest first */
  entries: DmEntry[]
  last: DmEntry | null
  /** it asks for an audience with the user, and the user has not answered */
  request: DmRequest | null
}

/** A pending audience request addressed to the user. */
export interface DmRequest { reason: string; at: string }

/** A tree node with its parent's id (null for a root). */
export type DmNode = TreeNode & { parent: string | null }

/** This org's nodes by id, each with its parent: the tree as the shared agents
 *  list reads it (`trayRows`), built from the payload the panel is given. */
export function dmNodes(tree: Pick<TreePayload, 'roots'> | null | undefined): Map<string, DmNode> {
  const map = new Map<string, DmNode>()
  const walk = (n: TreeNode, parent: string | null) => {
    map.set(n.id, { ...n, parent })
    for (const c of n.children ?? []) walk(c, n.id)
  }
  for (const root of tree?.roots ?? []) walk(root, null)
  return map
}

const isProject = (n: { kind?: string } | null | undefined) => n?.kind === 'project'

/** No agent is above it. A project is not a superior, so an agent under a
 *  top-level project still answers to the user directly. */
function topLevelAgent(nodes: ReadonlyMap<string, DmNode>, n: DmNode): boolean {
  if (isProject(n)) return false
  for (let up = n.parent ? nodes.get(n.parent) : undefined; up; up = up.parent ? nodes.get(up.parent) : undefined) {
    if (!isProject(up)) return false
  }
  return true
}

export interface DmInput {
  nodes: ReadonlyMap<string, DmNode>
  /** the org's audience grants; null while they are still being read, when a
   *  node's own record of its grant is used instead */
  grants: readonly AudienceGrant[] | null
  /** the user's mail as the old panel reads it; null while it loads */
  box: Pick<InboxPayload, 'pending' | 'delivered' | 'sent'> | null
  openAsks: readonly AskInfo[]
  /** resolved requests kept in the history */
  doneAsks: readonly AskInfo[]
  /** a mail this window has just read (mailread.ts) */
  isRead?: (id: string) => boolean
  /** App settings > Display > Hide retired agents */
  hideRetired?: boolean
  /** the chat on screen: listed whatever its state */
  selected?: string | null
  /** audience requests waiting on the user (the audiences read's `requests`
   *  that name the user and have reached the user) */
  requests?: readonly { from: string; reason?: string; at?: string }[]
}

const byTime = (a: DmEntry, b: DmEntry) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** The chats to list, newest message first; those nobody has written in come
 *  after, in tree order, and retired holders last. */
export function dmChats(input: DmInput): DmChat[] {
  const { nodes, grants, box, isRead, hideRetired, selected } = input
  const entries = new Map<string, DmEntry[]>()
  const add = (peer: string, e: DmEntry) => {
    const list = entries.get(peer)
    if (list) list.push(e); else entries.set(peer, [e])
  }
  // ---- the user's own mail: which rows are messages, and which are the
  // queue's copies of one
  const sent = ((box?.sent ?? []) as MailRow[]).filter(m => typeof m.to === 'string' && m.to)
  const sentById = new Map<string, MailRow>()
  for (const m of sent) if (m.id) sentById.set(m.id, m)
  const projectNode = (name: string | undefined) => !!name && isProject(nodes.get(name))
  /** the row this one is the queue's copy of: a hand-out names the project's
   *  mail (`queue.job.mail`), a relayed job the job it came from. A follow-up
   *  sent straight to the holder names the JOB there and is a message itself. */
  const copyOf = (m: MailRow): string | null => {
    const q = m.queue as (MailRow['queue'] & { relayed_from?: { name?: string; job?: string } }) | undefined
    if (q?.job?.mail) return q.follow_up_to && q.job.mail === q.follow_up_to ? null : q.job.mail
    return q?.relayed_from?.job ?? null
  }
  /** the message a copy began as, when the loaded mail still holds it */
  const rootOf = (m: MailRow): MailRow | null => {
    let at: MailRow = m
    for (let hops = 0; hops < 24; hops++) {
      const up = copyOf(at)
      if (!up) return at
      const next = sentById.get(up)
      if (!next) return null
      at = next
    }
    return null
  }
  /** which project's thread a mail is in, by its id: what a reply to it joins */
  const thread = new Map<string, string>()
  const holders = new Map<string, string[]>()
  const megaphones = new Map<string, { first: MailRow; project: string; to: number; names: string[] }>()
  type Out = { m: MailRow; peer: string; via?: string }
  const outgoing: Out[] = []
  const orphans = new Map<string, string>()
  for (const m of [...sent].sort((a, b) => (a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : 0)) {
    const to = m.to as string
    const q = m.queue as (MailRow['queue'] & { relayed_from?: { name?: string } }) | undefined
    const up = copyOf(m)
    if (up) {
      const root = rootOf(m)
      if (root) {
        // R1, R4: a copy is not a message; it says who was handed the job
        if (root.id && typeof root.to === 'string') thread.set(m.id, root.to)
        if (root.id && !projectNode(to)) holders.set(root.id, [...(holders.get(root.id) ?? []).filter(h => h !== to), to])
        continue
      }
      // its message is older than the loaded mail: the first copy stands for it, in the project's chat
      const project = q?.job?.name ?? q?.relayed_from?.name ?? to
      const shown = orphans.get(up)
      if (shown) { thread.set(m.id, project); continue }
      orphans.set(up, m.id)
      thread.set(m.id, project)
      outgoing.push({ m, peer: project, via: projectNode(to) ? undefined : to })
      continue
    }
    const mega = (m as MailRow & { megaphone?: { name?: string; send?: string; to?: number } }).megaphone
    if (mega?.name && mega.send) {
      const group = megaphones.get(mega.send)
      if (group) group.names.push(to)
      else megaphones.set(mega.send, { first: m, project: mega.name, to: mega.to ?? 0, names: [to] })
      outgoing.push({ m, peer: to })
      continue
    }
    // a follow-up that went straight to the job's holder is in the project's thread
    if (q?.job?.name && q.follow_up_to) {
      thread.set(m.id, q.job.name)
      outgoing.push({ m, peer: q.job.name, via: to })
      continue
    }
    if (projectNode(to)) thread.set(m.id, to)
    outgoing.push({ m, peer: to })
  }
  const jobOf = (m: MailRow): DmJob | undefined => {
    if (!projectNode(m.to) || m.queue?.follow_up_to) return undefined
    const handed = holders.get(m.id) ?? []
    const q = m.queue
    const state: DmJob['state'] = q?.dead_letter ? 'dead' : q?.acked_at ? 'done' : handed.length || q?.held_by ? 'held' : 'waiting'
    return { state, holders: handed.length ? handed : q?.held_by ? [q.held_by] : [] }
  }
  const refsOf = (m: MailRow): string[] => {
    const ids: string[] = []
    const one = (r: { id?: string } | undefined) => { if (r?.id) ids.push(r.id) }
    one(m.reply_to as { id?: string } | undefined)
    for (const r of (m.replies ?? []) as { id?: string }[]) one(r)
    return ids
  }
  // ---- every message, oldest first, so a reply finds the thread of what it answers (R2, R3)
  type Row = { at: string; out?: Out; m?: MailEntry; pending?: boolean }
  const all: Row[] = [
    ...outgoing.map(o => ({ at: o.m.at ?? '', out: o })),
    ...(box?.pending ?? []).map(m => ({ at: m.at ?? '', m, pending: true })),
    ...(box?.delivered ?? []).map(m => ({ at: m.at ?? '', m, pending: false })),
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  for (const row of all) {
    if (row.out) {
      const { m } = row.out
      let { peer, via } = row.out
      const joined = thread.get(m.id) ? undefined : refsOf(m).map(id => thread.get(id)).find(Boolean)
      if (joined && joined !== peer) { via = peer; peer = joined; thread.set(m.id, joined) }
      const mega = megaphones.get((m as MailRow & { megaphone?: { send?: string } }).megaphone?.send ?? '')
      add(peer, { key: m.id, at: m.at ?? '', out: true, unread: false, mail: m, via, job: via ? undefined : jobOf(m),
        megaphone: mega ? { project: mega.project, record: false, to: mega.to, names: mega.names } : undefined })
      continue
    }
    const m = row.m!
    if (typeof m.from !== 'string' || !m.from) continue
    const unread = !!row.pending && !(m.id && isRead?.(m.id))
    const joined = refsOf(m as MailRow).map(id => thread.get(id)).find(Boolean)
    if (joined && m.id) thread.set(m.id, joined)
    add(joined ?? m.from, { key: m.id, at: m.at ?? '', out: false, unread, mail: unread ? { ...m, _wait: true } : m,
      via: joined && joined !== m.from ? m.from : undefined })
  }
  // a megaphone send, once, in the project's chat: the record of it
  for (const [send, g] of megaphones) {
    add(g.project, { key: 'megaphone:' + send, at: g.first.at ?? '', out: true, unread: false, mail: g.first,
      megaphone: { project: g.project, record: true, to: g.to || g.names.length, names: g.names } })
  }
  for (const a of input.openAsks) add(a.node, { key: 'ask:' + a.id, at: a.at ?? '', out: false, unread: true, ask: a })
  for (const a of input.doneAsks) add(a.node, { key: 'ask:' + a.id, at: a.at ?? '', out: false, unread: false, ask: a })

  const granted = new Set<string>()
  if (grants) { for (const g of grants) if (g.grantor === USER) granted.add(g.grantee) }
  else for (const n of nodes.values()) {
    if ((n.audiences_explicit ?? n.audiences_held ?? []).includes(USER)) granted.add(n.id)
  }

  const asking = new Map<string, DmRequest>()
  for (const r of input.requests ?? []) {
    if (typeof r.from === 'string' && r.from && !granted.has(r.from)) {
      asking.set(r.from, { reason: r.reason ?? '', at: r.at ?? '' })
    }
  }

  const order = new Map<string, number>()
  for (const id of nodes.keys()) order.set(id, order.size)
  const chats = new Map<string, DmChat>()
  const open = (peer: string): DmChat => {
    const existing = chats.get(peer)
    if (existing) return existing
    const node = nodes.get(peer) ?? null
    const list = (entries.get(peer) ?? []).slice().sort(byTime)
    const inherited = node?.audiences_inherited?.find(a => a.grantor === USER)?.project ?? null
    const chat: DmChat = {
      peer, node,
      kind: peer === SYSTEM ? 'system' : !node ? 'other' : isProject(node) ? 'project' : 'agent',
      live: node?.state === 'live',
      topLevel: !!node && node.state === 'live' && topLevelAgent(nodes, node),
      grant: granted.has(peer),
      inherited: granted.has(peer) ? null : inherited,
      unread: list.filter(e => e.unread && e.mail).length,
      asks: list.filter(e => e.unread && e.ask).length,
      entries: list,
      last: list[list.length - 1] ?? null,
      request: asking.get(peer) ?? null,
    }
    chats.set(peer, chat)
    return chat
  }

  // a direct line, or a grant of the user's audience
  for (const n of nodes.values()) {
    if (n.state === 'live' && topLevelAgent(nodes, n)) open(n.id)
  }
  for (const peer of granted) {
    const node = nodes.get(peer)
    if (node && node.state !== 'live' && hideRetired) continue
    open(peer)
  }
  // whoever asks for an audience: the request is its chat
  for (const peer of asking.keys()) open(peer)
  // …and whoever else has written
  for (const [peer, list] of entries) {
    if (chats.has(peer)) continue
    const node = nodes.get(peer)
    const waiting = list.some(e => e.unread)
    const viaProject = node?.state === 'live' && node.audiences_inherited?.some(a => a.grantor === USER)
    if (waiting || peer === SYSTEM || viaProject) open(peer)
  }
  if (selected) open(selected)

  // a request is new and waits on the user: first, the newest request on top
  const rank = (c: DmChat) => c.request ? -1
    : !c.live && c.kind !== 'system' && c.kind !== 'other' ? 2 : c.last ? 0 : 1
  return [...chats.values()].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === -1 && a.request!.at !== b.request!.at) return a.request!.at < b.request!.at ? 1 : -1
    if (ra === 0 && a.last!.at !== b.last!.at) return a.last!.at < b.last!.at ? 1 : -1
    const oa = order.get(a.peer) ?? Infinity, ob = order.get(b.peer) ?? Infinity
    return oa !== ob ? oa - ob : a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0
  })
}

/** A chat's timeline, oldest first. */
export const dmTimeline = (chat: DmChat): DmEntry[] => chat.entries

/** What a chat's close control does, and the words that say so.
 *
 *  USER 2026-11-22 m1454e651500e: a top-level chat cannot be closed; only an
 *  audience grant can. A top-level agent that also holds a grant loses the
 *  grant and keeps its chat, and the control's tooltip says so. No
 *  confirmation: closing revokes at once. */
export interface DmClose {
  /** there is a grant to revoke */
  can: boolean
  /** the chat stays in the list after the grant is revoked */
  stays: boolean
  /** closing answers a pending audience request with no, instead of revoking */
  deny?: boolean
  title: string
}

export function dmClose(chat: DmChat): DmClose {
  if (chat.kind === 'system') {
    return { can: false, stays: true, title: "Orgtree's own notices. This chat can't be closed." }
  }
  if (chat.grant) {
    if (chat.topLevel) {
      return { can: true, stays: true,
        title: `Revoke ${chat.peer}'s audience grant. The chat stays: a top-level agent always has a direct line to you.` }
    }
    return { can: true, stays: false,
      title: `Close this chat: revoke ${chat.peer}'s audience with you. Its history is kept.` }
  }
  if (chat.topLevel) {
    return { can: false, stays: true,
      title: `${chat.peer} is a top-level agent: it always has a direct line to you, so this chat can't be closed.` }
  }
  if (chat.request && !chat.inherited) {
    return { can: true, stays: false, deny: true,
      title: `Deny ${chat.peer}'s audience request and close this chat.` }
  }
  if (chat.inherited) {
    return { can: false, stays: true,
      title: `${chat.peer}'s audience with you comes through project ${chat.inherited}. `
        + `Revoke the project's audience to close this chat.` }
  }
  return { can: false, stays: false,
    title: `${chat.peer} holds no audience with you. This chat leaves the list once nothing of its waits on you.` }
}

/** How many things wait on the user across the listed chats. */
export const dmWaiting = (chats: readonly DmChat[]): { unread: number; asks: number; requests: number } =>
  chats.reduce((sum, c) => ({ unread: sum.unread + c.unread, asks: sum.asks + c.asks,
    requests: sum.requests + (c.request ? 1 : 0) }), { unread: 0, asks: 0, requests: 0 })

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
  const received = (m: MailEntry, pending: boolean) => {
    if (typeof m.from !== 'string' || !m.from) return
    const unread = pending && !(m.id && isRead?.(m.id))
    add(m.from, { key: m.id, at: m.at ?? '', out: false, unread, mail: unread ? { ...m, _wait: true } : m })
  }
  for (const m of box?.pending ?? []) received(m, true)
  for (const m of box?.delivered ?? []) received(m, false)
  for (const m of box?.sent ?? []) {
    const to = (m as MailRow).to
    if (typeof to !== 'string' || !to) continue
    add(to, { key: m.id, at: m.at ?? '', out: true, unread: false, mail: m as MailRow })
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

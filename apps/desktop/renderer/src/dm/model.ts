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
}

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
}

const byTime = (a: DmEntry, b: DmEntry) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** The chats to list. NOT BUILT YET: the red control for dmmodel.test.tsx. */
export function dmChats(_input: DmInput): DmChat[] {
  return []
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
  title: string
}

export function dmClose(_chat: DmChat): DmClose {
  return { can: false, stays: false, title: '' }
}

/** How many things wait on the user across the listed chats. */
export const dmWaiting = (chats: readonly DmChat[]): { unread: number; asks: number } =>
  chats.reduce((sum, c) => ({ unread: sum.unread + c.unread, asks: sum.asks + c.asks }), { unread: 0, asks: 0 })

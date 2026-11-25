// mailboxpref.ts — which mailbox the user's panel shows, and when it opens a chat.
//
// 4.7.0 (USER 2026-11-22 m200806e4af28): the user mailbox panel is a list of
// chats, like Hubchat. "there should be a header checkbox to return the old ui
// (which restores the mail icon)", and the same switch sits in App settings >
// Display > Mailbox (USER m1454e651500e ruling 7; m034b5c83b8f2). Beside it:
// "replying to a presentation / ticket automatically opens up the mailbox dm
// with that agent" (USER 2026-11-23 me0241bccf7b4), on by default.
//
// Both are saved on this computer for every org and every window, like the
// other Display choices here (`hideRetiredOn` in canvas/shared.ts is the
// model): one localStorage value each, a `storage` listener for the other
// windows, no engine setting.

import { useSyncExternalStore } from 'react'

export const CLASSIC_MAILBOX_KEY = 'orgtree-classic-mailbox'
export const OPEN_CHAT_ON_REPLY_KEY = 'orgtree-chat-on-object-reply'

/** a choice made while storage refuses writes still holds for this window */
const held = new Map<string, boolean>()
const read = (key: string, unset: boolean): boolean => {
  try {
    const stored = localStorage.getItem(key)
    if (stored !== null) return stored === '1'
  } catch { /* fall through to this window's own choice */ }
  return held.get(key) ?? unset
}
const subs = new Set<() => void>()
const write = (key: string, on: boolean): void => {
  held.set(key, on)
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* kept in `held` */ }
  for (const fn of [...subs]) fn()    // copy: a listener may detach
}
const subscribe = (fn: () => void) => {
  subs.add(fn)
  window.addEventListener('storage', fn)
  return () => { subs.delete(fn); window.removeEventListener('storage', fn) }
}

/** The classic mailbox (folders, a mail list and a reading pane) is chosen.
 *  Unset reads as false: the chats are the default. */
export const classicMailbox = (): boolean => read(CLASSIC_MAILBOX_KEY, false)
export const setClassicMailbox = (on: boolean): void => write(CLASSIC_MAILBOX_KEY, on)
/** Re-render when the choice changes, in this window or another. */
export const useClassicMailbox = (): boolean => useSyncExternalStore(subscribe, classicMailbox)

/** A reply sent on a presentation or a ticket opens that agent's chat. Unset
 *  reads as true. */
export const openChatOnReply = (): boolean => read(OPEN_CHAT_ON_REPLY_KEY, true)
export const setOpenChatOnReply = (on: boolean): void => write(OPEN_CHAT_ON_REPLY_KEY, on)
export const useOpenChatOnReply = (): boolean => useSyncExternalStore(subscribe, openChatOnReply)

/** The settings' names and help, in one place for the title-bar switch, the
 *  Display tab and the settings search (sentence case). */
export const CLASSIC_MAILBOX_LABEL = 'Classic mailbox'
/** The window's name follows the view, live (USER 2026-11-25 m3599f869626b "rename the window from "your inbox"
 *  to "your chats" when the new version is enabled", then m5e271cdf9dd1: "Chats"): its title, a popped-out window's title, and the tooltips
 *  that name it. The mailbox itself, its shortcut and the glossary keep "Inbox". Shared with the Open chat
 *  tooltip (@ui-canvas-overlay-opus). */
export const CHATS_TITLE = 'Chats'
export const INBOX_TITLE = 'Your inbox'
export const userMailboxTitle = (classic: boolean): string => classic ? INBOX_TITLE : CHATS_TITLE
export const CLASSIC_MAILBOX_HINT
  = 'Show your mail as folders with a list and a reading pane, with the mail icon, as before 4.7.0. '
  + 'Off: one chat per agent that can write to you.'
export const OPEN_CHAT_ON_REPLY_LABEL = 'Open the chat when replying to a presentation or ticket'
export const OPEN_CHAT_ON_REPLY_HINT
  = 'After you reply to a presentation or a ticket, your chat with the agent that received the reply opens, '
  + 'with the reply as its latest message. On by default; it does nothing while the classic mailbox is on.'

/** "Open this agent's chat": the shell listens (App.tsx) and opens the user's
 *  mailbox panel on it. */
type ChatRequest = (org: string, peer: string, opts?: ChatRequestOptions) => void
/** `grant`: the chat may be one the target has no audience for yet; the inbox grants it one first,
 *  through New chat's own path (DmPanel startChat), and opens nothing if that grant fails */
export interface ChatRequestOptions { grant?: boolean }
const chatSubs = new Set<ChatRequest>()
export const onChatRequest = (fn: ChatRequest): (() => void) => {
  chatSubs.add(fn)
  return () => { chatSubs.delete(fn) }
}

/** AGENT LINKS OPEN THE CHAT (USER 2026-11-24 md9120179f714: "make clicking an agent link anywhere in
 *  the app if they have an audience with you open a chat with them instead of focusing their desk on
 *  the canvas / switching the active agent desk in attention view. otherwise just do those things").
 *
 *  `canChatWith`: a live agent that holds a user audience, its own or through its project (the tree's
 *  `audiences_held` has both), while the chats are the mailbox. A project link goes to the project.
 *  `agentLinkChat` is the plain click: true when the chat took it. It is false for the chat the Inbox
 *  already shows, so the name in a chat's own header still goes to the agent's desk instead of doing
 *  nothing. `openAgentChat` is the menu's entry. An empty `org` means this window's organization. */
export const canChatWith = (node: { kind?: string | null; state?: string; audiences_held?: readonly string[] | null }): boolean =>
  !classicMailbox() && node.kind !== 'project' && node.state === 'live' && !!node.audiences_held?.includes('@user')

let shownChat: { org: string; peer: string } | null = null
/** The chat the user's Inbox shows now (dm/DmPanel.tsx keeps it; null when it shows none or is closed). */
export const setShownChat = (org: string, peer: string | null): void => {
  if (peer) shownChat = { org, peer }
  else if (shownChat?.org === org) shownChat = null
}

export const openAgentChat = (org: string, peer: string, opts?: ChatRequestOptions): boolean => {
  if (!peer || !chatSubs.size) return false
  for (const fn of [...chatSubs]) fn(org, peer, opts)
  return true
}

/** OPEN CHAT IN EVERY AGENT AND PROJECT MENU (USER 2026-11-25 14:24:01Z ma84dfc37f5a6 "if they don't
 *  have an audience, grant one before opening the chat. state that opening the chat grants an audience in
 *  the hover tooltip"; widened 14:33:44Z m0a8fdb69edb9 "make it a universal entry in every agent's context
 *  menu", 14:33:50Z m6da526799148 "everywhere throughout the app"). Any LIVE agent or project (a retired
 *  one cannot be granted an audience). `needsGrant` mirrors New chat (DmPanel startChat): false for a holder
 *  of a user audience, its own or through its project, and for a top-level agent, which writes to the user
 *  anyway. `nodes` is the canvas map (flatten(): top-level cards have the eye root, state 'user', as parent)
 *  or a map whose top-level nodes have no parent. The classic view is switched at the choice (`openChatFrom`). */
type ChatTarget = { id: string; kind?: string | null; state?: string; parent?: string | null; audiences_held?: readonly string[] | null }
export const chatTargetFor = (nodes: ReadonlyMap<string, ChatTarget>, node: ChatTarget): { needsGrant: boolean } | null => {
  if (node.state !== 'live') return null
  return { needsGrant: !node.audiences_held?.includes('@user') && !topLevelAgent(nodes, node) }
}

/** What choosing Open chat will change, in order (USER 2026-11-25 14:34:30Z m46b47955f2ac: the classic
 *  view switches to the chats first, with the toggle's own setting, then the grant, then the chat; the
 *  tooltip lists exactly those changes). */
export const openChatTitle = (id: string, needsGrant: boolean): string => {
  const changes = [
    ...(classicMailbox() ? [`switches your mailbox from the classic view to ${CHATS_TITLE}`] : []),
    ...(needsGrant ? [`grants ${id} an audience with you`] : []),
  ]
  return `your chat with ${id}, in ${CHATS_TITLE}` + (changes.length ? `. Opening it ${changes.join(' and ')}` : '')
}
export const openChatFrom = (org: string, id: string): void => {
  if (classicMailbox()) setClassicMailbox(false)
  openAgentChat(org, id, { grant: true })
}
function topLevelAgent(nodes: ReadonlyMap<string, ChatTarget>, n: ChatTarget): boolean {
  if (n.kind === 'project') return false
  for (let up = n.parent ? nodes.get(n.parent) : undefined; up && up.state !== 'user'; up = up.parent ? nodes.get(up.parent) : undefined) {
    if (up.kind !== 'project') return false
  }
  return true
}

export const agentLinkChat = (org: string, node: { id: string; kind?: string | null; state?: string; audiences_held?: readonly string[] | null }): boolean =>
  !!org && canChatWith(node) && !(shownChat?.org === org && shownChat.peer === node.id) && openAgentChat(org, node.id)

/** A reply the user made on a presentation or a ticket was sent to `peer`.
 *  With the setting on (and the chats, not the classic mailbox), that agent's
 *  chat opens: the reply gave it an audience with the user, so the chat exists
 *  even when it had none (USER 2026-11-23 m265fe1ac5d5d). */
export const replySentOnObject = (org: string, peer: string): void => {
  if (!org || !peer || classicMailbox() || !openChatOnReply()) return
  for (const fn of [...chatSubs]) fn(org, peer)
}

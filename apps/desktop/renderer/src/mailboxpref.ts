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
import { getMailById } from './api'

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

/** VIEW A MAIL IN THE CHAT OR IN THE CLASSIC INBOX (USER 2026-11-25 m70e86c04946e "any mail between you and an
 *  agent in an agent's or your classic mailbox gets a context menu "view in chat" which switches to the chat
 *  view and highlights the message"; m53e908235395 a mail mention's click does the same while the chats are on;
 *  m2fb0c88ab8f8 a mail mention's menu has both, "which switches to the appropriate one before opening").
 *
 *  `chatPeerOf`: the agent or project on the other side of a mail between the user and it, or null for any
 *  other mail (agent to agent, outside or org mail, the system's). `userBox`: the row comes from the user's own
 *  mailbox, whose received mail carries no `to`. `owner`: the row comes from that agent's or project's own
 *  mailbox, whose received mail carries no `to` either (engine feed/compute.rs agent_mailbox adds it only for
 *  Sent), so the user's mail there is to the owner. Any other row the user sent whose `to` is unknown is taken as
 *  a chat mail: the chat's own jump then finds it or says it cannot (DmPanel's not-found notice).
 *
 *  `viewMailIn` sets the view first with the toggle's own setting, then asks the shell (App.tsx) to open the
 *  user's mailbox on that mail: the chats select its chat and flash it, as a reference jump does; the classic
 *  mailbox opens its folder, selects it and scrolls to it. An empty `org` is this window's organization. */
export const chatPeerOf = (m: { from?: unknown; to?: unknown }, userBox = false, owner?: string): string | null => {
  const name = (v: unknown): string | null => typeof v === 'string' && v !== '' && !v.startsWith('@') ? v : null
  if (m.from === '@user') return m.to == null || m.to === '' ? (owner ? name(owner) : null) ?? '' : name(m.to)
  return m.to === '@user' || userBox && m.to == null ? name(m.from) : null
}
export const isChatMail = (m: { from?: unknown; to?: unknown }, userBox = false): boolean => chatPeerOf(m, userBox) !== null
/** `peer`: the chat that holds it, where the asker knows (the user's own mail read back by id names no recipient) */
type MailViewRequest = (org: string, mailId: string, peer?: string) => void
const mailViewSubs = new Set<MailViewRequest>()
export const onMailViewRequest = (fn: MailViewRequest): (() => void) => {
  mailViewSubs.add(fn)
  return () => { mailViewSubs.delete(fn) }
}
export const VIEW_IN_CHAT = 'View in chat'
export const VIEW_IN_CLASSIC = 'View in classic inbox'
export const viewMailIn = (view: 'chat' | 'classic', org: string, mailId: string, peer?: string | null): boolean => {
  if (!mailId || !mailViewSubs.size) return false
  if (classicMailbox() !== (view === 'classic')) setClassicMailbox(view === 'classic')
  for (const fn of [...mailViewSubs]) fn(org, mailId, peer || undefined)
  return true
}

/** "VIEW IN @AGENT'S INBOX" ASKS FOR THE MAILBOX ITSELF (USER 2026-11-25 md19d9582d5f0: "View in @xyz's inbox no
 *  longer works, it just highlights the message in the chat again"). The chats' entry goes through the shell's mail
 *  route to the canvas's mail-link router, which sends the user's mail to the chat while the chats are on. The entry
 *  marks its mail first; the router's next look at that mail takes the mark and opens the mailbox. One use, and it
 *  lapses after a few seconds, so a route that never reaches the router leaves no lasting exception. */
const mailboxAsks = new Map<string, number>()
const MAILBOX_ASK_MS = 5000
export const askForMailbox = (id: string): void => { mailboxAsks.set(id, Date.now() + MAILBOX_ASK_MS) }
const takeMailboxAsk = (id: string): boolean => {
  const until = mailboxAsks.get(id)
  mailboxAsks.delete(id)
  return until !== undefined && until >= Date.now()
}
/** A MAIL LINK INTO AN AGENT'S OR PROJECT'S MAILBOX (OrgCanvas's mail router), USER 2026-11-25 m53e908235395
 *  "clicking a mail mention to you in a transcript or body elsewhere will do the same if chats is open": while
 *  the chats are the mailbox, a mail between the user and `agent` opens in that chat, flashed. The user's box
 *  answers by id for exactly the user's mail. The classic view, any other mail and a failed read go `elsewhere`
 *  (the agent's mailbox, as before). */
export const mailLinkToChat = (slug: string, id: string, agent: string, elsewhere: () => void): void => {
  if (classicMailbox() || takeMailboxAsk(id)) { elsewhere(); return }
  getMailById(slug, 'user', id)
    .then(r => { if (!(r.found && r.mail && isChatMail(r.mail as { from?: unknown; to?: unknown }, true) && viewMailIn('chat', slug, id, agent))) elsewhere() })
    .catch(elsewhere)
}

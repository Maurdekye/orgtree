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
export const CLASSIC_MAILBOX_HINT
  = 'Show your mail as folders with a list and a reading pane, with the mail icon, as before 4.7.0. '
  + 'Off: one chat per agent that can write to you.'
export const OPEN_CHAT_ON_REPLY_LABEL = 'Open the chat when replying to a presentation or ticket'
export const OPEN_CHAT_ON_REPLY_HINT
  = 'After you reply to a presentation or a ticket, your chat with the agent that received the reply opens, '
  + 'with the reply as its latest message. On by default; it does nothing while the classic mailbox is on.'

/** "Open this agent's chat": the shell listens (App.tsx) and opens the user's
 *  mailbox panel on it. */
type ChatRequest = (org: string, peer: string) => void
const chatSubs = new Set<ChatRequest>()
export const onChatRequest = (fn: ChatRequest): (() => void) => {
  chatSubs.add(fn)
  return () => { chatSubs.delete(fn) }
}

/** A reply the user made on a presentation or a ticket was sent to `peer`.
 *  With the setting on (and the chats, not the classic mailbox), that agent's
 *  chat opens: the reply gave it an audience with the user, so the chat exists
 *  even when it had none (USER 2026-11-23 m265fe1ac5d5d). */
export const replySentOnObject = (org: string, peer: string): void => {
  if (!org || !peer || classicMailbox() || !openChatOnReply()) return
  for (const fn of [...chatSubs]) fn(org, peer)
}

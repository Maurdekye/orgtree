// mailboxpref.ts — the user's mailbox panel's own preferences (4.7.0).
//
// RED-COMMIT SEAM: the names exist so the tests load. Nothing is saved, the
// classic mailbox is never chosen and no chat is ever asked for; the commits
// that follow fill this in.

export const CLASSIC_MAILBOX_KEY = 'orgtree-classic-mailbox'
export const OPEN_CHAT_ON_REPLY_KEY = 'orgtree-chat-on-object-reply'

export const classicMailbox = (): boolean => false
export const setClassicMailbox = (_on: boolean): void => {}
export const openChatOnReply = (): boolean => true
export const setOpenChatOnReply = (_on: boolean): void => {}

export const onChatRequest = (_fn: (org: string, peer: string) => void): (() => void) => () => {}
export const replySentOnObject = (_org: string, _peer: string): void => {}

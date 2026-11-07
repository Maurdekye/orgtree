// canvas/mailrefs.ts — a link to a mail shows the first words of the message, not "mail in the user's inbox" (USER
// 2026-10-31 mdffa16729677 "they're unstyled, and just look like normal links", m33189c8d6214 "style them just like other
// types (with a mail icon), and make their names the first 20 or so characters truncated with an ellipsis").
//
// A `refnames` reader over the same lookup the link's hover and its Copy use (`getMailById`: one message of one mailbox,
// the same box a click opens), so the name, the tooltip and the copied text come from one message. A mail the box does not
// hold answers `absent`: the link then says so (like any reference to nothing) and shows nothing of any mail. A failed
// read is not an answer and is asked again later.
//
// A MESSAGE THE USER HAS NOT READ FLARES LIKE AN UNREAD PRESENTATION (USER 2026-10-31 m5345a1e44ad1 "also make sure that mail has
// an unread highlight like presentations do"): the same answer carries the flare (the user box's lookup says `unread`), with
// the same words and the same accent edge (docrefs.ts is the model, `ref-flare` in styles.css the shared look), and it clears
// the same way, when the message is read. A read made here (mailread.ts) is decided again at once from this window's own read
// state and recorded on the kept answer when the save is accepted, so the link never flashes back to unread; a read made
// elsewhere (another window, "mark all read") reaches the links when the inbox's unread list no longer holds the message
// (`mailInboxRead`), which reads just those links again. AN AGENT'S MESSAGE FLARES TOO (USER 2026-11-01 mc13db4358667 "only user
// mail gets the highlight. can agent mail get it too? it has read / unread states"): the node box's lookup says `unread` by the
// recipient's own row (the unread states the inbox counts), the same for the sender's view of what it sent, and the links on
// screen read it again when the tree's pending-mail counts change (`mailTreeChanged`). The org mailbox's message never flares. AN
// UNREAD URGENT MESSAGE'S EDGE IS THE URGENT COLOUR (USER 2026-11-01 m49a258f12e57 "urgent unread mail gets a highlight with the
// urgent color"), user and agent mail alike: the class `mail-urgent` beside `mail-new`.

import { getMailById } from '../api'
import { onReadSaved, readLocally, subscribeLocalReads } from '../mailread'
import type { MailEntry } from '../types'
import { DOC_UNREAD_WORDS } from './docviewed'
import { refKey, refNames, refTarget } from './refnames'
import type { RefFlare } from './refnames'

/** characters of the message a link shows before its ellipsis (one constant, USER m33189c8d6214: "the first 20 or so") */
export const MAIL_LABEL_CHARS = 20

/** The first MAIL_LABEL_CHARS characters of a message's text, for its link: Markdown syntax removed, whitespace and newlines
 *  collapsed to single spaces, an ellipsis after a text that was longer. `null` for a message with no text. */
export function mailRefLabel(body: unknown): string | null {
  if (typeof body !== 'string') return null
  const plain = body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                       // [text](url), ![alt](url) -> text
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '') // heading, quote, list markers at a line start
    .replace(/```|~~~|`|\*\*|__|~~/g, '')                               // fences, code ticks, bold, strike
    .replace(/(?<![\p{L}\p{N}])[*_]+|[*_]+(?![\p{L}\p{N}])/gu, '')      // emphasis marks at a word's edge (snake_case keeps its underscores)
    .replace(/<\/?[a-z][^>]*>/gi, '')                                   // HTML tags
    .replace(/\s+/g, ' ').trim()
  const chars = Array.from(plain)                                       // code points, so a surrogate pair is never cut in half
  if (!chars.length) return null
  return chars.length > MAIL_LABEL_CHARS ? chars.slice(0, MAIL_LABEL_CHARS).join('').trimEnd() + '…' : plain
}

/** An unread message's flare: the presentation's words, its own class (styles.css gives `mail-new` and `doc-new` one colour).
 *  None once the user read it, here or elsewhere. */
export function mailFlare(org: string, mail: Pick<MailEntry, 'id' | 'unread' | 'urgent'>): RefFlare | undefined {
  if (mail.unread !== true || readLocally(org, mail.id)) return undefined
  return mail.urgent === true ? { cls: 'mail-new mail-urgent', tip: `Urgent · ${DOC_UNREAD_WORDS.new}` } : { cls: 'mail-new', tip: DOC_UNREAD_WORDS.new }
}

const split = (target: string) => {
  const [box, node, ...id] = target.split('/')
  return { box: box as 'user' | 'org' | 'node', node: node || undefined, id: id.join('/') }
}

refNames.register({
  kinds: ['mail'],
  // one message per read: a mailbox answers for a message, and one that fails must not fail its neighbours
  batch: 1,
  async read(org, ids) {
    const found = new Map<string, unknown>()
    for (const { id } of ids) {
      const t = split(id)
      if (t.box !== 'user' && t.box !== 'org' && t.box !== 'node') continue
      const r = await getMailById(org, t.box, t.id, t.node)
      // ONLY AN ANSWER MAKES A MAIL ABSENT: the engine says `found: false`. Anything else (an error page, a body with no
      // `found`) is a read that failed, which throws so the link stays as it was and the read is asked again later.
      if (typeof r?.found !== 'boolean') throw Error('mail lookup gave no answer')
      if (r.found && r.mail) found.set(refKey('mail', id), r.mail)
    }
    return found
  },
  name: (_kind, row, org) => {
    const flare = mailFlare(org, row as MailEntry)
    return { label: mailRefLabel((row as MailEntry).body) ?? '', ...(flare ? { flare } : {}) }
  },
})

// a read made here shows read at once, and a refused one puts the flare back: the links on screen are decided again, with no read
subscribeLocalReads(() => refNames.touch())
// an accepted read is the server's state now: kept on the answer, so the link stays read when the store forgets the read
onReadSaved((org, id) => refNames.amend(org, 'mail', refTarget({ kind: 'mail', org, box: 'user', id }), row => ({ ...(row as MailEntry), unread: false })))

/** The user's inbox was read: `unreadIds` is every message it still lists as unread. A link whose answer says unread for a
 *  message that is not listed any more was read elsewhere, so it is read again (and only it). */
export function mailInboxRead(org: string, unreadIds: Iterable<string>): void {
  const pending = new Set(unreadIds)
  refNames.invalidate(org, ['mail'], (target, row) => (row as MailEntry).unread === true && !pending.has(split(target).id))
}

let lastPending = ''
/** The tree's per-agent pending-mail counts: when they changed, the links to an agent's unread message are read again (an
 *  agent read it, or a new one arrived). Cheap: nothing is read unless the counts moved and such a link is on screen. */
export function mailTreeChanged(org: string, roots: readonly { id?: string; mail_pending?: number; children?: readonly unknown[] }[]): void {
  const parts: string[] = []
  const walk = (ns: readonly { id?: string; mail_pending?: number; children?: readonly unknown[] }[]) => {
    for (const n of ns) { parts.push(`${n.id ?? ''}:${n.mail_pending ?? 0}`); if (n.children?.length) walk(n.children as typeof ns) }
  }
  walk(roots)
  const sig = org + '|' + parts.join(',')
  if (sig === lastPending) return
  lastPending = sig
  refNames.invalidate(org, ['mail'], (target, row) => (row as MailEntry).unread === true && split(target).box === 'node')
}

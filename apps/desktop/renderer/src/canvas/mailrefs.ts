// canvas/mailrefs.ts — a link to a mail shows the first words of the message, not "mail in the user's inbox" (USER
// 2026-10-31 mdffa16729677 "they're unstyled, and just look like normal links", m33189c8d6214 "style them just like other
// types (with a mail icon), and make their names the first 20 or so characters truncated with an ellipsis").
//
// A `refnames` reader over the same lookup the link's hover and its Copy use (`getMailById`: one message of one mailbox,
// the same box a click opens), so the name, the tooltip and the copied text come from one message. A mail the box does not
// hold answers `absent`: the link then says so (like any reference to nothing) and shows nothing of any mail. A failed
// read is not an answer and is asked again later.

import { getMailById } from '../api'
import type { MailEntry } from '../types'
import { refKey, refNames } from './refnames'

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
  name: (_kind, row) => ({ label: mailRefLabel((row as MailEntry).body) ?? '' }),
})

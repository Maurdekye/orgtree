// canvas/mailboxviews.ts — THE MAIL'S OTHER PLACES (4.7.1): every message menu (mail links, mail rows, the chats
// panel's bubbles) offers to show the same mail where else it lives. USER 2026-11-28 m598c1e427fb7 "all mail links for
// mail between agents or the org mailbox everywhere should have two links: "open in (recipient)'s inbox" and "open in
// (sender)'s outbox"", m9492a72e8259 "unless the mail link is already at one of those, in which case it should show
// just the other", m43242cb6f7cc "view in...", mee49b81a285f the user's mail also "view in chat", m740b4ab70ccc an
// outside party's side is the org mailbox, m82b4e67c4b03 "View in org inbox"/"View in org outbox", 07:52Z "view in
// (sender/receiver)'s transcript" for read mail (unread: the sender's only), mde95b23fb23d it replaces a mail link's
// "Open", me67dde860b40 the recap (the user's side stays "View in classic inbox"). Docket mail-link-context-menus-open-in-recipient-s-inbo.
//
// The builder is pure: each surface says where the mail is shown (`here`) and how to get to a place; it decides
// which places there are, their order and their words. Each wording lives once, in VIEW_WORDS.
import type { MenuItem } from './contextmenu'
import { VIEW_IN_CHAT, VIEW_IN_CLASSIC } from '../mailboxpref'

/** a mailbox folder that holds a copy of the mail */
export type MailboxSide = { box: 'user' | 'org' | 'node'; node?: string; folder: 'inbox' | 'sent' }
/** where a menu's mail is shown now: a mailbox folder, the user's chat with an agent, or an agent's transcript */
export type MailPlace = MailboxSide | { chat: string } | { transcript: string }
type Holder = { box: 'user' | 'org' | 'node'; node?: string }
type Row = { id?: unknown; from?: unknown; to?: unknown; _by?: unknown; _delivered?: unknown; delivered?: unknown; unread?: unknown; _wait?: unknown
  dir?: unknown; peer?: unknown; by?: unknown; delivered_to?: unknown; copies?: unknown; org_row?: unknown }

/** EVERY WORDING ONCE. The user's side is the classic mailbox, its inbox or its outbox folder (USER 2026-11-28
 *  me67dde860b40 recap: agent-user mail gets "view in classic inbox" and "view in chat" in place of the user's box). */
export const VIEW_WORDS = {
  userInbox: VIEW_IN_CLASSIC,
  userOutbox: VIEW_IN_CLASSIC,
  orgInbox: 'View in org inbox',
  orgOutbox: 'View in org outbox',
  node: (name: string, folder: 'inbox' | 'sent') => `View in @${name}’s ${folder === 'inbox' ? 'inbox' : 'outbox'}`,
  transcript: (name: string) => `View in @${name}’s transcript`,
  recipients: 'View in a recipient’s inbox',
} as const
/** an org row's holder copy that was made before the two were linked (the engine finds no copy to open) */
export const MAIL_COPY_UNLINKED = 'That agent\u2019s copy of this message is older than the link between the mailboxes, so it can\u2019t be opened from here'
/** more recipients than this go in one submenu */
const FLAT_RECIPIENTS = 3

export const mailboxViewLabel = (s: MailboxSide): string =>
  s.box === 'org' ? (s.folder === 'inbox' ? VIEW_WORDS.orgInbox : VIEW_WORDS.orgOutbox)
    : s.box === 'user' ? (s.folder === 'inbox' ? VIEW_WORDS.userInbox : VIEW_WORDS.userOutbox)
      : VIEW_WORDS.node(s.node ?? '', s.folder)
/** a label this builder makes for a mailbox or a transcript (mailMenuEntries ranks the group by it) */
export const isMailboxViewLabel = (label: string): boolean =>
  /^View in org (inbox|outbox)$/.test(label) || /^View in @\S+’s (inbox|outbox)$/.test(label)
  || label === VIEW_WORDS.recipients
export const isTranscriptViewLabel = (label: string): boolean => /^View in @\S+’s transcript$/.test(label)

const OUTSIDE = /^@(net|org|ext|mcp):/
const isUser = (v: unknown) => v === '@user' || v === 'user_inbox'
const agentName = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' && !v.startsWith('@') && v !== 'user_inbox' ? v : null

/** The mail's sender side (its Sent copy) and recipient sides (their inboxes). An outside party has no mailbox here:
 *  its side is the org mailbox, which received its mail (inbox) or sent ours on (outbox). Orgtree's own mail
 *  (@system and the like) has no sender side. `holder` is the box the row was read from: a received row there
 *  carries no `to`, so the box is its recipient. Reads every shape the boxes give: the common mail row, the org
 *  mailbox's display row (`_by`, `_delivered`; its `to` repeats the outside peer) and the org mailbox's own row read
 *  by id (`dir`, `peer`, `by`, `delivered_to`; bounce m782724ff17a3). */
export function mailSides(row: Row, holder: Holder): { sender: MailboxSide | null; recipients: MailboxSide[] } {
  const named = (v: unknown): unknown[] => Array.isArray(v) ? v : v != null && v !== '' ? [v] : []
  const dir = row.dir === 'in' || row.dir === 'out' ? row.dir : null
  const from = dir === 'in' ? row.peer : dir === 'out' ? agentName(row.by) : agentName(row._by) ?? row.from
  const sender: MailboxSide | null = isUser(from) ? { box: 'user', folder: 'sent' }
    : typeof from === 'string' && OUTSIDE.test(from) ? { box: 'org', folder: 'inbox' }
      : agentName(from) ? { box: 'node', node: from as string, folder: 'sent' } : null
  const delivered = named(dir === 'in' ? row.delivered_to : row._delivered)
  const tos = dir === 'out' ? named(row.peer) : delivered.length ? delivered : named(row.to).length ? named(row.to)
    : holder.box === 'node' && holder.node ? [holder.node]
      : holder.box === 'user' && !isUser(from) ? ['@user'] : []
  const recipients: MailboxSide[] = []
  const seen = new Set<string>(sender ? [key(sender)] : [])
  for (const to of tos) {
    const side: MailboxSide | null = isUser(to) ? { box: 'user', folder: 'inbox' }
      // an outside party's mail is never also to an outside party (the org row's `to` repeats its peer)
      : typeof to === 'string' && OUTSIDE.test(to) ? (sender?.box === 'org' ? null : { box: 'org', folder: 'sent' })
        : agentName(to) ? { box: 'node', node: to as string, folder: 'inbox' } : null
    if (side && !seen.has(key(side))) { seen.add(key(side)); recipients.push(side) }
  }
  return { sender, recipients }
}
const key = (s: MailboxSide) => `${s.box}:${s.node ?? ''}:${s.folder}`
const isHere = (s: MailboxSide, here: MailPlace | null | undefined) =>
  !!here && 'box' in here && key(here) === key(s)

/** A mail's recipient has read it: its CLI took it (`delivered`), or, from an engine or a box that does not say,
 *  it is no longer waiting there. */
const readByRecipient = (row: Row): boolean =>
  row.delivered === true || (row.delivered == null && row._wait !== true && row.unread !== true)

/** THE GROUP, in order: View in chat; the recipients' inboxes (one submenu past three); the sender's outbox; the
 *  transcripts (sender, then each recipient that read it). A place the mail is shown in now is left out.
 *
 *  EACH PLACE AT ITS OWN COPY. Agent, project and user boxes share one message id; the org mailbox's rows have their
 *  own, and an inbound row's holders each got a copy with its own id (bounce m782724ff17a3; @coordinator-opus
 *  me123cd3dfa03). So from an org row an agent's inbox opens at that agent's copy (`copies` of the row read by id, or
 *  `lookupCopies` for a listed row, asked on choosing), and from a holder's copy the org inbox opens at its row
 *  (`org_row`). A copy made before that link was recorded has none: no entry where that is known, a `missing` note
 *  where it is learned only on choosing. An agent's mail to an outside party lives only in the org mailbox (the agent's
 *  Sent lists ot.mail only), so it has no outbox entry; its transcript does (the send call names the org row's id). */
export function mailboxViewEntries(o: {
  row: Row; holder: Holder; here?: MailPlace | null
  view: (side: MailboxSide, id: string) => void
  /** the user's chat that holds this mail, where it is the user's mail with an agent or project */
  chat?: { peer: string; open: () => void }
  /** agents with a transcript (not projects, not retired-and-gone) and the way to one at this mail */
  transcript?: { has: (name: string) => boolean; open: (name: string, id: string) => void }
  /** an org row listed without its copies: read them when an agent's entry is chosen */
  lookupCopies?: () => Promise<{ agent: string; id: string }[]>
  /** an agent's copy was not found (made before the link was recorded) */
  missing?: () => void
}): MenuItem[] {
  const { sender, recipients } = mailSides(o.row, o.holder)
  const here = o.here ?? null
  const rowId = typeof o.row.id === 'string' ? o.row.id : ''
  const fromOrg = o.holder.box === 'org'
  const copies = Array.isArray(o.row.copies) ? o.row.copies as { agent?: unknown; id?: unknown }[] : null
  const copyOf = (name: string) => { const c = copies?.find(c => c.agent === name); return typeof c?.id === 'string' ? c.id : null }
  /** the entry's action, or null where this mail has no copy to open there */
  const go = (s: MailboxSide): (() => void) | null => {
    if ((s.box === 'org') === fromOrg) return rowId ? () => o.view(s, rowId) : null
    if (!fromOrg) return typeof o.row.org_row === 'string' && o.row.org_row ? () => o.view(s, o.row.org_row as string) : null
    if (copies) { const id = copyOf(s.node ?? ''); return id ? () => o.view(s, id) : null }
    const lookup = o.lookupCopies
    return lookup ? () => { void lookup().then(cs => { const c = cs.find(c => c.agent === s.node); if (c) o.view(s, c.id); else o.missing?.() }, () => o.missing?.()) } : null
  }
  const out: MenuItem[] = []
  if (o.chat && !(here && 'chat' in here && here.chat === o.chat.peer)) out.push({ label: VIEW_IN_CHAT, onSelect: o.chat.open })
  const item = (s: MailboxSide): MenuItem | null => { const act = go(s); return act ? { label: mailboxViewLabel(s), onSelect: act } : null }
  const inboxes = recipients.filter(s => !isHere(s, here)).map(item).filter((e): e is MenuItem => !!e)
  if (inboxes.length > FLAT_RECIPIENTS) out.push({ label: VIEW_WORDS.recipients, onSelect: () => {}, actionDisabled: true, children: inboxes })
  else out.push(...inboxes)
  const toOutside = recipients.some(r => r.box === 'org' && r.folder === 'sent')
  if (sender && !isHere(sender, here) && !(sender.box === 'node' && toOutside)) { const e = item(sender); if (e) out.push(e) }
  if (o.transcript && rowId) {
    const t = o.transcript
    // the sender's send call names this row's id; a recipient's delivery row its own copy's, known here only off the org box
    const agents = [...(sender?.box === 'node' ? [sender.node!] : []),
      ...(!fromOrg && readByRecipient(o.row) ? recipients.filter(r => r.box === 'node').map(r => r.node!) : [])]
    for (const name of [...new Set(agents)]) {
      if (!t.has(name) || (here && 'transcript' in here && here.transcript === name)) continue
      out.push({ label: VIEW_WORDS.transcript(name), onSelect: () => t.open(name, rowId) })
    }
  }
  return out
}

/** Where a link's anchor is shown, for the places a link can be IN: the user's chat with an agent, or an agent's
 *  transcript (`data-mail-place="chat:<peer>"` / `"transcript:<agent>"` on that surface). A link inside a mailbox's
 *  reading pane is about some other mail, so a mailbox is a row's place, said by its list, never a link's. */
export function mailPlaceAt(anchor: Element | null): MailPlace | null {
  const v = anchor?.closest?.('[data-mail-place]')?.getAttribute('data-mail-place') ?? ''
  const m = /^(chat|transcript):(.+)$/.exec(v)
  return !m ? null : m[1] === 'chat' ? { chat: m[2]! } : { transcript: m[2]! }
}

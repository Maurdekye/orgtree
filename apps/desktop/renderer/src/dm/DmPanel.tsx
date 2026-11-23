// dm/DmPanel.tsx — THE USER'S MAILBOX AS CHATS (4.7.0).
//
// USER 2026-11-22 m200806e4af28: "a revamp of the user mailbox panel. structure
// it to look and work like hubchat. this is a fully frontend based change, it
// should function the same way under the hood. every open "dm" represents a
// user audience or agent with a direct user line, closing a dm rescinds the
// audience."
//
// So this panel is a second view of exactly what the classic mailbox
// (`InboxPanel`, App.tsx) reads and does: the same inbox record and history
// pages, the same audiences, the same request cards, the same send, reply,
// read, delete and acknowledge calls. What it changes is the shape: one chat
// per counterparty (dm/model.ts decides which), its mail as bubbles oldest to
// newest, and one message box under them.
//
// It reuses the app's own pieces rather than variants of them (UX symmetry):
// the two-pane frame that collapses its list when narrow (`CollapsibleMailer`,
// as mail and presentations), the mail body and its files (`MailMessageBody`,
// `MailAttachments`), the request card (`InboxAskCard`), the composer every
// contextual reply uses (`MailReplyBox`), the agent's name and model chip, its
// status line, and for New chat the agents list itself (`AgentTray`).
//
// Rulings built here (USER 2026-11-22 m1454e651500e, m321dab754e52):
//   1. a top-level agent's chat cannot be closed; only an audience grant can,
//      and the close control's tooltip says which case this is;
//   2. closing asks for no confirmation;
//   3. New chat opens a copy of the agents list with all its features;
//   4. requests work as they do everywhere, one bubble per tab;
//   5. a notice has a dashed border, a request a small label, files are chips;
//      the border is the chat background's colour, thick and widely spaced,
//      and a notice wears no label (USER 2026-11-23 mae2b1aa37a9b, m7012356beca4);
//   6. newest chat first, an unread count on each;
//   8. one panel per org, with that org's agents only.
//
// Prototype feedback (USER 2026-11-23 mae2b1aa37a9b): an audience request is a
// chat of its own, first in the list and marked, approved or denied in the
// chat, and approved by writing to it; the message box has the agent's fast
// mode and effort; the chat's header has the agent's link and its settings.
//
// A project's chat is one thread (USER 2026-11-23 mb52269db6058; dm/model.ts
// folds it): the user's message says who holds it, a member's answer is
// there under the agent's name, Reply on a member's bubble writes to that
// member, Reply on the user's own message is a follow-up to its holder, and
// a megaphone send is recorded once.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { AskInfo, MailEntry, ToastFn, TreePayload } from '../types'
import {
  audienceAction, clearInbox, deleteUserMail, fileBase, fileUrl, getAudiences, getMailById,
  markRead, runOp,
} from '../api'
import { useRecordInbox } from '../recordpanelhooks'
import { useMailboxHistory } from '../usemailhistory'
import { markReadNow, readLocally, settleReadsFromBox, useLocalReads } from '../mailread'
import { mailInboxRead } from '../canvas/mailrefs'
import { askIsOpen, openAsks, submittedCards } from '../canvas/openasks'
import { answeredAsk, useSubmittedAsks } from '../asksubmitted'
import { InboxAskCard, scopeItemLabel } from '../canvas/asks'
import { PinFrame } from '../canvas/modalpin'
import { CollapsibleMailer } from '../canvas/narrowlist'
import {
  DELETE_USER_MAIL_CONFIRM, MailAttachments, MailMessageBody, MailReplyBox,
} from '../canvas/mail'
import { NodeLink, TierChip, nodeTierOf } from '../canvas/identity'
import { agentTooltipProps, useAgentNavRegistry } from '../canvas/agentnav'
import { nodeMenuAction } from '../canvas/objectactions'
import { ActiveAgentsFilter, AgentTray, trayRows } from '../canvas/agenttray'
import { AgentEffortButton, TrayStatus } from '../canvas/desk'
import { FastModeButton } from '../canvas/fastmodebutton'
import { openSettingsAt } from '../canvas/settingskit'
import { ListAge } from '../canvas/listage'
import { SenderChip } from '../canvas/senderchip'
import { HubContactChip, isHubAddress } from '../canvas/agentmentions'
import { copyToClipboard, useContextMenu } from '../canvas/contextmenu'
import type { MenuEntry } from '../canvas/contextmenu'
import { mailMenuEntries } from '../canvas/mailidentity'
import { mailRowCopyText } from '../canvas/copytext'
import type { CopyableMailRow } from '../canvas/copytext'
import { refToken } from '../canvas/reflinks'
import type { RefRoutes } from '../canvas/reflinks'
import { JobAckPane, needsAck } from '../canvas/jobackpane'
import { acknowledgeJob } from '../canvas/jobacks'
import {
  audienceGrantTooltip, isMailNotice, jumpKey, USER, useEsc, useHideRetired, usePolled,
} from '../canvas/shared'
import type { CanvasNode, MailRow } from '../canvas/shared'
import { decodeEventRow } from '../events/decode'
import { projectEvent } from '../events/project'
import { noticeSummary } from '../events/change'
import { sendLinkedReply, sendPanelMessage } from '../events/reply'
import type { ReplyTarget } from '../generated/events'
import type { SelectionTarget } from '../replySelection'
import {
  CampaignIcon, ChatBubbleIcon, CloseIcon, CopyIcon, HearingIcon, NewChatIcon, ReplyIcon, SettingsIcon,
} from '../icons'
import { fmtDay, fmtFull, fmtHm, fmtStamp, isToday } from '../timefmt'
import { useSurfaceDocument } from '../popout'
import { dmAudienceLoss, dmChats, dmClose, dmNodes, dmWaiting } from './model'
import type { DmChat, DmEntry, DmNode } from './model'
import './dm.css'

const PROFILE = 'operator' as const
/** Bubbles from one side closer together than this read as one group. */
const GROUP_GAP_MS = 5 * 60000
/** How many resolved requests stay in the history: the classic mailbox's own
 *  number (App.tsx `askDone`, ledger ASK_HISTORY_KEEP). */
const ASK_HISTORY_KEEP = 8

export interface DmPanelProps {
  slug: string
  tree: TreePayload
  toast: ToastFn
  refresh?: () => void
  close: () => void
  /** a mail (or `ask:<id>`) to open its chat on, as the classic mailbox selects it */
  jumpTo: string | null
  /** the request's own identity, so a repeat click is a new request */
  jumpSeq?: number | null
  /** open the chat with this agent; a new `seq` is a new request */
  openChat?: { peer: string; seq: number } | null
  onFocusAgent?: (agentId: string) => void
  /** the chat header's gear; without it the panel asks for the settings
   *  window itself (`openSettingsAt`, which the canvas answers) */
  onAgentSettings?: (agentId: string) => void
  /** the panel's reference routes, exactly as the classic mailbox's bodies use them */
  refs: RefRoutes
  /** the title bar's actions: the switch back to the classic mailbox */
  headerActions?: ReactNode
}

/** The name a chat is listed and headed under. */
export const dmName = (chat: Pick<DmChat, 'kind' | 'peer'>): string =>
  chat.kind === 'system' ? 'Orgtree' : chat.peer

/** A list row reads as plain words: the commonest markdown marks are dropped
 *  (bold, code, a link's address, a leading heading, quote or list mark). */
const plainWords = (text: string) => text
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/^\s{0,3}(?:#{1,6}|[-*+]|>)\s+/gm, '')
const brief = (text: string | null | undefined) => plainWords(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)

/** One line that says what a mail is about: its typed event's summary, else
 *  its text, else its files (the classic list row's own rule). */
function mailBrief(m: MailRow): string {
  const decoded = decodeEventRow(m, PROFILE)
  const text = brief(decoded.kind === 'known' ? noticeSummary(decoded.event, m.from) : m.body)
  if (text) return text
  const files = m.attachments ?? []
  return files.length ? (files.length === 1 ? files[0]!.name ?? 'a file' : `${files.length} files`) : ''
}

/** What a request says in a list row. */
const askBrief = (a: AskInfo): string => {
  const first = a.tabs?.[0]
  return brief(first?.question || first?.label || a.question
    || (a.items?.length ? a.items.map(scopeItemLabel).join(' · ') : '')
    || (a.old != null ? `credits ${a.old} → ${a.new}` : 'a request'))
}

/** the calendar day an instant falls on, in the display zone */
const dayKey = (at: string) => fmtStamp(at).slice(0, 10)
const dayLabel = (at: string) => {
  if (isToday(at)) return 'Today'
  const year = fmtStamp(at).slice(0, 4), now = fmtStamp(new Date().toISOString()).slice(0, 4)
  return year && year !== now ? `${fmtDay(at)} ${year}` : fmtDay(at)
}

/** The mail kinds a bubble names with a small label (USER m1454e651500e,
 *  ruling 5: requests get a small label). An ordinary message has none. */
const KIND_LABEL: Readonly<Record<string, string>> = { request: 'Request', question: 'Question', decision: 'Decision' }

/** Re-render when the window this panel is in gains or loses the user. */
function useWindowActive(): boolean {
  const owner = useSurfaceDocument()
  const read = useCallback(() => owner.visibilityState !== 'hidden' && owner.hasFocus(), [owner])
  const [active, setActive] = useState(read)
  useEffect(() => {
    const win = owner.defaultView
    const update = () => setActive(read())
    update()
    win?.addEventListener('focus', update); win?.addEventListener('blur', update)
    owner.addEventListener('visibilitychange', update)
    return () => {
      win?.removeEventListener('focus', update); win?.removeEventListener('blur', update)
      owner.removeEventListener('visibilitychange', update)
    }
  }, [owner, read])
  return active
}

const rememberKey = (slug: string) => `orgtree-dm-open:${slug}`
const remembered = (slug: string): string | null => {
  try { return window.sessionStorage.getItem(rememberKey(slug)) } catch { return null }
}

export function DmPanel({ slug, tree, toast, refresh, close, jumpTo, jumpSeq, openChat,
  onFocusAgent, onAgentSettings, refs, headerActions }: DmPanelProps) {
  const nodes = useMemo(() => dmNodes(tree), [tree])
  // ⚠ THE SAME READS THE CLASSIC MAILBOX MAKES, nothing more: the pushed inbox
  // record, the two history folders it pages, and the audiences. `readBump`
  // re-asks at once after a read, a delete or an acknowledgement, as there.
  const [readBump, setReadBump] = useState(0)
  const rawBox = useRecordInbox(slug, readBump).value
  const inbox = useMailboxHistory(slug, rawBox, 'inbox', true, readBump)
  const outbox = useMailboxHistory(slug, rawBox, 'sent', true, readBump)
  const [audBump, setAudBump] = useState(0)
  const aud = usePolled(() => getAudiences(slug), [slug], 5000, audBump)
  const hideRetired = useHideRetired()
  // a mail read here, and a request answered here, show so on the click
  const reads = useLocalReads()
  useSubmittedAsks()
  useEffect(() => {
    if (!rawBox) return
    const unread = rawBox.pending.map((m) => m.id)
    settleReadsFromBox(slug, unread)
    mailInboxRead(slug, unread)
  }, [rawBox, slug])

  // a mail a reference named that the loaded window does not hold
  const [looked, setLooked] = useState<{ slug: string; mail: MailEntry }[]>([])
  const box = useMemo(() => {
    if (!inbox.box || !outbox.box) return null
    const extra = looked.filter(l => l.slug === slug).map(l => l.mail)
      .filter(m => !inbox.box!.pending.some(x => x.id === m.id) && !inbox.box!.delivered.some(x => x.id === m.id))
    return { pending: inbox.box.pending, delivered: [...inbox.box.delivered, ...extra], sent: outbox.box.sent }
  }, [inbox.box, outbox.box, looked, slug])

  // requests, exactly the classic mailbox's set: every open one, the eight
  // most recently resolved, and one just submitted until the tree lists it
  const open = openAsks(tree, nodes.values())
  const resolvedAt = (a: AskInfo) => String(a.resolved_at ?? a.at ?? '')
  const done = (tree.asks ?? []).filter(a => !askIsOpen(a))
    .sort((a, b) => (resolvedAt(a) < resolvedAt(b) ? -1 : resolvedAt(a) > resolvedAt(b) ? 1 : 0))
    .slice(-ASK_HISTORY_KEEP)
  const doneIds = new Set(done.map(a => a.id))
  const answered = submittedCards(tree, nodes.values()).filter(a => !doneIds.has(a.id))
    .flatMap(a => { const r = answeredAsk(slug, a); return r ? [r] : [] })
  const askSig = JSON.stringify([open.map(a => [a.id, a.rev, a.at]), done.map(a => [a.id, a.status]), answered.map(a => a.id)])

  // closing a chat revokes on the click: its grant is hidden at once and stays
  // hidden until the audiences read agrees, or the revoke is refused
  const [closing, setClosing] = useState<readonly string[]>([])
  const grants = useMemo(() => aud?.audiences
    ? aud.audiences.filter(g => !(g.grantor === USER && closing.includes(g.grantee))) : null, [aud, closing])
  useEffect(() => {
    if (!aud?.audiences || !closing.length) return
    const held = new Set(aud.audiences.filter(g => g.grantor === USER).map(g => g.grantee))
    if (closing.some(id => !held.has(id))) setClosing(c => c.filter(id => held.has(id)))
  }, [aud, closing])

  // AUDIENCE REQUESTS that wait on the user, each a chat of its own. One the
  // user has just denied is hidden on the click, until the audiences read
  // agrees or the engine refuses.
  const [denying, setDenying] = useState<readonly string[]>([])
  const requests = useMemo(() => ((aud?.requests ?? []) as Record<string, unknown>[])
    .filter(r => r.target === USER && r.currently_at === USER && typeof r.from === 'string' && !denying.includes(r.from))
    .map(r => ({
      from: r.from as string,
      reason: typeof r.reason === 'string' ? r.reason : '',
      at: typeof r.at === 'string' ? r.at : '',
    })), [aud, denying])
  useEffect(() => {
    if (!aud?.requests || !denying.length) return
    const asking = new Set((aud.requests as Record<string, unknown>[]).map(r => r.from))
    if (denying.some(id => !asking.has(id))) setDenying(d => d.filter(id => asking.has(id)))
  }, [aud, denying])

  const [chosen, setChosen] = useState<{ slug: string; peer: string | null }>({ slug, peer: null })
  const sel = chosen.slug === slug ? chosen.peer : null
  const select = useCallback((peer: string | null) => {
    setChosen({ slug, peer })
    try {
      if (peer) window.sessionStorage.setItem(rememberKey(slug), peer)
      else window.sessionStorage.removeItem(rememberKey(slug))
    } catch { /* the chat still opens when session storage is unavailable */ }
  }, [slug])

  const chats = useMemo(() => dmChats({
    nodes, grants, box, openAsks: open, doneAsks: [...done, ...answered],
    isRead: id => readLocally(slug, id), hideRetired, selected: sel, requests,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [nodes, grants, box, askSig, reads, hideRetired, sel, slug, requests])
  const current = sel ? chats.find(c => c.peer === sel) ?? null : null

  // WHICH CHAT IT OPENS ON, once per org: the one holding the oldest thing
  // that waits on the user (the classic mailbox opens on its oldest unread
  // mail), else the one that was open last time, else none.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!box || opened.current === slug) return
    opened.current = slug
    if (sel || jumpTo || openChat) return
    let oldest: { peer: string; at: string } | null = null
    for (const c of chats) {
      const first = c.entries.find(e => e.unread)
      if (first && (!oldest || first.at < oldest.at)) oldest = { peer: c.peer, at: first.at }
    }
    const last = remembered(slug)
    const pick = oldest?.peer ?? (last && chats.some(c => c.peer === last) ? last : null)
    if (pick) select(pick)
  }, [box, slug, chats, sel, jumpTo, openChat, select])

  // a request from outside to open one agent's chat
  const openedChat = useRef<number | null>(null)
  useEffect(() => {
    if (!openChat || openedChat.current === openChat.seq) return
    openedChat.current = openChat.seq
    select(openChat.peer)
  }, [openChat, select])

  // A REFERENCE TO ONE MAIL opens the chat that holds it and shows the mail.
  // One outside the loaded window is asked for once, by id, as the classic
  // mailbox asks (`getMailById`), and joins its chat's timeline.
  const [flash, setFlash] = useState<{ key: string; seq: number } | null>(null)
  const jumped = useRef<string | null>(null)
  useEffect(() => {
    const request = jumpKey(jumpTo, jumpSeq)
    if (!jumpTo || !box || jumped.current === request) return
    jumped.current = request
    if (jumpTo === '@user') return
    const show = (peer: string) => { select(peer); setFlash({ key: jumpTo, seq: Date.now() }) }
    // a copy the queue made of a message is that message (dm/model.ts folds it)
    for (const c of chats) {
      const e = c.entries.find(x => x.key === jumpTo || x.copies?.includes(jumpTo))
      if (e) { select(c.peer); setFlash({ key: e.key, seq: Date.now() }); return }
    }
    if (jumpTo.startsWith('ask:')) return
    let live = true
    getMailById(slug, 'user', jumpTo).then((r) => {
      if (!live || jumped.current !== request) return
      const mail = r.mail
      if (!mail) { toast(['That message is not in your mailbox any more.']); return }
      setLooked(old => [...old.filter(l => !(l.slug === slug && l.mail.id === mail.id)), { slug, mail }])
      show(mail.from)
    }).catch((e: Error) => { if (live) toast([`could not open that message: ${e.message}`]) })
    return () => { live = false }
  }, [jumpTo, jumpSeq, box, chats, slug, select, toast])

  const readNow = useCallback((mails: MailEntry[]) => {
    const fresh = mails.filter(m => m.id && !readLocally(slug, m.id))
    if (!fresh.length) return Promise.resolve()
    // one save for the whole chat; every mail shows read on the click
    let save: Promise<unknown> | null = null
    const once = () => save ??= markRead(slug, fresh.map(m => m.id))
    return Promise.all(fresh.map(m => markReadNow(slug, m, once))).then(() => {
      for (const m of fresh) inbox.acknowledge(m.id)
      setReadBump(n => n + 1); refresh?.()
    })
  }, [slug, inbox, refresh])

  const closeChat = useCallback((chat: DmChat) => {
    const rule = dmClose(chat)
    if (!rule.can) return
    if (rule.deny) {
      // closing a chat that is only a request answers it with no: the
      // existing deny, as the classic mailbox's request row calls it
      setDenying(d => d.includes(chat.peer) ? d : [...d, chat.peer])
      if (sel === chat.peer) select(null)
      audienceAction(slug, 'deny', chat.peer, USER)
        .then(() => { setAudBump(n => n + 1); refresh?.() })
        .catch((e: Error) => {
          setDenying(d => d.filter(id => id !== chat.peer))
          toast([`error: ${e.message}`])
        })
      return
    }
    // whose grant goes: the chat's own, or the project an agent's only audience comes through
    const target = rule.revokes ?? chat.peer
    // ⚠ THE ONE CLOSE THAT ASKS (USER 2026-11-23 m0ca89ba635fd): revoking a
    // PROJECT's audience takes it from every agent that reaches the user only
    // through that project. With nobody else affected it does not ask.
    if (rule.project) {
      const lose = dmAudienceLoss(nodes, grants, target)
      if (lose.length && !window.confirm(projectCloseConfirm(target, lose))) return
    }
    setLosing(null)
    // USER m1454e651500e, ruling 2: no confirmation. The existing revoke.
    setClosing(c => c.includes(target) ? c : [...c, target])
    if (!rule.stays && sel === chat.peer) select(null)
    audienceAction(slug, 'revoke', target)
      .then(() => { setAudBump(n => n + 1); refresh?.() })
      .catch((e: Error) => {
        setClosing(c => c.filter(id => id !== target))
        toast([`error: ${e.message}`])
      })
  }, [slug, sel, select, refresh, toast, nodes, grants])

  // HOVERING A CLOSE THAT REVOKES A PROJECT'S AUDIENCE shows who loses it: the
  // project and the agents that reach the user only through it
  const [losing, setLosing] = useState<readonly string[] | null>(null)
  const closeHover = useCallback((chat: DmChat | null) => {
    const rule = chat ? dmClose(chat) : null
    if (!chat || !rule?.can || !rule.project) { setLosing(null); return }
    const target = rule.revokes ?? chat.peer
    setLosing([target, ...dmAudienceLoss(nodes, grants, target)])
  }, [nodes, grants])

  const [picking, setPicking] = useState(false)
  const startChat = useCallback((id: string) => {
    setPicking(false)
    const node = nodes.get(id)
    const has = chats.find(c => c.peer === id)
    // it can already write to the user, or cannot be written to: just open it
    if (!node || node.state !== 'live' || has?.grant || has?.topLevel || has?.inherited) { select(id); return }
    audienceAction(slug, 'grant', id)
      .then(() => { setAudBump(n => n + 1); refresh?.(); select(id) })
      .catch((e: Error) => toast([`could not open a chat with ${id}: ${e.message}`]))
  }, [nodes, chats, slug, select, refresh, toast])

  // approving a request is the existing grant; it rejects when the engine refuses
  const approve = useCallback((peer: string) =>
    audienceAction(slug, 'grant', peer).then(() => { setAudBump(n => n + 1); refresh?.() }),
  [slug, refresh])
  const agentSettings = onAgentSettings ?? ((id: string) => openSettingsAt({ scope: 'agent', org: slug, agentId: id }))

  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  // A PROJECT'S GROUP FOLDS like a ticket's sub-items in the docket: open by
  // default, and a fold is this panel's reading posture, not saved. A search
  // shows through every fold. A fold hides only what is read and not open
  // (USER 2026-11-23 m7de1b3240eb0): an agent with something unread, or with a
  // request waiting, and the chat on screen stay listed under their project.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggleFold = (project: string) => setFolded(old => {
    const next = new Set(old)
    if (!next.delete(project)) next.add(project)
    return next
  })
  const matches = (c: DmChat) => dmName(c).toLowerCase().includes(q) || c.peer.toLowerCase().includes(q)
  const shown = q ? chats.filter(matches)
    : chats.filter(c => !c.parent || !folded.has(c.parent) || c.peer === sel || c.unread > 0 || c.asks > 0)
  const listed = new Set(shown.map(c => c.peer))
  /** how many of a folded project's chats its row hides */
  const hidden = (c: DmChat) => !q && c.kids > 0 && folded.has(c.peer)
    ? chats.filter(k => k.parent === c.peer && !listed.has(k.peer)).length : 0
  const waiting = dmWaiting(chats)
  const focusAgent = onFocusAgent ? (id: string) => { close(); onFocusAgent(id) } : undefined

  const list = (
    <div className="mailer-list dm-list" role="list" aria-label="Chats">
      <div className="dm-list-head">
        <input className="mail-filter dm-search" placeholder="search chats…" aria-label="Search chats"
          value={query} onChange={e => setQuery(e.target.value)} />
        <button type="button" className="iconbtn dm-new" title="New chat" aria-label="New chat"
          onClick={() => setPicking(true)}><NewChatIcon fontSize="inherit" /></button>
      </div>
      {box == null ? <div className="dim pad">loading…</div>
        : !shown.length ? <div className="dim pad dm-empty-list">{q ? 'no chat matches' : 'no chats yet'}</div>
        : shown.map(c => <DmRow key={c.peer} chat={c} selected={c.peer === sel} losing={!!losing?.includes(c.peer)} toast={toast}
            child={!!c.parent && listed.has(c.parent)} hidden={hidden(c)}
            fold={c.kids > 0 ? { folded: folded.has(c.peer), locked: !!q, toggle: () => toggleFold(c.peer) } : undefined}
            onOpen={() => select(c.peer)} onClose={() => closeChat(c)} onCloseHover={on => closeHover(on ? c : null)} />)}
      {waiting.unread > 0 && <div className="dm-list-foot">
        <button onClick={() => clearInbox(slug)
          .then(() => { setReadBump(n => n + 1); refresh?.() })
          .catch((e: Error) => toast([`error: ${e.message}`]))}>Mark all read</button>
      </div>}
    </div>
  )

  return (
    /* ⚠ STILL "YOUR INBOX", in both views. The ruling changed the panel's shape
       and its icon, not its name; every other place that names it (its
       shortcut, the eye card's menu, the header button) says Inbox, and a
       second name for one panel would be the asymmetry the app avoids. */
    <PinFrame kind="inbox" title="Your inbox" panel="settings wide dm-panel" close={close} headerActions={headerActions}>
      <h3><ChatBubbleIcon fontSize="inherit" /> Your inbox</h3>
      <div className="mailpane">
        {/* a chat row, and New chat, step out of the narrow overlay: what they open is behind it */}
        <CollapsibleMailer collapsible listLabel="chat list" list={list} className="dm" rowSelector=".dm-row, .dm-new">
          <div className="mailer-read dm-conv">
            {current
              ? <DmConversation key={current.peer} slug={slug} tree={tree} chat={current} nodes={nodes}
                  toast={toast} refs={refs} onFocusAgent={focusAgent} flash={flash}
                  hasMore={inbox.hasMore || outbox.hasMore} loadingMore={inbox.loading || outbox.loading}
                  onLoadMore={() => { inbox.loadMore(); outbox.loadMore() }}
                  historyError={inbox.error ?? outbox.error}
                  onRetryHistory={() => { if (inbox.error) inbox.retry(); if (outbox.error) outbox.retry() }}
                  onClose={() => closeChat(current)}
                  onCloseHover={on => closeHover(on ? current : null)}
                  onApprove={() => approve(current.peer)}
                  onAgentSettings={agentSettings}
                  readNow={readNow}
                  onDelete={(m) => {
                    if (!m.id || !window.confirm(DELETE_USER_MAIL_CONFIRM)) return
                    deleteUserMail(slug, m.id)
                      .then(() => {
                        inbox.remove(m.id); setLooked(old => old.filter(l => l.mail.id !== m.id))
                        setReadBump(n => n + 1); refresh?.()
                      })
                      .catch((e: Error) => toast([`could not delete mail: ${e.message}`]))
                  }}
                  onChanged={() => { setReadBump(n => n + 1); refresh?.() }} />
              : <div className="dm-none">
                  <ChatBubbleIcon fontSize="inherit" />
                  <b>{box == null ? 'Loading your chats…' : chats.length ? 'Pick a chat' : 'No chats yet'}</b>
                  <span className="dim">Every top-level agent and every agent holding an audience with you has a chat here.</span>
                  <button type="button" onClick={() => setPicking(true)}><NewChatIcon fontSize="inherit" /> New chat</button>
                </div>}
          </div>
        </CollapsibleMailer>
      </div>
      {picking && <DmNewChat tree={tree} nodes={nodes} refs={refs} open={chats}
        close={() => setPicking(false)} onPick={startChat} />}
    </PinFrame>
  )
}

/** A chat's picture: the agent's model chip or the project's mark, as the
 *  agents list draws them, at the size of a chat row. */
function DmAvatar({ chat }: { chat: DmChat }) {
  // the system writes these: an S in the chip every sender's model letter is drawn in (USER 2026-11-23 mf47548121ae5)
  if (chat.kind === 'system') return <span className="dm-av dm-av-system" aria-hidden="true"><span className="tier letter-chip t-system">S</span></span>
  if (chat.node) return <span className="dm-av"><TierChip tier={nodeTierOf(chat.node as CanvasNode)} agentName={chat.peer} /></span>
  return <span className="dm-av dm-av-other" aria-hidden="true">{chat.peer.replace(/^@/, '').slice(0, 1).toUpperCase() || '?'}</span>
}

/** What the one confirmation says: whose audience goes, and who else loses theirs. */
export const projectCloseConfirm = (project: string, lose: readonly string[]): string =>
  `Revoke project ${project}'s audience with you?\n\n`
  + `${lose.length} agent${lose.length === 1 ? ' reaches' : 's reach'} you only through it and `
  + `${lose.length === 1 ? 'loses its' : 'lose their'} audience too: ${lose.join(', ')}.`

/** the close control's hover and focus, which show who a project's close affects */
const closeHoverProps = (on: (hover: boolean) => void) => ({
  onMouseEnter: () => on(true), onMouseLeave: () => on(false), onFocus: () => on(true), onBlur: () => on(false),
})

function DmRow({ chat, selected, losing, toast, child, hidden, fold, onOpen, onClose, onCloseHover }: {
  chat: DmChat; selected: boolean; losing: boolean; toast: ToastFn; onOpen: () => void; onClose: () => void
  onCloseHover: (hover: boolean) => void
  /** listed under its project's row */
  child: boolean
  /** a folded project: how many chats its fold hides (all of them read) */
  hidden: number
  /** a project with chats under it: its fold */
  fold?: { folded: boolean; locked: boolean; toggle: () => void }
}) {
  const rule = dmClose(chat)
  const name = dmName(chat)
  // a fold never hides anything that waits, so a project's row counts only its own
  const unread = chat.unread, asks = chat.asks
  // THE ROW'S OWN MENU (USER 2026-11-23 mf47548121ae5): what the row does, then
  // "Agent…" or "Project…", the whole menu that node has on the canvas, as a
  // submenu (`nodeMenuAction`, the one every other "Owner…" / "Project…" entry
  // is). Orgtree's own chat is no node and has no such entry.
  const menu = useContextMenu(toast)
  const registry = useAgentNavRegistry()
  const rowMenu = (anchor: Element): MenuEntry[] => {
    const node = chat.node ? nodeMenuAction(chat.kind === 'project' ? 'Project…' : 'Agent…', anchor, chat.peer,
      registry?.current?.(chat.peer, anchor) ?? [], toast) : undefined
    return [
      { label: 'Open chat', onSelect: onOpen },
      ...(rule.can ? [{ label: rule.deny ? 'Deny the audience request' : rule.project ? 'Revoke the project\u2019s audience'
        : 'Revoke its audience', onSelect: onClose }] : []),
      ...(node ? ['sep' as const, node] : []),
    ]
  }
  const last = chat.last
  const asksLabel = `${asks} request${asks === 1 ? '' : 's'} waiting on your answer`
  const unreadLabel = `${unread} unread`
  const requestLabel = `${name} asks for an audience with you`
  let preview: ReactNode = <span className="dm-row-text">No messages yet</span>
  // a resolved request says so in the resolved card's own words (canvas/asks.tsx, NulledAsk)
  if (last?.ask) preview = <><span className="dm-row-q">{askIsOpen(last.ask) ? 'Request ·'
    : last.ask.kind === 'scope' ? 'Decided ·' : 'Answered ·'}</span> <span className="dm-row-text">{askBrief(last.ask)}</span></>
  else if (last?.mail) preview = <>{last.out && <span className="dm-row-you">You:</span>} <span className="dm-row-text">{mailBrief(last.mail)}</span></>
  // the request is what this chat is about until it is answered
  if (chat.request) preview = <><span className="dm-row-q">Audience request{chat.request.reason ? ' ·' : ''}</span> <span className="dm-row-text">{brief(chat.request.reason)}</span></>
  return (
    <div role="listitem"
      className={'dm-row' + (selected ? ' sel' : '') + (unread ? ' unread' : '') + (asks ? ' asks' : '')
        + (child ? ' dm-child' : '') + (fold ? ' dm-parent' : '')
        + (chat.request ? ' request' : '') + (losing ? ' losing' : '')
        + (chat.live || chat.kind === 'system' || chat.kind === 'other' ? '' : ' off')}
      data-dm-chat={chat.peer} data-dm-parent={child ? chat.parent ?? undefined : undefined}
      {...(chat.node ? agentTooltipProps(chat.peer) : {})}
      onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => { const anchor = e.currentTarget; menu.open(e, () => rowMenu(anchor)) }}
      onClick={onOpen}>
      {/* the docket's fold arrow: its own target, so the row still opens the chat */}
      {fold && <button type="button" className={'dm-fold' + (fold.folded && !fold.locked ? ' folded' : '')} disabled={fold.locked}
        aria-expanded={!fold.folded || fold.locked}
        title={fold.locked ? `showing every match while you search`
          : fold.folded ? `show the ${hidden} agent${hidden === 1 ? '' : 's'} hidden under ${name}`
            : `hide the agents under ${name} that have nothing unread`}
        onClick={(e) => { e.stopPropagation(); fold.toggle() }}>▾</button>}
      <DmAvatar chat={chat} />
      <div className="dm-row-main">
        <div className="dm-row-l1">
          <button type="button" className="dm-row-name" aria-current={selected || undefined}
            title={`Open the chat with ${name}`}>{name}</button>
          {(chat.request?.at || last) && <ListAge at={chat.request?.at || last!.at} />}
        </div>
        <div className="dm-row-l2">
          <span className="dm-row-prev">{preview}</span>
          {chat.request && <span className="dm-badge dm-badge-request" role="img" title={requestLabel} aria-label={requestLabel}><HearingIcon fontSize="inherit" /></span>}
          {asks > 0 && <span className="dm-badge dm-badge-asks" role="img" title={asksLabel} aria-label={asksLabel}>?</span>}
          {unread > 0 && <span className="dm-badge" role="img" title={unreadLabel} aria-label={unreadLabel}>{unread}</span>}
        </div>
      </div>
      {rule.can && <button type="button" className="chip-x dm-row-close" title={rule.title}
        aria-label={`Close the chat with ${name}`} {...closeHoverProps(onCloseHover)}
        onClick={(e) => { e.stopPropagation(); onClose() }}><CloseIcon fontSize="inherit" /></button>}
      {/* a click in the menu is not a click on the row */}
      <span onClick={(e) => e.stopPropagation()}>{menu.node}</span>
    </div>
  )
}

/** Why this chat exists, as the chip beside its name. */
function DmStanding({ chat, onFocusAgent }: { chat: DmChat; onFocusAgent?: (id: string) => void }) {
  // the projects its audience comes through, each the project link every
  // reference to a project is (its icon, its colour, its menu)
  const projects = chat.via.map((p, i) => <Fragment key={p}>{i > 0 && ', '}
    <NodeLink id={p} tier="project" onFocus={onFocusAgent ? (id) => onFocusAgent(id) : undefined} /></Fragment>)
  const inheritedTitle = chat.via.length ? `Inherited from project ${chat.via.join(', ')}\n${audienceGrantTooltip(USER)}` : undefined
  // every chip here has the audience badge's box (`.aud-badge`: its spacing,
  // padding and shape), USER 2026-11-23 mae2b1aa37a9b
  if (chat.kind === 'system') return <span className="badge dim aud-badge dm-standing" title="Orgtree's own notices and decisions">system</span>
  return <>
    {chat.topLevel && <span className="badge dim aud-badge dm-standing dm-top" title="A top-level agent: it always has a direct line to you">top-level</span>}
    {/* the desk header's own user-audience badge and words (HeldAudienceChips, canvas/desk.tsx) */}
    {chat.grant && <span className="badge free aud-user aud-badge" title={audienceGrantTooltip(USER)}>
      <HearingIcon fontSize="inherit" /> audience</span>}
    {/* its own grant overrides the label: what it also has through a project is an aside */}
    {chat.grant && chat.via.length > 0 && <span className="dm-via-projects" title={inheritedTitle}>(and via {projects})</span>}
    {!chat.grant && chat.via.length > 0 && <>
      <span className="badge free aud-user aud-badge" tabIndex={0} title={inheritedTitle}
        aria-label={`Inherited from project ${chat.via.join(', ')}`}>
        <HearingIcon fontSize="inherit" /> audience</span>
      <span className="dm-via-projects">via {projects}</span>
    </>}
    {chat.node && !chat.live && <span className="badge dim aud-badge dm-standing" title="This agent is retired: it cannot be written to">retired</span>}
    {!chat.node && !isHubAddress(chat.peer) && <span className="badge dim aud-badge dm-standing"
      title="This sender is not an agent of this organization's tree now">no audience</span>}
  </>
}

function DmConversation({ slug, tree, chat, nodes, toast, refs, onFocusAgent, flash, hasMore, loadingMore,
  onLoadMore, historyError, onRetryHistory, onClose, onCloseHover, onApprove, onAgentSettings, readNow, onDelete, onChanged }: {
  slug: string; tree: TreePayload; chat: DmChat; nodes: Map<string, DmNode>
  toast: ToastFn; refs: RefRoutes
  onFocusAgent?: (id: string) => void
  flash: { key: string; seq: number } | null
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void
  historyError: string | null; onRetryHistory: () => void
  onClose: () => void
  onCloseHover: (hover: boolean) => void
  /** grant this chat's pending audience request */
  onApprove: () => Promise<unknown>
  onAgentSettings: (id: string) => void
  readNow: (mails: MailEntry[]) => Promise<unknown>
  onDelete: (m: MailEntry) => void
  onChanged: () => void
}) {
  const peer = chat.peer
  const name = dmName(chat)
  const rule = dmClose(chat)
  const entries = chat.entries
  const active = useWindowActive()

  // WHERE THE UNREAD MAIL BEGAN when the chat opened: the "new messages" line
  // stays there while the chat is on screen, though the mail below it is read
  // as soon as it is seen.
  const [newFrom] = useState(() => entries.find(e => e.unread && e.mail)?.key ?? null)

  // Seeing a chat reads it: its unread mail is marked read while the window
  // has the user. A save that was refused is not tried again on its own.
  const tried = useRef(new Set<string>())
  const unread = entries.filter(e => e.unread && e.mail && !tried.current.has(e.key)).map(e => e.mail as MailEntry)
  const unreadSig = unread.map(m => m.id).join('|')
  useEffect(() => {
    if (!active || !unread.length) return
    for (const m of unread) tried.current.add(m.id)
    readNow(unread).catch((e: Error) => toast([`could not mark read: ${e.message}`]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, unreadSig])

  // the messages the next send answers (the bubbles' Reply), oldest first
  const [replyIds, setReplyIds] = useState<string[]>([])
  const replies = replyIds.map(id => entries.find(e => e.key === id)?.mail).filter((m): m is MailRow => !!m)
  const [replyError, setReplyError] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const addReply = (m: MailRow) => {
    if (!m.id) { setReplyError('This message has no durable reply reference yet.'); return }
    if (replyIds.length >= 50 && !replyIds.includes(m.id)) { setReplyError('A multi-reply can answer at most 50 messages.'); return }
    setReplyError('')
    setReplyIds(ids => ids.includes(m.id) ? ids : [...ids, m.id])
    boxRef.current?.querySelector<HTMLTextAreaElement>('.mail-reply textarea')?.focus()
  }
  useEsc(useCallback(() => setReplyIds([]), []), replyIds.length > 0)

  // pinned to the newest message while the reader is at the bottom
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const count = entries.length
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (el.dataset.opened !== peer) {
      el.dataset.opened = peer
      // it opens where what waits on the user begins: the first unread mail,
      // else the first open request (read from its first question down)
      const mark = (newFrom ? el.querySelector<HTMLElement>('.dm-newmark') : null)
        ?? el.querySelector<HTMLElement>('.dm-ask.open')
      if (mark) {
        el.scrollTop = Math.max(0, mark.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 80)
        // when everything after it fits, that is the bottom: stay with the newest
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        return
      }
    }
    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [count, peer, newFrom, replies.length])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  // a reference jumped here: bring that bubble into view, once per request
  const flashed = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (!flash || flashed.current === flash.seq) return
    // by its own attribute, not a selector: a mail id is not an identifier
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-dm-entry]') ?? [])]
      .find(node => node.dataset.dmEntry === flash.key)
    if (!el) return
    flashed.current = flash.seq
    pinned.current = false
    el.scrollIntoView?.({ block: 'center' })
  }, [flash, count])

  const send = (text: string, attachments?: string[], notice?: boolean, _broadcast?: boolean,
    objectTarget?: ReplyTarget, selections?: SelectionTarget[]) => {
    const targets = replies
    const mailTarget = (m: MailRow) => ({ kind: 'mail' as const, org: slug, box: 'user' as const, id: m.id })
    // WHO A REPLY IN A PROJECT'S CHAT GOES TO: the member whose bubble it
    // answers, directly; or the project, when it follows up on the user's own
    // message there (the engine then hands it to that job's holder).
    let recipient = peer
    if (chat.kind === 'project' && targets.length) {
      const members = [...new Set(targets.filter(t => t.from !== USER).map(t => t.from))]
      if (members.length > 1 || (members.length === 1 && targets.some(t => t.from === USER))) {
        const mixed = new Error('In a project chat, reply to one agent at a time, or follow up on your own message.')
        setReplyError(mixed.message)
        return Promise.reject(mixed)
      }
      if (members.length === 1) recipient = members[0]!
    }
    const sent = (receipt: { id?: string; warnings?: string[] }) => {
      if (receipt.warnings?.length) toast(receipt.warnings)
      pinned.current = true
      onChanged()
    }
    const failed = (e: Error) => { toast([`error: ${e.message}`]); throw e }
    // WRITING TO A CHAT THAT IS A REQUEST APPROVES IT (USER 2026-11-23
    // mae2b1aa37a9b: "or just replied inline to auto-approve"): the existing
    // grant first, so the request is answered as a request. A grant the
    // engine refuses does not hold the message back: the message is still
    // the user's to send, and the request stays in the chat to answer.
    const approved = chat.request ? onApprove().catch(() => undefined) : Promise.resolve()
    if (!targets.length && !objectTarget && !selections?.length) {
      // A NEW MESSAGE TYPED IN THIS PANEL, not a reply: it says so to the agent
      // (USER 2026-11-23 m79c022311f95, m034b5c83b8f2), which then answers by
      // mail to the user, the only thing this panel shows.
      return approved.then(() => sendPanelMessage(slug, peer, text, attachments, notice)).then(sent).catch(failed)
    }
    // a reply: the classic mailbox's own call and target shapes
    const target = selections?.length
      ? [...(objectTarget ? [objectTarget] : []), ...targets.map(mailTarget), ...selections]
      : objectTarget ?? (targets.length > 1 ? targets.map(mailTarget) : mailTarget(targets[0]!))
    return approved.then(() => sendLinkedReply(slug, recipient, text, target, attachments, notice))
      .then(async (receipt) => {
        setReplyIds([])
        sent(receipt)
        // commands have no mail receipt; read the originals only after a durable reply
        const answered = targets.filter(t => t.from !== USER)
        if (!receipt.id || !answered.length) return
        try { await readNow(answered as MailEntry[]) }
        catch { toast(['Reply sent, but could not mark the original mail read.']) }
      })
      .catch(failed)
  }

  const fileHref = (path: string, m: MailRow) => {
    const owner = m.to != null ? m.to : m.from
    return typeof owner === 'string' && owner ? fileUrl(slug, owner, path) : ''
  }
  const mdBase = (m: MailRow) => {
    const owner = m.to != null ? m.to : m.from
    return typeof owner === 'string' && owner ? fileBase(slug, owner) : ''
  }
  const senderChip = (id: string) => <SenderChip id={id} nodes={nodes} onFocusAgent={onFocusAgent} />

  const rows: ReactNode[] = []
  let day = ''
  let prev: DmEntry | null = null
  for (const e of entries) {
    const d = dayKey(e.at)
    if (d !== day) { rows.push(<div className="dm-day" key={'day' + d}><span>{dayLabel(e.at)}</span></div>); day = d; prev = null }
    if (newFrom && e.key === newFrom) {
      const n = entries.filter(x => !x.out && x.mail && x.at >= e.at).length
      rows.push(<div className="dm-newmark" key="new">{n} new message{n === 1 ? '' : 's'}</div>)
    }
    const first = !prev || prev.out !== e.out || !!e.ask || !!prev.ask
      || Date.parse(e.at) - Date.parse(prev.at) > GROUP_GAP_MS
    if (e.ask) {
      rows.push(<DmAsk key={e.key} entry={e} slug={slug} tree={tree} node={nodes.get(e.ask.node)}
        toast={toast} refs={refs} flash={flash?.key === e.key ? flash.seq : null} />)
    } else if (e.mail) {
      const m = e.mail
      rows.push(<DmBubble key={e.key} entry={e} m={m} first={first} slug={slug} refs={refs} toast={toast}
        flash={flash?.key === e.key ? flash.seq : null}
        replying={replyIds.includes(e.key)}
        sender={senderChip} fileHref={fileHref} mdBase={mdBase}
        onReply={m.id && chat.live && (!e.out || (chat.kind === 'project' && !!e.job)) ? () => addReply(m) : undefined}
        onRead={e.unread ? () => { readNow([m as MailEntry]).catch((err: Error) => toast([`could not mark read: ${err.message}`])) } : undefined}
        onDelete={!e.out && m.id ? () => onDelete(m as MailEntry) : undefined}
        onAckJob={!e.out ? (reply, opts) => acknowledgeJob({
          row: m as MailEntry, reply, attachments: opts?.attachments, notice: opts?.notice,
          sendReply: (row, replyText, o) => sendLinkedReply(slug, row.from, replyText,
            opts?.objectTarget ?? { kind: 'mail', org: slug, box: 'user', id: row.id! }, o?.attachments, o?.notice),
          ack: (copy, replyId) => runOp(slug, { op: 'user_job_ack', copy, ...(replyId ? { reply: replyId } : {}) }),
        }).then(() => { toast(['job acknowledged']); onChanged() })
          .catch((err: Error) => { toast([`error: ${err.message}`]); throw err }) : undefined} />)
    }
    prev = e
  }
  // the request itself, last: it is what waits on the user in this chat
  if (chat.request) {
    rows.push(<DmAudienceRequest key="audience-request" peer={peer} name={name} request={chat.request}
      canWrite={chat.live} onApprove={() => { onApprove().catch((e: Error) => toast([`error: ${e.message}`])) }}
      onDeny={onClose} />)
  }

  const canWrite = chat.live && (chat.kind === 'agent' || chat.kind === 'project')
  const agent = chat.kind === 'agent' && chat.live ? chat.node as CanvasNode | null : null
  return (
    <>
      <div className="dm-head" data-dm-peer={peer}>
        <DmAvatar chat={chat} />
        <div className="dm-who">
          <div className="dm-who-l1">
            {/* the agent link every reference to an agent is (`NodeLink`: its
                chip, tooltip, menu and click), USER 2026-11-23 mae2b1aa37a9b */}
            {chat.node
              ? <span className="dm-who-name"><NodeLink id={peer} tier={nodeTierOf(chat.node as CanvasNode)}
                  onFocus={onFocusAgent ? (id) => onFocusAgent(id) : undefined} /></span>
              : isHubAddress(peer) ? <HubContactChip address={peer} /> : <span className="dm-who-name"><span className="cc-name">{name}</span></span>}
            <DmStanding chat={chat} onFocusAgent={onFocusAgent} />
          </div>
          <div className="dm-who-l2">
            {chat.node && chat.kind === 'agent'
              ? <TrayStatus node={chat.node as CanvasNode} turn={chat.node.turns?.[chat.node.turns.length - 1]} live={chat.live} />
              : <span className="dim">{chat.kind === 'project' ? 'project' : chat.kind === 'system' ? 'notices and decisions' : 'not in this organization now'}</span>}
          </div>
        </div>
        {chat.node && <button type="button" className="iconbtn dm-gear"
          title={`${name}'s settings`} aria-label={`Open ${name}'s settings`}
          onClick={() => onAgentSettings(peer)}><SettingsIcon fontSize="inherit" /></button>}
        <button type="button" className="iconbtn dm-close" disabled={!rule.can} aria-disabled={!rule.can}
          title={rule.title} aria-label={rule.can ? `Close the chat with ${name}` : `The chat with ${name} cannot be closed`}
          {...closeHoverProps(onCloseHover)}
          onClick={onClose}><CloseIcon fontSize="inherit" /></button>
      </div>
      <div className="dm-timeline" ref={scroller} onScroll={onScroll} role="log" aria-label={`Messages with ${name}`}>
        <div className="dm-timeline-inner">
          {hasMore && <button type="button" className="dm-older" disabled={loadingMore}
            onClick={onLoadMore}>{loadingMore ? 'loading…' : 'Load older messages'}</button>}
          {historyError && <div role="alert" className="dm-history-error">Could not load older mail. <button onClick={onRetryHistory}>Retry</button></div>}
          {!entries.length && <div className="dm-start">
            <DmAvatar chat={chat} />
            <b>{name}</b>
            <span className="dim">{canWrite ? 'No messages yet. What you write here reaches it as mail from you.'
              : 'No messages here.'}</span>
          </div>}
          {rows}
        </div>
      </div>
      <div className="dm-compose" ref={boxRef}>
        {replies.length > 0 && <div className="dm-replybar" role="group" aria-label="Replying to">
          <ReplyIcon fontSize="inherit" />
          <div className="dm-replybar-list">
            {replies.map(m => <div className="dm-replybar-row" key={m.id}>
              <span className="dm-replybar-text">{mailBrief(m) || 'a message'}</span>
              <button type="button" className="chip-x" title="Do not reply to this message" aria-label="Do not reply to this message"
                onClick={() => setReplyIds(ids => ids.filter(id => id !== m.id))}><CloseIcon fontSize="inherit" /></button>
            </div>)}
          </div>
          {replies.length > 1 && <button type="button" className="dm-replybar-clear" onClick={() => setReplyIds([])}>Cancel all</button>}
        </div>}
        {replyError && <div role="alert" className="mail-reply-state failed">{replyError}</div>}
        {canWrite
          ? <MailReplyBox key={peer} target={peer} slug={slug} toast={toast} objectActions
              placeholder={!replies.length ? `message ${peer}…`
                : chat.kind !== 'project' ? `reply to ${peer}…`
                : replies[0]!.from === USER ? `follow up on your message to ${peer}…` : `reply to ${replies[0]!.from}…`}
              sendLabel={replies.length ? 'reply' : 'send'} onSend={send}
              /* the agent's own fast mode and effort, the desk message box's
                 controls and saves (USER 2026-11-23 mae2b1aa37a9b) */
              controls={agent ? <>
                <FastModeButton node={agent} slug={slug} toast={toast} />
                <AgentEffortButton node={agent} slug={slug} toast={toast} />
              </> : undefined} />
          : <div className="dm-nowrite dim">{chat.kind === 'system' ? 'Orgtree’s own mail cannot be answered.'
              : chat.node ? `${peer} is retired and cannot be written to.` : `${name} cannot be written to from here.`}</div>}
      </div>
    </>
  )
}

function DmBubble({ entry, m, first, slug, refs, toast, flash, replying, sender, fileHref, mdBase,
  onReply, onRead, onDelete, onAckJob }: {
  entry: DmEntry; m: MailRow; first: boolean; slug: string; refs: RefRoutes; toast: ToastFn
  flash: number | null
  replying: boolean
  sender: (id: string, m: MailRow) => ReactNode
  fileHref: (path: string, m: MailRow) => string
  mdBase: (m: MailRow) => string
  onReply?: () => void
  onRead?: () => void
  onDelete?: () => void
  onAckJob?: (reply?: string, opts?: { attachments?: string[]; notice?: boolean; objectTarget?: ReplyTarget }) => Promise<unknown>
}) {
  const menu = useContextMenu(toast)
  const ref = useRef<HTMLDivElement>(null)
  const decoded = decodeEventRow(m, PROFILE)
  const view = decoded.kind === 'known' ? projectEvent(decoded.event, m.from) : null
  // a typed mail that is more than a message draws its whole card, title
  // included; a message, a notice and a reply are their text
  const ordinary = !view || ['ordinary.message', 'ordinary.notice', 'reply.mail'].includes(view.event.variant)
  const notice = isMailNotice(m)
  const label = KIND_LABEL[m.kind] ?? null
  const mega = entry.megaphone
  const megaLabel = !mega ? null
    : mega.record ? `Megaphone · ${mega.to} agent${mega.to === 1 ? '' : 's'}` : `Megaphone · ${mega.project}`
  const megaTitle = !mega ? undefined
    : mega.record ? `Sent by megaphone to the agents under ${mega.project}: ${mega.names.join(', ')}. Each has its copy in its own chat.`
      : `One copy of a megaphone send to the ${mega.to} agent${mega.to === 1 ? '' : 's'} under project ${mega.project}`
  // where the user's message to a project stands in its queue
  const job = entry.job
  const holder = job?.holders[job.holders.length - 1]
  const jobTitle = job && job.holders.length > 1 ? `handed to ${job.holders.join(', then ')}` : undefined
  const queued = !entry.out ? m.queue?.job : undefined
  const reference = !entry.out && m.id ? refToken({ kind: 'mail', org: slug, box: 'user', id: m.id }) : null
  const copy = () => {
    const text = mailRowCopyText(m as CopyableMailRow, PROFILE)
    if (!text.trim()) { toast(['could not copy — message is empty']); return }
    void copyToClipboard(ref.current, text).then(ok => toast([ok ? 'copied the message text' : 'could not copy the message text — clipboard unavailable']))
  }
  const entries = (): MenuEntry[] => mailMenuEntries({
    leading: [
      ...(onReply ? [{ label: 'Reply', onSelect: onReply }] : []),
      ...(onRead ? [{ label: 'Mark as read', onSelect: onRead }] : []),
      ...(onDelete ? [{ label: 'Delete', onSelect: onDelete }] : []),
    ],
    copy, canCopy: mailRowCopyText(m as CopyableMailRow, PROFILE).trim() !== '', reference,
    copyReference: () => { if (reference) void copyToClipboard(ref.current, reference).then(ok => toast([ok ? `copied the reference ${reference}` : 'could not copy the reference — clipboard unavailable'])) },
  })
  return (
    <div ref={ref} data-dm-entry={entry.key} data-dm-via={entry.via}
      className={'dm-msg ' + (entry.out ? 'out' : 'in') + (first ? ' first' : '') + (entry.unread ? ' unread' : '')
        + (flash != null ? ' flash' : '') + (replying ? ' replying' : '')}>
      <div className="dm-msg-row">
        <div className={'dm-bubble' + (notice ? ' notice' : '') + (m.urgent ? ' urgent' : '') + (ordinary ? '' : ' typed')
          + (mega ? ' megaphone' : '')}
          onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => menu.open(e, entries)}>
          <span className="dm-sr">{entry.out ? 'You' : m.from}{notice ? ', notice' : ''}: </span>
          {/* in a project's chat: which agent wrote this, or which one it was written to */}
          {entry.via && <div className="dm-via">{entry.out && <span className="dim">to</span>}{sender(entry.via, m)}</div>}
          {/* a notice wears no label: its border says it (USER 2026-11-23
              mae2b1aa37a9b: "dont display the 'NOTICE' badge") */}
          {(label || m.urgent || queued || megaLabel) && <div className="dm-labels">
            {/* the project's own mark: its icon and colour, as everywhere a project is named */}
            {mega && <span className="dm-kind dm-kind-megaphone" title={megaTitle}><CampaignIcon fontSize="inherit" /> {mega.record ? megaLabel
              : <>Megaphone · <TierChip tier="project" agentName={mega.project} />{mega.project}</>}</span>}
            {label && <span className={'dm-kind dm-kind-' + m.kind}>{label}</span>}
            {m.urgent && <span className="urgentkind" title={m.urgent_reason ? `urgent — ${m.urgent_reason}` : 'urgent'}>urgent</span>}
            {queued && <span className="queuekind job-kind"
              title={`a job project ${queued.name}'s mail queue handed to this mailbox`}>project job · {queued.name}</span>}
          </div>}
          {m.urgent && m.urgent_reason && <div className="urgent-why">{m.urgent_reason}</div>}
          <MailMessageBody m={m} standalone={!ordinary} org={slug} refs={refs} mdBase={mdBase} sender={sender} />
          <MailAttachments m={m} fileHref={fileHref} />
          {onAckJob && needsAck(queued) && <JobAckPane job={queued} onAck={onAckJob} target={m.from} slug={slug} toast={toast} />}
          {job && <div className={'dm-job dm-job-' + job.state} title={jobTitle}>
            {job.state === 'waiting' ? 'waiting in the queue'
              : job.state === 'dead' ? 'not delivered: nobody took it from the queue'
              : <>{job.state === 'done' ? 'acknowledged by' : 'held by'} {holder ? sender(holder, m) : 'a listener'}</>}
          </div>}
          <div className="dm-meta"><time dateTime={m.at} title={fmtFull(m.at)} aria-label={fmtFull(m.at)}>{fmtHm(m.at)}</time></div>
        </div>
        <div className="dm-actions">
          {onReply && <button type="button" className="iconbtn" title={entry.out ? 'Follow up on this message' : 'Reply'}
            aria-label={entry.out ? 'Follow up on this message' : 'Reply'} onClick={onReply}><ReplyIcon fontSize="inherit" /></button>}
          <button type="button" className="iconbtn" title="Copy message text" aria-label="Copy message text" onClick={copy}><CopyIcon fontSize="inherit" /></button>
        </div>
      </div>
      {menu.node}
    </div>
  )
}

/** AN AUDIENCE REQUEST IN ITS CHAT (USER 2026-11-23 mae2b1aa37a9b): who asks
 *  and why, with the two answers the classic mailbox's request row has.
 *  Writing in the message box below approves it too. */
function DmAudienceRequest({ peer, name, request, canWrite, onApprove, onDeny }: {
  peer: string; name: string; request: { reason: string; at: string }; canWrite: boolean
  onApprove: () => void; onDeny: () => void
}) {
  return (
    <div className="dm-msg in first dm-audreq" data-dm-request={peer}>
      <div className="dm-bubble dm-request" role="group" aria-label={`Audience request from ${name}`}>
        <div className="dm-labels"><span className="dm-kind dm-kind-audience"><HearingIcon fontSize="inherit" /> Audience request</span></div>
        <div className="dm-request-what"><b>{name}</b> asks for an audience with you{request.reason ? ':' : '.'}</div>
        {request.reason && <div className="dm-request-why">{request.reason}</div>}
        <div className="dm-request-acts">
          <button type="button" className="primary" onClick={onApprove}>Approve</button>
          <button type="button" onClick={onDeny}>Deny</button>
        </div>
        {canWrite && <div className="dm-request-hint dim">Writing to {name} below approves it too.</div>}
        {request.at && <div className="dm-meta"><time dateTime={request.at} title={fmtFull(request.at)} aria-label={fmtFull(request.at)}>{fmtHm(request.at)}</time></div>}
      </div>
    </div>
  )
}

/** A request in the timeline: open, it is answered here exactly as on the
 *  agent's desk or in the classic mailbox (the same card, the same submit);
 *  resolved, it is the answered card. In a chat each tab is its own bubble. */
function DmAsk({ entry, slug, tree, node, toast, refs, flash }: {
  entry: DmEntry; slug: string; tree: TreePayload; node?: DmNode
  toast: ToastFn; refs: RefRoutes; flash: number | null
}) {
  const ask = entry.ask!
  return (
    <div data-dm-entry={entry.key}
      className={'dm-msg in first dm-ask' + (askIsOpen(ask) ? ' open' : ' done') + (flash != null ? ' flash' : '')}>
      <InboxAskCard ask={ask} slug={slug} tree={tree} node={node} toast={toast} refs={refs} layout="messages" />
      <div className="dm-meta"><time dateTime={ask.at} title={fmtFull(ask.at)} aria-label={fmtFull(ask.at)}>{fmtHm(ask.at)}</time></div>
    </div>
  )
}

/** NEW CHAT: a copy of the agents list, with everything it has anywhere else
 *  (USER m1454e651500e, ruling 3): the same rows, filter box, archived fold,
 *  active-only switch and agent menu. Picking an agent opens its chat, and
 *  gives it an audience with the user first when it has none. */
function DmNewChat({ tree, nodes, refs, open, close, onPick }: {
  tree: TreePayload; nodes: Map<string, DmNode>; refs: RefRoutes
  open: readonly DmChat[]
  close: () => void; onPick: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [active, setActive] = useState(false)
  const map = nodes as unknown as Map<string, CanvasNode>
  const rows = trayRows(map, { query, archived, activeOnly: active })
  const registry = useAgentNavRegistry()
  const menu = useContextMenu()
  const has = new Set(open.filter(c => c.grant || c.topLevel || c.inherited).map(c => c.peer))
  return (
    <PinFrame kind="dm-new-chat" title="New chat" panel="tray-panel team-panel dm-newchat" close={close}
      pinnable={false} dialogLabel="New chat" titleInModal
      headerActions={<ActiveAgentsFilter checked={active} onChange={setActive} />}>
      <div className="dim dm-newchat-hint">Pick an agent to open its chat. One that cannot write to you yet is given an audience with you.</div>
      <AgentTray map={map} rows={rows} query={query} onQuery={setQuery}
        archived={archived} onArchived={setArchived} onPick={onPick}
        filterLabel="Filter agents" refs={refs} compactAt={tree.compact_at}
        showQueuedModelBadge={false}
        rowProps={n => ({ 'data-dm-pick': n.id, 'data-dm-open': has.has(n.id) ? 'yes' : undefined })}
        onRowMenu={(e, n) => menu.open(e, () => registry?.current?.(n.id, e.currentTarget) ?? [])}
        empty={<div className="dim team-empty">no agents match these filters</div>} />
      {menu.node}
    </PinFrame>
  )
}

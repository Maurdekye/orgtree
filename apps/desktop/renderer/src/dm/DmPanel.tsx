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
//   6. newest chat first, an unread count on each;
//   8. one panel per org, with that org's agents only.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { AgentName, TierChip, nodeTierOf } from '../canvas/identity'
import { agentNavProps, useAgentNavRegistry } from '../canvas/agentnav'
import { ActiveAgentsFilter, AgentTray, trayRows } from '../canvas/agenttray'
import { TrayStatus } from '../canvas/desk'
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
  ChatBubbleIcon, CloseIcon, CopyIcon, HearingIcon, NewChatIcon, ReplyIcon,
} from '../icons'
import { fmtDay, fmtFull, fmtHm, fmtStamp, isToday } from '../timefmt'
import { useSurfaceDocument } from '../popout'
import { dmChats, dmClose, dmNodes, dmWaiting } from './model'
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
  onFocusAgent, refs, headerActions }: DmPanelProps) {
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
    isRead: id => readLocally(slug, id), hideRetired, selected: sel,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [nodes, grants, box, askSig, reads, hideRetired, sel, slug])
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
    const hit = chats.find(c => c.entries.some(e => e.key === jumpTo))
    if (hit) { show(hit.peer); return }
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
    // USER m1454e651500e, ruling 2: no confirmation. The existing revoke.
    setClosing(c => c.includes(chat.peer) ? c : [...c, chat.peer])
    if (!rule.stays && sel === chat.peer) select(null)
    audienceAction(slug, 'revoke', chat.peer)
      .then(() => { setAudBump(n => n + 1); refresh?.() })
      .catch((e: Error) => {
        setClosing(c => c.filter(id => id !== chat.peer))
        toast([`error: ${e.message}`])
      })
  }, [slug, sel, select, refresh, toast])

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

  const act = (action: string, node: string, target?: string | null) =>
    audienceAction(slug, action, node, target)
      .then(() => { setAudBump(n => n + 1); refresh?.() })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  const requests = (aud?.requests?.filter(r => r.target === USER && r.currently_at === USER) ?? []) as
    { from: string; reason?: string }[]

  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q ? chats.filter(c => dmName(c).toLowerCase().includes(q) || c.peer.toLowerCase().includes(q)) : chats
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
      {requests.length > 0 && <div className="dm-requests">
        <div className="field-label">audience requests</div>
        {requests.map(r => (
          <div className="hist-row" key={r.from}>
            <SenderChip id={r.from} nodes={nodes} />
            <span className="dim">{r.reason}</span>
            <button className="primary" onClick={() => void act('grant', r.from)}>grant</button>
            <button onClick={() => void act('deny', r.from, USER)}>deny</button>
          </div>
        ))}
      </div>}
      {box == null ? <div className="dim pad">loading…</div>
        : !shown.length ? <div className="dim pad dm-empty-list">{q ? 'no chat matches' : 'no chats yet'}</div>
        : shown.map(c => <DmRow key={c.peer} chat={c} selected={c.peer === sel}
            onOpen={() => select(c.peer)} onClose={() => closeChat(c)} />)}
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
  if (chat.kind === 'system') return <span className="dm-av dm-av-system" aria-hidden="true">O</span>
  if (chat.node) return <span className="dm-av"><TierChip tier={nodeTierOf(chat.node as CanvasNode)} agentName={chat.peer} /></span>
  return <span className="dm-av dm-av-other" aria-hidden="true">{chat.peer.replace(/^@/, '').slice(0, 1).toUpperCase() || '?'}</span>
}

function DmRow({ chat, selected, onOpen, onClose }: {
  chat: DmChat; selected: boolean; onOpen: () => void; onClose: () => void
}) {
  const rule = dmClose(chat)
  const name = dmName(chat)
  const last = chat.last
  const asksLabel = `${chat.asks} request${chat.asks === 1 ? '' : 's'} waiting on your answer`
  const unreadLabel = `${chat.unread} unread`
  let preview: ReactNode = <span className="dm-row-text">No messages yet</span>
  // a resolved request says so in the resolved card's own words (canvas/asks.tsx, NulledAsk)
  if (last?.ask) preview = <><span className="dm-row-q">{askIsOpen(last.ask) ? 'Request ·'
    : last.ask.kind === 'scope' ? 'Decided ·' : 'Answered ·'}</span> <span className="dm-row-text">{askBrief(last.ask)}</span></>
  else if (last?.mail) preview = <>{last.out && <span className="dm-row-you">You:</span>} <span className="dm-row-text">{mailBrief(last.mail)}</span></>
  return (
    <div role="listitem"
      className={'dm-row' + (selected ? ' sel' : '') + (chat.unread ? ' unread' : '') + (chat.asks ? ' asks' : '')
        + (chat.live || chat.kind === 'system' || chat.kind === 'other' ? '' : ' off')}
      data-dm-chat={chat.peer}
      {...(chat.node ? agentNavProps(chat.peer) : {})}
      onClick={onOpen}>
      <DmAvatar chat={chat} />
      <div className="dm-row-main">
        <div className="dm-row-l1">
          <button type="button" className="dm-row-name" aria-current={selected || undefined}
            title={`Open the chat with ${name}`}>{name}</button>
          {last && <ListAge at={last.at} />}
        </div>
        <div className="dm-row-l2">
          <span className="dm-row-prev">{preview}</span>
          {chat.asks > 0 && <span className="dm-badge dm-badge-asks" role="img" title={asksLabel} aria-label={asksLabel}>?</span>}
          {chat.unread > 0 && <span className="dm-badge" role="img" title={unreadLabel} aria-label={unreadLabel}>{chat.unread}</span>}
        </div>
      </div>
      {rule.can && <button type="button" className="chip-x dm-row-close" title={rule.title}
        aria-label={`Close the chat with ${name}`}
        onClick={(e) => { e.stopPropagation(); onClose() }}><CloseIcon fontSize="inherit" /></button>}
    </div>
  )
}

/** Why this chat exists, as the chip beside its name. */
function DmStanding({ chat }: { chat: DmChat }) {
  if (chat.kind === 'system') return <span className="badge dim" title="Orgtree's own notices and decisions">system</span>
  return <>
    {chat.topLevel && <span className="badge dim" title="A top-level agent: it always has a direct line to you">top-level</span>}
    {/* the desk header's own user-audience badge and words (HeldAudienceChips, canvas/desk.tsx) */}
    {chat.grant && <span className="badge free aud-user aud-badge" title={audienceGrantTooltip(USER)}>
      <HearingIcon fontSize="inherit" /> audience</span>}
    {chat.inherited && <span className="badge free aud-user aud-badge" tabIndex={0}
      title={`Inherited from project ${chat.inherited}
${audienceGrantTooltip(USER)}`}
      aria-label={`Inherited from project ${chat.inherited}`}>
      <HearingIcon fontSize="inherit" /> via {chat.inherited}</span>}
    {chat.node && !chat.live && <span className="badge dim" title="This agent is retired: it cannot be written to">retired</span>}
    {!chat.node && !isHubAddress(chat.peer) && <span className="badge dim"
      title="This sender is not an agent of this organization's tree now">no audience</span>}
  </>
}

function DmConversation({ slug, tree, chat, nodes, toast, refs, onFocusAgent, flash, hasMore, loadingMore,
  onLoadMore, historyError, onRetryHistory, onClose, readNow, onDelete, onChanged }: {
  slug: string; tree: TreePayload; chat: DmChat; nodes: Map<string, DmNode>
  toast: ToastFn; refs: RefRoutes
  onFocusAgent?: (id: string) => void
  flash: { key: string; seq: number } | null
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void
  historyError: string | null; onRetryHistory: () => void
  onClose: () => void
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
    const sent = (receipt: { id?: string; warnings?: string[] }) => {
      if (receipt.warnings?.length) toast(receipt.warnings)
      pinned.current = true
      onChanged()
    }
    const failed = (e: Error) => { toast([`error: ${e.message}`]); throw e }
    if (!targets.length && !objectTarget && !selections?.length) {
      // A NEW MESSAGE TYPED IN THIS PANEL, not a reply: it says so to the agent
      // (USER 2026-11-23 m79c022311f95, m034b5c83b8f2), which then answers by
      // mail to the user, the only thing this panel shows.
      return sendPanelMessage(slug, peer, text, attachments, notice).then(sent).catch(failed)
    }
    // a reply: the classic mailbox's own call and target shapes
    const target = selections?.length
      ? [...(objectTarget ? [objectTarget] : []), ...targets.map(mailTarget), ...selections]
      : objectTarget ?? (targets.length > 1 ? targets.map(mailTarget) : mailTarget(targets[0]!))
    return sendLinkedReply(slug, peer, text, target, attachments, notice)
      .then(async (receipt) => {
        setReplyIds([])
        sent(receipt)
        // commands have no mail receipt; read the originals only after a durable reply
        if (!receipt.id || !targets.length) return
        try { await readNow(targets as MailEntry[]) }
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
        onReply={!e.out && m.id && chat.live ? () => addReply(m) : undefined}
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

  const canWrite = chat.live && (chat.kind === 'agent' || chat.kind === 'project')
  return (
    <>
      <div className="dm-head" data-dm-peer={peer}>
        <DmAvatar chat={chat} />
        <div className="dm-who">
          <div className="dm-who-l1">
            {chat.node
              ? <span className="dm-who-name"><AgentName id={peer} tier={null} onFocus={onFocusAgent ? (id) => onFocusAgent(id) : undefined} /></span>
              : isHubAddress(peer) ? <HubContactChip address={peer} /> : <span className="dm-who-name"><span className="cc-name">{name}</span></span>}
            <DmStanding chat={chat} />
          </div>
          <div className="dm-who-l2">
            {chat.node && chat.kind === 'agent'
              ? <TrayStatus node={chat.node as CanvasNode} turn={chat.node.turns?.[chat.node.turns.length - 1]} live={chat.live} />
              : <span className="dim">{chat.kind === 'project' ? 'project' : chat.kind === 'system' ? 'notices and decisions' : 'not in this organization now'}</span>}
          </div>
        </div>
        <button type="button" className="iconbtn dm-close" disabled={!rule.can} aria-disabled={!rule.can}
          title={rule.title} aria-label={rule.can ? `Close the chat with ${name}` : `The chat with ${name} cannot be closed`}
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
              placeholder={replies.length ? `reply to ${peer}…` : `message ${peer}…`}
              sendLabel={replies.length ? 'reply' : 'send'} onSend={send} />
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
  const job = !entry.out ? m.queue?.job : undefined
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
    <div ref={ref} data-dm-entry={entry.key}
      className={'dm-msg ' + (entry.out ? 'out' : 'in') + (first ? ' first' : '') + (entry.unread ? ' unread' : '')
        + (flash != null ? ' flash' : '') + (replying ? ' replying' : '')}>
      <div className="dm-msg-row">
        <div className={'dm-bubble' + (notice ? ' notice' : '') + (m.urgent ? ' urgent' : '') + (ordinary ? '' : ' typed')}
          onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => menu.open(e, entries)}>
          <span className="dm-sr">{entry.out ? 'You' : m.from}{notice ? ', notice' : ''}: </span>
          {(label || m.urgent || notice || job) && <div className="dm-labels">
            {label && <span className={'dm-kind dm-kind-' + m.kind}>{label}</span>}
            {notice && <span className="dm-kind dm-kind-notice" title="A passive notice: it wakes nobody and expects no reply">Notice</span>}
            {m.urgent && <span className="urgentkind" title={m.urgent_reason ? `urgent — ${m.urgent_reason}` : 'urgent'}>urgent</span>}
            {job && <span className="queuekind job-kind"
              title={`a job project ${job.name}'s mail queue handed to this mailbox`}>project job · {job.name}</span>}
          </div>}
          {m.urgent && m.urgent_reason && <div className="urgent-why">{m.urgent_reason}</div>}
          <MailMessageBody m={m} standalone={!ordinary} org={slug} refs={refs} mdBase={mdBase} sender={sender} />
          <MailAttachments m={m} fileHref={fileHref} />
          {onAckJob && needsAck(job) && <JobAckPane job={job} onAck={onAckJob} target={m.from} slug={slug} toast={toast} />}
          <div className="dm-meta"><time dateTime={m.at} title={fmtFull(m.at)} aria-label={fmtFull(m.at)}>{fmtHm(m.at)}</time></div>
        </div>
        <div className="dm-actions">
          {onReply && <button type="button" className="iconbtn" title="Reply" aria-label="Reply" onClick={onReply}><ReplyIcon fontSize="inherit" /></button>}
          <button type="button" className="iconbtn" title="Copy message text" aria-label="Copy message text" onClick={copy}><CopyIcon fontSize="inherit" /></button>
        </div>
      </div>
      {menu.node}
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

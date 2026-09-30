// attention/AttentionQueue.tsx — THE "NEEDS ATTENTION" PANEL.
//
// One mixed list of everything waiting on the user in the open organization,
// beside a reading pane. The rows and the pane are NOT drawn here: each kind
// of entry is drawn by the component its own home surface uses (user
// 2026-09-29: "the list elements should each look identical to how they each
// look in their respective lists … and the bodies should look identical to how
// they look in their respective details"):
//
//   entry          row                         body
//   ticket         the docket's DocketRow      the docket's DocketPane (inline
//                                              reply, dismiss, the lot)
//   urgent mail    the inbox's MailRowView     the inbox's MailReadPane (reply)
//   question       the inbox's MailRowView     MailReadPane + the inbox's
//                                              InboxAskCard (answer)
//
// So the list is a `.mailer` like the inbox and the docket, and a ticket row
// and its pane sit in a `.docket-modal` context (display: contents), because
// the docket's row and pane styles are scoped to it. What this file owns is
// only WHICH entries are listed (attention/feed.ts), the selection, and the
// resolutions below.
//
// ⚠ NOTHING HERE OWNS ANY STATE THE SERVER OWNS, with ONE deliberate
// exception: a ticket whose attention flag is being dismissed leaves the list
// AT ONCE (user 2026-09-29: "dismissing attention on a ticket is slow"). It
// used to wait for the POST and then a whole /work-items refetch. The row is
// hidden optimistically and comes back, with the error, if the server refuses.
// Everything else — a mail's read mark, a question's answer — still leaves
// because the server stopped listing it.
//
// The other piece of local memory is the urgent-mail retention: a mail you
// have just read stays on screen while it is still the selected row (ticket
// rule), and `retainSelected` in feed.ts is the whole of it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { notificationInboxTarget } from '../notifications'
import type { DesktopNotice } from '../notifications'
import { useSubmittedAsks } from '../asksubmitted'
import { markReadNow, readLocally, useLocalReads } from '../mailread'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useWorkItems } from '../canvas/useworkitems'
import { dismissWorkItemAttention, fileBase, fileUrl, getInbox, markRead } from '../api'
import { sendLinkedReply } from '../events/reply'
import type { MailEntry, ToastFn, TreePayload, WorkItem } from '../types'
import { usePolledStatus } from '../canvas/shared'
import type { MailLinkFn, MailRow, PolledStatus } from '../canvas/shared'
import { InboxAskCard } from '../canvas/asks'
import { MailReadPane, MailRowView } from '../canvas/mail'
import { SenderChip } from '../canvas/senderchip'
import { DocketPane, DocketRow, itemActorIds, useNodeFacts } from '../canvas/docket'
import { buildMentionIndex } from '../canvas/workrefs'
import { mailRefTarget, refToken, useRefRoutes } from '../canvas/reflinks'
import type { TypedRef } from '../canvas/workrefs'
import { decodeEventRow } from '../events/decode'
import { projectEvent } from '../events/project'
import { eventSurface } from '../events/card'
import { BASE } from '../api'
import {
  attentionNodes, buildAttentionRows, isRetained, nextSelection, retainSelected,
} from './feed'
import type { AttentionRow } from './feed'

export type AttentionNotificationFocus = (notice: DesktopNotice) => boolean

export interface AttentionQueueProps {
  slug: string
  tree: TreePayload
  toast: ToastFn
  /** leave the simplified workflow for a surface that owns the whole thing.
   *  Each is optional and each one omitted simply draws no such control —
   *  never a button that does nothing (the app's rule for absent handlers). */
  onOpenItem?: (itemSlug: string) => void
  /** ⚠ WHILE THE ATTENTION VIEW IS PRESENTED THIS OPENS THE AGENT'S DESK IN
   *  THE RIGHT-HAND PANEL — the host's one focus path (OrgCanvas `centerOn`)
   *  routes there. Every agent name below goes through it. */
  onFocusAgent?: (agentId: string) => void
  onOpenDoc?: (docId: string) => void
  /** ⚠ THE CANONICAL `MailLinkFn`, NOT A TypedRef HANDLER — the same shape the
   *  org host hands its slot and the same one the canvas's own desks get.
   *  `mailRefTarget` (canvas/reflinks) is the app's own bridge between the two
   *  shapes. */
  onOpenMail?: MailLinkFn
  /** The host offers notification clicks to the actual listed rows first. */
  onNotificationFocus?: (focus: AttentionNotificationFocus | null) => void
  /**
   * THE FRESHNESS OF `tree`, WHICH IS THE LIST'S THIRD SOURCE.
   *
   * Question rows do not come from a feed this panel polls — they are read out
   * of the `tree` prop, which somebody else fetches. So this panel cannot know
   * whether that payload is current, one poll behind, or the last good copy
   * after a failed refresh, unless it is told.
   *
   * ⚠ ABSENT MEANS "NOT VOUCHED FOR", NOT "FINE". Without it the confident
   * "Nothing is waiting on you here." is withheld, because a third of the list
   * would be unaccounted for in the sentence that exists precisely to be
   * trustworthy (finding f3, v3-ux-review-opus, 2026-09-21).
   *
   * ⚠ A CURRENT STATUS CLAIMS ONLY THE LATEST OBSERVED READ of the tree
   * (multi-window-design, 2026-09-21): not a coherent snapshot across the three
   * sources, and not knowledge that no question was raised since. Ordinary
   * polling latency is `current`; a known failed refresh is `stale`.
   */
  treeStatus?: PolledStatus
}

export function AttentionQueue({
  slug, tree, toast, onOpenItem, onFocusAgent, onOpenDoc, onOpenMail, treeStatus, onNotificationFocus,
}: AttentionQueueProps) {
  // read-only visitor: a public organization is served to someone who is not
  // the operator, so every resolution control is withheld. The rows still
  // render — what is waiting is not a secret from a reader who can already
  // see the docket — but nothing here can write.
  const readOnly = !!tree.public || !!BASE

  // ⚠ BOTH FEEDS ARE POLLED, and both are the SAME calls their own panels
  // make, so a dismissal or a read performed in the Docket or the inbox
  // reaches this list on the next tick without either surface knowing the
  // other exists. `usePolled` also wakes on the livebus, so a mutation made
  // HERE lands in well under a poll interval.
  const [bump, setBump] = useState(0)
  const workFeed = useWorkItems(slug, false, false, 5000, bump)
  const boxFeed = usePolledStatus(() => getInbox(slug), [slug], 5000, bump)
  const work = workFeed.value
  const box = boxFeed.value
  const refetch = useCallback(() => setBump((n) => n + 1), [])

  /**
   * ⚠ WHAT THIS PANEL IS ENTITLED TO CLAIM. Two independent feeds, each of
   * which may be current, still loading, unreadable, or showing something it
   * can no longer refresh — and "nothing is waiting" and "nothing could be
   * read" look identical to a reader and mean opposite things.
   *
   * THE RULE: the confident empty statement requires every source to have read
   * successfully on its most recent attempt. Anything less says what is
   * actually known instead. Partial coverage is a real state: usable rows are
   * shown AND the gap is named.
   */
  const feeds = [
    { name: 'tickets', status: workFeed.status },
    { name: 'mail', status: boxFeed.status },
    // the tree is not polled here; it arrives as a prop, so its freshness is
    // only known if the caller reports it — see `treeStatus`
    ...(treeStatus ? [{ name: 'questions', status: treeStatus }] : []),
  ]
  const unavailable = feeds.filter((f) => f.status.unavailable)
  const stale = feeds.filter((f) => f.status.stale)
  const firstLoad = feeds.filter((f) => f.status.loading)
  /** EVERY REASON THIS LIST MIGHT NOT BE THE WHOLE TRUTH, for all three of its
   *  sources (finding f3): a feed that failed, one that could not refresh, one
   *  still on its first read, and a tree nobody vouched for. */
  const gaps = [
    ...unavailable.map((f) => ({ name: f.name, why: 'could not be read' })),
    ...stale.map((f) => ({ name: f.name, why: 'could not be refreshed' })),
    ...firstLoad.map((f) => ({ name: f.name, why: 'is still loading' })),
    ...(treeStatus ? [] : [{ name: 'questions', why: 'are not verified here' }]),
  ]
  const complete = gaps.length === 0
  const gapPhrase = gaps.map((g) => `${g.name} ${g.why}`).join(' · ')
  const listNames = (rows: readonly { name: string }[]) => rows.map((f) => f.name).join(' and ')

  const nodes = useMemo(() => attentionNodes(tree), [tree])
  const nodeMap = useMemo(
    () => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // ---- the optimistic half of dismissing a ticket's flag (see the header)
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set())
  // point 31: a submitted question leaves this list on the click
  const submitted = useSubmittedAsks()
  // a mail read here (or in the inbox) is read on the click: an unselected
  // urgent row leaves at once, not after the save and the next inbox read
  const locallyRead = useLocalReads()
  const allLive = useMemo(() => buildAttentionRows({
    items: work?.attention ?? work?.items, archived: work?.archived, backlogged: work?.backlogged,
    pending: box?.pending?.filter((m) => !readLocally(slug, m.id)), nodes, asks: tree.asks,
  }), [work, box, nodes, tree.asks, submitted, locallyRead, slug])
  const live = useMemo(() => dismissing.size
    ? allLive.filter((r) => !(r.kind === 'ticket' && r.item && dismissing.has(r.item.slug)))
    : allLive, [allLive, dismissing])
  // a dismissal the server has confirmed no longer needs hiding: once the feed
  // stops listing the flag, forget it, so a flag RAISED AGAIN later shows up
  useEffect(() => {
    if (!dismissing.size) return
    const still = new Set([...dismissing].filter((s) =>
      allLive.some((r) => r.kind === 'ticket' && r.item?.slug === s)))
    if (still.size !== dismissing.size) setDismissing(still)
  }, [allLive, dismissing])

  // the panel's own selection, and the previous render's rows — the two
  // inputs `retainSelected` needs to honour the urgent-mail rule
  const [selected, setSelected] = useState<string | null>(null)
  const shown = useRef<AttentionRow[]>([])
  const rows = retainSelected(live, shown.current, selected)
  shown.current = rows

  // A selected row that resolved (dismissed, answered — or a mail that was
  // read and then deselected) takes the selection to its neighbour rather
  // than leaving the pane empty.
  const previous = useRef<AttentionRow[]>([])
  useEffect(() => {
    if (selected && !rows.some((r) => r.key === selected)) {
      setSelected(nextSelection(previous.current, selected))
    }
    previous.current = rows
  })

  const refs = useRefRoutes(slug, nodeMap, {
    onOpenItem, onFocusAgent, onOpenDoc,
    // ⚠ CONDITIONAL, because `useRefRoutes` reads the PRESENCE of this handler
    // to decide whether a mail token is something this surface can open at all.
    onOpenMail: onOpenMail ? (r: TypedRef) => onOpenMail(mailRefTarget(r)) : undefined,
    tierOf: (id: string) => nodeMap.get(id)?.tier,
    view: tree.foreground,
  })

  // ---- the docket's own context for its row and pane
  const tickets = useMemo(() => rows.flatMap((r) => (r.item ? [r.item] : [])), [rows])
  const actorIds = useMemo(() => itemActorIds(tickets), [tickets])
  const facts = useNodeFacts(slug, tree, actorIds)
  const refIndex = useMemo(() => buildMentionIndex(tickets,
    [...facts].map(([id, f]) => [id, f.tier] as const)), [tickets, facts])
  const asksById = useMemo(
    () => new Map((tree.asks ?? []).map((a) => [a.id, a])), [tree.asks])
  const ageTick = Math.floor(Date.now() / 60_000)

  // ---- the three resolutions, each through the surface that already owns it
  const dismiss = useCallback((item: WorkItem) => {
    if (readOnly || !item.manual_attention) return
    const key = item.slug
    setDismissing((s) => new Set([...s, key]))
    dismissWorkItemAttention(slug, item.slug, item.manual_attention.set_rev)
      .then(() => {
        toast([`dismissed the attention flag on “${item.title}”`])
        refetch()
      })
      .catch((e: Error) => {
        // refused: the row comes back, and says why
        setDismissing((s) => { const n = new Set(s); n.delete(key); return n })
        toast([`error: ${e.message}`])
      })
  }, [readOnly, slug, toast, refetch])

  const read = (m: MailEntry) =>
    markReadNow(slug, m, () => markRead(slug, [m.id])).then(refetch)
      .catch((e: Error) => toast([`could not mark read: ${e.message}`]))

  // ⚠ SELECTING AN URGENT MAIL MARKS IT READ, exactly as opening it in the
  // inbox does. That IS this row's resolution: the ticket says an urgent mail
  // leaves "once it has been read and is no longer selected", so reading on
  // open and retaining while selected are the two halves of one rule.
  // The read runs AFTER the render that selects the row. A read shows at once
  // (mailread.ts) and its store update renders synchronously, so reading in
  // the same call let a notification click (outside a React event) drop the
  // mail from the list before it was selected, and it was never retained.
  const [toRead, setToRead] = useState<MailEntry | null>(null)
  useEffect(() => {
    if (!toRead) return
    setToRead(null)
    void read(toRead)
  }, [toRead])
  const openRow = (row: AttentionRow) => {
    setSelected(row.key)
    if (readOnly || row.kind !== 'mail' || !row.mail) return
    // only a mail the server still calls unread is marked — re-selecting a
    // retained row must not post a second read for the same message
    if ((box?.pending ?? []).some((p) => p.id === row.mail!.id)) setToRead(row.mail)
  }

  // ---- keyboard: the list is a real listbox, so selection is reachable
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  // Membership belongs to this queue, including optimistic dismissal and
  // selected read-mail retention. Do not infer it from notification kind alone.
  useLayoutEffect(() => {
    if (!onNotificationFocus) return
    onNotificationFocus((notice) => {
      if (notice.org !== slug) return false
      const row = rows.find((r) => notice.kind === 'work-attention'
        ? r.kind === 'ticket' && r.item?.slug === notice.item
        : notice.kind === 'question'
          ? r.kind === 'question' && 'ask:' + r.ask?.id === notificationInboxTarget(notice)
          : notice.kind === 'urgent-mail'
            && r.kind === 'mail' && r.mail?.id === notificationInboxTarget(notice))
      if (!row) return false
      openRow(row)
      listRef.current?.focus({ preventScroll: true })
      const cell = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-attn-row]') ?? [])]
        .find((c) => c.getAttribute('data-attn-row') === row.key)
      cell?.firstElementChild?.scrollIntoView?.({ block: 'nearest' })
      if (detailRef.current) detailRef.current.scrollTop = 0
      return true
    })
    return () => onNotificationFocus(null)
  })
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rows.length || e.target !== e.currentTarget) return
    const i = rows.findIndex((r) => r.key === selected)
    const go = (to: number) => {
      e.preventDefault()
      const row = rows[Math.min(rows.length - 1, Math.max(0, to))]
      if (!row) return
      openRow(row)
      // scanned, not selector-built — a key can hold any character
      const cell = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-attn-row]') ?? [])]
        .find((c) => c.getAttribute('data-attn-row') === row.key)
      cell?.firstElementChild?.scrollIntoView?.({ block: 'nearest' })
    }
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? rows.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
  }

  // the inbox's own identity renderers: the plain name in the row, the chip
  // (with the jump) in the reading pane
  const rowParty = (id: string) => <span>{id}</span>
  const paneSender = (id: string) => <SenderChip id={id} nodes={nodeMap}
    onFocusAgent={onFocusAgent ? (agentId) => onFocusAgent(agentId) : undefined} />
  // a mail that was just read is on screen only because it is selected: it is
  // drawn as the inbox draws a read mail, not as still waiting
  const asMail = (row: AttentionRow): MailRow =>
    isRetained(row, live) ? { ...row.mailRow!, _wait: false } : row.mailRow!

  const current = rows.find((r) => r.key === selected) ?? null
  const profile = BASE ? 'public' : 'operator'
  const typed = (m: MailRow) => {
    const d = decodeEventRow(m, profile)
    return d.kind === 'known' ? projectEvent(d.event) : null
  }
  const surface = current && current.kind !== 'ticket' && current.mailRow
    ? eventSurface(asMail(current), profile) : { className: '' }

  return (
    <div className="attn-wrap">
      {/* no header row (user 2026-09-29). What the header's count line used to
          say about a source that could not be read is still said, here, but
          only when there is such a gap — the empty-list statements below cover
          the case with no rows. */}
      {rows.length > 0 && gaps.length > 0 &&
        <div className={'dim attn-gaps' + (stale.length ? ' attn-stale' : '')}
          role="status">{gapPhrase}</div>}
      <div className="mailer attn-mailer">
        <div className="mailer-list attn-mlist" role="listbox" aria-label="Needs attention"
          tabIndex={0} ref={listRef} onKeyDown={onListKey}>
          {/* ⚠ THE CONFIDENT SENTENCE IS GATED ON `complete`. Everything else
              gets a statement about what could not be read, because an empty
              list the panel cannot vouch for must never be drawn as reassurance. */}
          {!rows.length && complete &&
            <div className="dim pad attn-empty">Nothing is waiting on you here.</div>}
          {!rows.length && !complete && !!unavailable.length &&
            <div className="dim pad attn-unavailable" role="status">
              {listNames(unavailable)} could not be read, so this list is not
              a statement about what is waiting on you.
            </div>}
          {!rows.length && !complete && !unavailable.length && !!stale.length &&
            <div className="dim pad attn-stale-empty" role="status">
              Nothing was waiting at the last successful read, but
              {' '}{listNames(stale)} could not be refreshed since.
            </div>}
          {!rows.length && !complete && !unavailable.length && !stale.length
            && !!firstLoad.length &&
            <div className="dim pad attn-loading" role="status">
              Still reading {listNames(firstLoad)} — this is not yet a statement
              about what is waiting on you.
            </div>}
          {!rows.length && !complete && !unavailable.length && !stale.length
            && !firstLoad.length &&
            <div className="dim pad attn-unverified" role="status">
              Nothing to show — {gapPhrase}.
            </div>}
          {rows.map((row) => {
            const sel = row.key === selected
            // the cell carries this panel's hooks and nothing visual
            // (display: contents); the row inside is the home surface's own
            if (row.kind === 'ticket' && row.item) {
              return (
                <div key={row.key} className="attn-cell docket-modal" data-attn-row={row.key}
                  data-attn-kind={row.kind} role="option" aria-selected={sel}>
                  <DocketRow item={row.item} selected={sel} org={slug} toast={toast}
                    ageTick={ageTick} onClick={() => openRow(row)} onDismiss={dismiss}
                    facts={facts} onFocusAgent={onFocusAgent} />
                </div>
              )
            }
            const m = asMail(row)
            return (
              <div key={row.key} className="attn-cell" data-attn-row={row.key}
                data-attn-kind={row.kind} role="option" aria-selected={sel}>
                <MailRowView m={m} view={row.kind === 'mail' ? typed(m) : null}
                  selected={sel} party={rowParty(m.from)} onClick={() => openRow(row)} />
              </div>
            )
          })}
        </div>
        {/* ⚠ the hook sits on `.mailer-read` itself, not on a wrapper inside
            it: the inbox's pane styles include CHILD selectors
            (`.mailer-read > .event-head`), and a wrapper silently broke them
            (measured, attnqueue_probe.py) */}
        <div className={'mailer-read attn-mread ' + surface.className}
          ref={detailRef} data-attn-detail={current?.kind}>
          {!current
            ? <div className="dim pad mailer-none">{rows.length ? 'Select an entry to see it.' : ''}</div>
            : current.kind === 'ticket' && current.item
              ? <div className="attn-cell docket-modal">
                  <DocketPane key={slug + ':' + current.item.slug} slug={slug}
                    item={current.item} toast={toast} asksById={asksById}
                    onDismiss={dismiss}
                    // there is no modal to close here: a jump to an agent from
                    // the pane keeps the ticket selected
                    close={() => {}}
                    onFocusAgent={onFocusAgent} facts={facts} refIndex={refIndex}
                    onGoToItem={(id) => {
                      const hit = rows.find((r) => r.item?.slug === id)
                      if (hit) openRow(hit)
                      else onOpenItem?.(id)
                    }}
                    refWorld={refs.world} onOpenRef={refs.onOpen} refresh={refetch} />
                </div>
              : current.mailRow
                ? <MailReadPane cur={asMail(current)} refs={refs}
                      mdBase={(m) => fileBase(slug, m.from)}
                      fileHref={(p, m) => fileUrl(slug, m.from, p)}
                      sender={paneSender} party={current.mailRow.from}
                      waitLabel="unread" toast={toast}
                      custom={current.kind === 'question' && current.ask
                        ? <InboxAskCard ask={current.ask} slug={slug} tree={tree}
                            node={nodeMap.get(current.ask.node)} toast={toast} />
                        : null}
                      onReply={readOnly || current.kind !== 'mail' || !current.mail ? undefined
                        : (text, attachments, notice) => {
                          const mail = current.mail!
                          return sendLinkedReply(slug, mail.from, text,
                            { kind: 'mail', org: slug, box: 'user', id: mail.id }, attachments, notice)
                            .then(async (receipt) => {
                              toast([`sent to ${mail.from}`, ...(receipt.warnings ?? [])])
                              // Commands have no mail receipt; only a durable reply reads.
                              if (!receipt.id) return
                              try { await markRead(slug, [mail.id]) } catch {
                                toast(['Reply sent, but could not mark the original mail read.'])
                              }
                              refetch()
                            })
                            .catch((e: Error) => { toast([`error: ${e.message}`]); throw e })
                        }} />
                : <div className="dim pad">This entry is no longer listed.</div>}
        </div>
      </div>
    </div>
  )
}

/** the reference token for one of this panel's mail rows — the user's own
 *  box, the same token the inbox writes */
export const attentionMailRef = (org: string, id: string): string =>
  refToken({ kind: 'mail', org, box: 'user', id })

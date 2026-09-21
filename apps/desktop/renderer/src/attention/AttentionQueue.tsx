// attention/AttentionQueue.tsx — THE "NEEDS ATTENTION" PANEL.
//
// One mixed list of everything waiting on the user in the open organization,
// beside a reading pane that carries each row's OWN resolution. The structure
// is the app's existing list-and-pane idiom (the Docket, the mailboxes, the
// documents gallery all read this way); what is new is that the rows are
// heterogeneous — see attention/feed.ts for the membership and resolution
// rules, which live there as pure functions so they can be tested without a
// DOM.
//
// ⚠ NOTHING HERE OWNS ANY STATE THE SERVER OWNS. A ticket's attention flag, a
// mail's read mark and a question's answer are all written through the exact
// calls the Docket, the inbox and the ask card already use, and this panel
// learns the outcome by re-reading the same feeds. There is no optimistic
// local copy of any of the three: a row leaves because the server stopped
// listing it, which is the only claim this list is entitled to make.
//
// The ONE piece of local memory is the urgent-mail retention — a mail you have
// just read stays on screen while it is still the selected row (ticket rule),
// and `retainSelected` in feed.ts is the whole of it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { dismissWorkItemAttention, fileBase, getInbox, getWorkItems, markRead } from '../api'
import { sendLinkedReply } from '../events/reply'
import { DocketIcon, MailIcon, NotificationsActiveIcon, PsychologyIcon } from '../icons'
import type { MailEntry, ToastFn, TreeNode, TreePayload, WorkItem } from '../types'
import { md, orgPxc, usePolled } from '../canvas/shared'
import type { MailRow } from '../canvas/shared'
import { AgentName } from '../canvas/identity'
import { focusByAttr } from './dom'
import { AskCard } from '../canvas/asks'
import { MailReplyBox } from '../canvas/mail'
import { RefMdBody } from '../canvas/refmd'
import { refToken, useRefRoutes } from '../canvas/reflinks'
import type { TypedRef } from '../canvas/workrefs'
import { EventCard } from '../events/card'
import { decodeEventRow } from '../events/decode'
import { BASE } from '../api'
import { fmtShort } from '../timefmt'
import {
  attentionNodes, buildAttentionRows, countRows, isRetained, nextSelection, retainSelected,
} from './feed'
import type { AttentionRow } from './feed'

export interface AttentionQueueProps {
  slug: string
  tree: TreePayload
  toast: ToastFn
  /** leave the simplified workflow for a surface that owns the whole thing.
   *  Each is optional and each one omitted simply draws no such control —
   *  never a button that does nothing (the app's rule for absent handlers). */
  onOpenItem?: (itemSlug: string) => void
  onFocusAgent?: (agentId: string) => void
  onOpenDoc?: (docId: string) => void
  onOpenMail?: (ref: TypedRef) => void
}

const KIND_LABEL: Record<AttentionRow['kind'], string> = {
  ticket: 'ticket', mail: 'urgent mail', question: 'question',
}

function KindIcon({ kind }: { kind: AttentionRow['kind'] }) {
  if (kind === 'ticket') return <DocketIcon fontSize="inherit" />
  if (kind === 'mail') return <NotificationsActiveIcon fontSize="inherit" />
  return <PsychologyIcon fontSize="inherit" />
}

export function AttentionQueue({
  slug, tree, toast, onOpenItem, onFocusAgent, onOpenDoc, onOpenMail,
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
  const work = usePolled(() => getWorkItems(slug, true, true), [slug], 5000, bump)
  const box = usePolled(() => getInbox(slug), [slug], 5000, bump)
  const refetch = useCallback(() => setBump((n) => n + 1), [])

  const nodes = useMemo(() => attentionNodes(tree), [tree])
  const nodeMap = useMemo(
    () => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const live = useMemo(() => buildAttentionRows({
    items: work?.items, archived: work?.archived, backlogged: work?.backlogged,
    pending: box?.pending, nodes,
  }), [work, box, nodes])

  // the panel's own selection, and the previous render's rows — the two
  // inputs `retainSelected` needs to honour the urgent-mail rule
  const [selected, setSelected] = useState<string | null>(null)
  const shown = useRef<AttentionRow[]>([])
  const rows = retainSelected(live, shown.current, selected)
  shown.current = rows

  // A selected row that resolved (dismissed, answered — or a mail that was
  // read and then deselected) takes the selection to its neighbour rather
  // than leaving the pane empty. Done in an effect because it is a reaction
  // to the feed changing underneath a choice the user already made.
  const previous = useRef<AttentionRow[]>([])
  useEffect(() => {
    if (selected && !rows.some((r) => r.key === selected)) {
      setSelected(nextSelection(previous.current, selected))
    }
    previous.current = rows
  })

  const counts = countRows(rows)
  const loading = work === null || box === null

  const refs = useRefRoutes(slug, nodeMap, {
    onOpenItem, onFocusAgent, onOpenDoc, onOpenMail,
    tierOf: (id: string) => nodeMap.get(id)?.tier,
  })

  // ---- the three resolutions, each through the surface that already owns it
  const dismiss = (item: WorkItem) => {
    if (!item.manual_attention) return
    dismissWorkItemAttention(slug, item.slug, item.manual_attention.set_rev)
      .then(() => {
        toast([`dismissed the attention flag on “${item.title}”`])
        refetch()
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  }

  const read = (m: MailEntry) =>
    markRead(slug, [m.id]).then(refetch).catch(() => { /* the poll still decides */ })

  // ⚠ SELECTING AN URGENT MAIL MARKS IT READ, exactly as opening it in the
  // inbox does. That IS this row's resolution: the ticket says an urgent mail
  // leaves "once it has been read and is no longer selected", so reading on
  // open and retaining while selected are the two halves of one rule.
  const openRow = (row: AttentionRow) => {
    setSelected(row.key)
    if (readOnly || row.kind !== 'mail' || !row.mail) return
    // only a mail the server still calls unread is marked — re-selecting a
    // retained row must not post a second read for the same message
    if ((box?.pending ?? []).some((p) => p.id === row.mail!.id)) void read(row.mail)
  }

  // ---- keyboard: the list is a real listbox, so selection is reachable
  const listRef = useRef<HTMLDivElement>(null)
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return
    const i = rows.findIndex((r) => r.key === selected)
    const go = (to: number) => {
      e.preventDefault()
      const row = rows[Math.min(rows.length - 1, Math.max(0, to))]
      if (row) {
        openRow(row)
        // scanned, not selector-built — see focusByAttr for why
        focusByAttr(listRef.current, 'data-attn-row', row.key)
      }
    }
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? rows.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
  }

  const current = rows.find((r) => r.key === selected) ?? null

  return (
    <div className="attn-wrap">
      <div className="attn-head">
        <h3><NotificationsActiveIcon fontSize="inherit" /> Needs attention</h3>
        <span className="dim attn-counts" aria-live="polite">
          {loading && !rows.length ? 'loading…'
            : counts.total === 0 ? 'nothing is waiting'
              : [
                counts.ticket ? `${counts.ticket} ticket${counts.ticket > 1 ? 's' : ''}` : '',
                counts.mail ? `${counts.mail} urgent mail` : '',
                counts.question ? `${counts.question} question${counts.question > 1 ? 's' : ''}` : '',
              ].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="attn-body">
        <div className="attn-list" role="listbox" aria-label="Needs attention"
          tabIndex={rows.length && !current ? 0 : -1}
          ref={listRef} onKeyDown={onListKey}>
          {!rows.length && !loading &&
            <div className="dim pad attn-empty">Nothing is waiting on you here.</div>}
          {rows.map((row) => (
            <div key={row.key} data-attn-row={row.key} data-attn-kind={row.kind}
              role="option" tabIndex={row.key === selected ? 0 : -1}
              aria-selected={row.key === selected}
              className={'attn-row attn-' + row.kind
                + (row.key === selected ? ' sel' : '')
                + (isRetained(row, live) ? ' attn-resolved' : '')}
              onClick={() => openRow(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(row) }
              }}>
              <span className="attn-row-kind" title={KIND_LABEL[row.kind]}
                aria-label={KIND_LABEL[row.kind]}><KindIcon kind={row.kind} /></span>
              <span className="attn-row-main">
                <span className="attn-row-title">{row.title || KIND_LABEL[row.kind]}</span>
                {row.subtitle && <span className="dim attn-row-sub">{row.subtitle}</span>}
              </span>
              <span className="attn-row-meta">
                {row.agent && <span className="attn-row-agent">
                  <AgentName id={row.agent} tier={nodeMap.get(row.agent)?.tier}
                    onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} />
                </span>}
                {row.at && <span className="dim attn-row-at" title={row.at}>{fmtShort(row.at)}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="attn-pane">
          {!current
            ? <div className="dim pad">{rows.length ? 'Select a row to resolve it.' : ''}</div>
            : <AttentionDetail row={current} slug={slug} tree={tree} toast={toast}
                readOnly={readOnly}
                resolvedMail={isRetained(current, live)}
                node={current.agent ? nodeMap.get(current.agent) : undefined}
                refs={refs}
                onDismiss={dismiss}
                onRead={read}
                onRefetch={refetch}
                onOpenItem={onOpenItem}
                onFocusAgent={onFocusAgent} />}
        </div>
      </div>
    </div>
  )
}

function AttentionDetail({
  row, slug, tree, toast, readOnly, resolvedMail, node, refs,
  onDismiss, onRead, onRefetch, onOpenItem, onFocusAgent,
}: {
  row: AttentionRow
  slug: string
  tree: TreePayload
  toast: ToastFn
  readOnly: boolean
  /** this mail is no longer in the feed — it is on screen because it is
   *  selected, and it says so rather than looking like live work */
  resolvedMail: boolean
  /** the asking/sending agent's own tree entry — the ask card's credit bar
   *  reads its seat, grant and live children from it, exactly as the inbox's
   *  card does */
  node?: TreeNode
  refs: ReturnType<typeof useRefRoutes>
  onDismiss: (item: WorkItem) => void
  onRead: (m: MailEntry) => void
  onRefetch: () => void
  onOpenItem?: (itemSlug: string) => void
  onFocusAgent?: (agentId: string) => void
}): ReactNode {
  if (row.kind === 'ticket') {
    const item = row.item
    if (!item) return <div className="dim pad">This ticket is no longer listed.</div>
    const flag = item.manual_attention
    return (
      <div className="attn-detail attn-detail-ticket">
        <h4 className="attn-detail-title">{item.title}</h4>
        <div className="dim attn-detail-sub">
          <span className={'docket-status status-' + item.status + ' attention'}>Needs attention</span>
          {item.owner && <span className="attn-detail-owner">
            <AgentName id={item.owner.node} tier={node?.tier}
              onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} />
          </span>}
        </div>
        {flag && <div className="docket-attention-box">
          <div className="docket-question-head docket-attention-head">
            <span>Manual attention from{' '}
              <AgentName id={flag.by.node}
                onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} /></span>
            <span className="dim" title={flag.at}>{fmtShort(flag.at)}</span>
          </div>
          <div className="attn-detail-reason">{flag.reason}</div>
        </div>}
        <div className="row attn-detail-actions">
          {!readOnly && flag && item.attention_sources.includes('manual') &&
            <button className="primary" onClick={() => onDismiss(item)}>Dismiss attention</button>}
          {onOpenItem && <button onClick={() => onOpenItem(item.slug)}>Open in the docket</button>}
        </div>
      </div>
    )
  }

  if (row.kind === 'mail') {
    const mail = row.mail
    if (!mail) return <div className="dim pad">This message is no longer listed.</div>
    return (
      <div className="attn-detail attn-detail-mail">
        <div className="attn-detail-sub">
          <AgentName id={mail.from} tier={node?.tier}
            onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} />
          <span className="dim" title={mail.at}>{fmtShort(mail.at)}</span>
          {resolvedMail
            ? <span className="dim attn-read-mark">read</span>
            : <span className="attn-urgent-mark">urgent</span>}
        </div>
        {mail.urgent_reason &&
          <div className="attn-detail-reason attn-urgent-reason">{mail.urgent_reason}</div>}
        <MailBody row={mail as MailRow} slug={slug} refs={refs} />
        <div className="row attn-detail-actions">
          {!readOnly && !resolvedMail &&
            <button onClick={() => onRead(mail)}>Mark read</button>}
        </div>
        {!readOnly && <MailReplyBox target={mail.from} slug={slug} toast={toast}
          placeholder={`reply to ${mail.from}…`}
          onSend={(text, attachments, notice) =>
            sendLinkedReply(slug, mail.from, text,
              { kind: 'mail', org: slug, box: 'user', id: mail.id }, attachments, notice)
              .then(async (receipt) => {
                toast([`sent to ${mail.from}`, ...(receipt.warnings ?? [])])
                // Commands have no mail receipt; only a durable reply reads.
                if (!receipt.id) return
                try { await markRead(slug, [mail.id]) } catch {
                  toast(['Reply sent, but could not mark the original mail read.'])
                }
                onRefetch()
              })
              .catch((e: Error) => { toast([`error: ${e.message}`]); throw e })} />}
      </div>
    )
  }

  // a question: the canonical ask card, with the same props the inbox gives it
  const ask = row.ask
  if (!ask) return <div className="dim pad">This question is no longer open.</div>
  const kids = (node?.children ?? []).filter((c) => c.state === 'live')
  return (
    <div className="attn-detail attn-detail-question">
      <div className="attn-detail-sub">
        <AgentName id={row.agent ?? ask.node} tier={node?.tier}
          onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} />
        <span className="dim" title={ask.at}>{fmtShort(ask.at)}</span>
      </div>
      <AskCard ask={ask} slug={slug} toast={toast}
        seat={node?.seat ?? 0}
        committed={(node?.grant ?? 0) - (node?.free ?? 0)}
        segments={kids.map((c) => ({ seat: c.seat, grant: c.grant }))}
        pxc={orgPxc(tree)}
        maxTop={tree.max_top_grant ?? 1000} />
    </div>
  )
}

/** The mail body, rendered exactly the way the mailboxes render it: a typed
 *  event through its own card, anything else as reference-aware markdown.
 *  Mirrors `messageContent` in canvas/mail.tsx, which is local to MailList. */
function MailBody({ row, slug, refs }: {
  row: MailRow; slug: string; refs: ReturnType<typeof useRefRoutes>
}) {
  const profile = BASE ? 'public' : 'operator'
  const decoded = decodeEventRow(row, profile)
  const base = fileBase(slug, row.from)
  if (decoded.kind === 'legacy') {
    return <RefMdBody className="mailer-body md" html={md(row.body, base)}
      world={refs.world} onOpen={refs.onOpen} />
  }
  return <div className="mailer-body">
    <EventCard row={row} profile={profile} org={slug} imgBase={base}
      world={refs.world} onOpen={refs.onOpen} />
  </div>
}

/** the reference token for one of this panel's mail rows — the user's own
 *  box, the same token the inbox writes */
export const attentionMailRef = (org: string, id: string): string =>
  refToken({ kind: 'mail', org, box: 'user', id })

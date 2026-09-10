import { HUMAN_HIDDEN_VARIANTS } from '../generated/events'
import type { ReactNode } from 'react'
import type { Event, PublicEvent, Segment, PublicSegment } from '../generated/events'
import { decodeEventRow, isAuthoredUser, record } from './decode'
import type { EventProfile } from './decode'
import { EventCard, eventSurface } from './card'
import { eventSummary } from './project'
import { RefMdBody } from '../canvas/refmd'
import { ReplyPreview } from '../canvas/replypreview'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import { md } from '../canvas/shared'
import { fileBase, fileUrl } from '../api'
import { AttachThumb, fmtBytes, isImg } from '../canvas/img'
import { DownloadIcon } from '../icons'
import { fmtFull } from '../timefmt'
import { replyContext } from '../eventReply'
import type { ReplyContext } from '../eventReply'

/** Approved machine-only composition is retained for agents and storage,
 * but contributes no empty heading to the human transcript. */
const hiddenSegments = new Set<string>(HUMAN_HIDDEN_VARIANTS)
export function humanSegmentEvent(event: Event | PublicEvent): boolean {
  return !hiddenSegments.has(event.variant)
}
type AnySegment = Segment | PublicSegment
export { isSegments } from './wire'
import { isSegments } from './wire'
export function authoredUserLabel(segments: unknown, profile: EventProfile): string | null {
  if (!isSegments(segments, profile)) return null
  const content: string[] = []
  for (const segment of segments) if (segment.kind === 'mail') {
    for (const row of segment.rows) {
      const decoded = decodeEventRow(row, profile)
      if (decoded.kind === 'known' && isAuthoredUser(decoded.event)) {
        const text = eventSummary(decoded.event)
        content.push(text)
      }
    }
  }
  return content.length ? content.join(' ').replace(/\s+/g, ' ').slice(0, 600) : null
}
export function SegmentAttachments({ values, slug, nid }: { values?: unknown[]; slug: string; nid: string }) {
  const files = (values ?? []).filter(record)
  if (!files.length) return null
  return <div className="attach-row">{files.map((file, i) => {
    const path = typeof file.path === 'string' ? file.path : null
    const name = typeof file.name === 'string' ? file.name : path?.split('/').pop() ?? 'File'
    const meta = typeof file.bytes === 'number' && Number.isFinite(file.bytes) ? fmtBytes(file.bytes) : undefined
    if (!path) return <span key={i} className="attach-chip">{name}</span>
    const href = fileUrl(slug, nid, path)
    return isImg(name) ? <AttachThumb key={i} href={href} name={name} meta={meta} />
      : <a key={i} className="attach-chip" href={href} download={name}><DownloadIcon fontSize="inherit" /> {name}<span className="dim">{meta}</span></a>
  })}</div>
}
interface SegmentProps { segments: AnySegment[]; profile: EventProfile; slug: string; nid: string
  world?: RefWorld | null; onOpen?: (ref: ResolvedRef) => void; actor?: (id: string) => ReactNode
  /** show-reply-context-on-sent-user-messages: whether a settled mail row's
   *  OWN reply reference can be located in THIS loaded conversation, and
   *  where to scroll if so — the same two facts `DeskChat`'s `renderReply`
   *  already computes for the top-level composing annotation
   *  (`replyAvailable`/`locateReply`), reused here rather than duplicated.
   *  Omitted by callers with no conversation to scroll (mailbox reading
   *  pane, docket, gallery) — the reference/excerpt still render, just not
   *  as a click target, the same graceful degradation `actor` already has. */
  replyAvailable?: (r: ReplyContext) => boolean
  onLocateReply?: (r: ReplyContext) => void }
export function SegmentList({ segments, profile, slug, nid, world, onOpen, actor,
  replyAvailable, onLocateReply }: SegmentProps) {
  const base = fileBase(slug, nid)
  const card = (row: unknown, preview: boolean, part?: "header" | "body", headerMeta?: ReactNode) => <EventCard row={row} profile={profile} org={slug}
    preview={preview} part={part} headerMeta={headerMeta} world={world} onOpen={onOpen} actor={actor} imgBase={base} />
  return <div className="turn-mail-batch">{segments.map((segment, i) => {
    switch (segment.kind) {
      case 'text': return <RefMdBody key={i} className="msg user msgtext md" html={md(segment.text, base)} world={world} onOpen={onOpen} />
      case 'state': case 'drive': {
        const row = 'event' in segment ? { ev: segment.event, text: segment.text }
          : 'event_public' in segment ? { ev_public: segment.event_public, text: segment.text }
          : { text: segment.text, ...(segment.ev_error ? { ev_error: segment.ev_error } : {}) }
        const decoded = decodeEventRow(row, profile)
        if (decoded.kind === 'known' && !humanSegmentEvent(decoded.event)) return null
        return <div key={i} className={'event-segment-' + segment.kind}>{card(row, false)}</div>
      }
      case 'notices': return <div key={i} className="event-notices">{segment.rows.map((row, j) => <div key={j}>
        {card(row, false, undefined, <time className="event-time">{fmtFull(row.at)}</time>)}</div>)}</div>
      case 'mail': return <div key={i} className="event-mail">{segment.rows.map((row, j) =>
        <MailMessage key={row.id ?? j} row={row} profile={profile} slug={slug} nid={nid}
          world={world} onOpen={onOpen} actor={actor}
          replyAvailable={replyAvailable} onLocateReply={onLocateReply} />)}</div>
    }
    const unhandled: never = segment
    return unhandled
  })}</div>
}

/** Pending and delivered mail share the same card, metadata and attachments. */
export function MailMessage({ row, profile, slug, nid, world, onOpen, actor,
  replyAvailable, onLocateReply }: Omit<SegmentProps, 'segments'> & { row: {
    id?: string | null; from: string; kind?: string; body: string; at: string;
    relationship?: string | null; attachments?: unknown[]; attachments_missing?: string[];
    reply_to?: unknown; ev?: unknown; ev_public?: unknown; ev_raw?: unknown; ev_error?: unknown;
  } }) {
  const base = fileBase(slug, nid)
  const card = (value: unknown, preview: boolean, part?: "header" | "body") =>
    <EventCard row={value} profile={profile} org={slug} preview={preview} part={part}
      world={world} onOpen={onOpen} actor={actor} imgBase={base} />
  return <section
        {...eventSurface(row, profile)} className={'turn-mail ' + eventSurface(row, profile).className + (row.kind === 'notice' ? ' passive' : '')} data-mail-id={row.id ?? undefined}>
        <header className="turn-mail-head event-head">{card(row, false, "header")}<time>{fmtFull(row.at)}</time>
          {decodeEventRow(row, profile).kind !== 'known' && <>
            {/* label-subordinate-messages-and-link-their-sender: an untyped
                row (most agent-to-agent mail — plain body, no schema'd `ev`)
                used to fall to `<b>{row.from}</b><span>{row.kind}</span>`,
                bare text with neither the model chip/route every OTHER
                sender in this app wears (identity.tsx's `AgentName`, wired
                everywhere via `actor`) nor a badge for its type — the exact
                two things `card`'s known-event heading draws for free
                (`event-actor`, and `.event-row-kind` per mail.tsx's list
                row). Same classes, same look, whether or not this row ever
                got a typed event. */}
            <span className="event-actor">{actor ? actor(row.from) : row.from}</span>
            <span className="event-row-kind">{row.kind}</span>
          </>}
          {row.relationship && <span>{row.relationship}</span>}
          {row.kind === 'notice' && <span className="turn-mail-passive">no reply expected</span>}
        </header>
        {/* show-reply-context-on-sent-user-messages: the row's OWN reply
            reference (this row is itself a reply to something), distinct
            from — and rendered independently of — the live composing
            annotation (`.reply-preview`, no `-composing` modifier here, so
            it keeps its ordinary read-only shape). The backend already
            threads `reply_to` this far (ledger.post_mail -> journal_row ->
            _segments_for's mail rows), it was simply never rendered. */}
        {(() => { const rc = replyContext(row.reply_to)
          return rc && <ReplyPreview reply={rc} available={Boolean(replyAvailable?.(rc))}
            onLocate={() => onLocateReply?.(rc)} /> })()}
        {card(row, true, "body")}<SegmentAttachments values={row.attachments} slug={slug} nid={nid}/>
        {row.attachments_missing?.map((name,k)=><div key={k} className="dim">Attachment unavailable: {name}</div>)}
  </section>
}

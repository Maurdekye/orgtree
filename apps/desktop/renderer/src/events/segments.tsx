import { HUMAN_HIDDEN_VARIANTS } from '../generated/events'
import type { ReactNode } from 'react'
import type { Event, PublicEvent, Segment, PublicSegment } from '../generated/events'
import { decodeEventRow, isAuthoredUser, record } from './decode'
import type { EventProfile } from './decode'
import { EventCard, eventSurface } from './card'
import { eventSummary } from './project'
import { RefMdBody } from '../canvas/refmd'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import { md } from '../canvas/shared'
import { fileBase, fileUrl } from '../api'
import { AttachThumb, fmtBytes, isImg } from '../canvas/img'
import { DownloadIcon } from '../icons'
import { fmtFull } from '../timefmt'

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
  world?: RefWorld | null; onOpen?: (ref: ResolvedRef) => void; actor?: (id: string) => ReactNode }
export function SegmentList({ segments, profile, slug, nid, world, onOpen, actor }: SegmentProps) {
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
      case 'mail': return <div key={i} className="event-mail">{segment.rows.map((row, j) => <section key={row.id ?? j}
        {...eventSurface(row, profile)} className={'turn-mail ' + eventSurface(row, profile).className + (row.kind === 'notice' ? ' passive' : '')} data-mail-id={row.id}>
        <header className="turn-mail-head event-head">{card(row, false, "header")}<time>{fmtFull(row.at)}</time>
          {decodeEventRow(row, profile).kind !== 'known' && <><b>{row.from}</b><span>{row.kind}</span></>}
          {row.relationship && <span>{row.relationship}</span>}
          {row.kind === 'notice' && <span className="turn-mail-passive">no reply expected</span>}
        </header>
        {card(row, true, "body")}<SegmentAttachments values={row.attachments} slug={slug} nid={nid}/>
        {row.attachments_missing?.map((name,k)=><div key={k} className="dim">Attachment unavailable: {name}</div>)}
      </section>)}</div>
    }
    const unhandled: never = segment
    return unhandled
  })}</div>
}

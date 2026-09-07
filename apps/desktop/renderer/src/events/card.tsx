import type { ReactNode } from 'react'
import type { Event, PublicEvent, Family } from '../generated/events'
import { decodeEventRow } from './decode'
import { fieldType, humanValue } from './value'
import type { HumanValue } from './value'
import type { EventProfile } from './decode'
import { projectEvent } from './project'
import type { EventField, KnownEvent } from './project'
import { RefMdBody } from '../canvas/refmd'
import { ReceivedMailBody } from '../canvas/mailpreview'
import { RefChip, resolveRef } from '../canvas/reflinks'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import type { TypedRef } from '../canvas/workrefs'
import { md } from '../canvas/shared'

const FAMILY_MARK: Record<Family, string> = {
  ordinary: 'Message', linked_reply: 'Reply', assignment: 'Assignment', review: 'Review',
  status: 'Status', answer_decision: 'Answer / decision', access_resources: 'Access / resources',
  lifecycle: 'Agent lifecycle', monitor: 'Monitor', runtime_recovery: 'Runtime',
  reminder: 'Reminder', context_change: 'Context / change',
}
const FAMILY_ICON: Record<Family, string> = {
  ordinary: '·', linked_reply: '↩', assignment: '→', review: '✓', status: '●',
  answer_decision: '?', access_resources: '⚿', lifecycle: '◇', monitor: '◉',
  runtime_recovery: '!', reminder: '◷', context_change: '≡',
}
interface ContentProps { world?: RefWorld | null; onOpen?: (r: ResolvedRef) => void; imgBase?: string }
function Text({ text, world, onOpen, imgBase }: ContentProps & { text: string }) {
  return <RefMdBody className="event-prose md" html={md(text, imgBase)} world={world} onOpen={onOpen} />
}

interface ValueProps extends ContentProps { profile: EventProfile; org: string; actor?: (id: string) => ReactNode }
/** Nested events take the same exhaustive path as top-level events. */
function Value({ value, ...props }: ValueProps & { value: HumanValue }): ReactNode {
  switch (value.kind) {
    case 'text': return <Text text={value.text} {...props} />
    case 'scalar': return value.value === null ? <span className="dim">Not recorded</span>
      : <span>{typeof value.value === 'boolean' ? value.value ? 'Yes' : 'No' : value.value}</span>
    case 'list': return value.items.length ? <ul className="event-values">{value.items.map((v,i)=><li key={i}><Value value={v} {...props}/></li>)}</ul>
      : <span className="dim">None</span>
    case 'record': return <dl className="event-record">{value.fields.map(field=><div key={field.key} data-event-field={field.key}>
      <dt>{field.label}</dt><dd><Value value={field.value} {...props}/></dd></div>)}</dl>
    case 'event': return <EventCard {...props} embedded row={props.profile === 'public' ? {ev_public:value.event} : {ev:value.event}}/>
    case 'unavailable': return <span className="dim">Unavailable</span>
  }
  const unhandled: never = value
  return unhandled
}
function Fields({ fields, ...props }: ValueProps & { fields: EventField[] }) {
  return <>{fields.map(f => <div className="event-field" key={f.key} data-event-field={f.key}>
    {fields.length > 1 && <span className="event-field-label">{f.label}</span>}
    <Value value={humanValue(f.value, f.type, props.profile)} {...props} />
  </div>)}</>
}
export function eventReference(event: KnownEvent, enclosingOrg: string): TypedRef | null {
  const object = event.object
  if (!object) return null
  const org = 'org' in object ? object.org : enclosingOrg
  switch (object.kind) {
    case 'work_item': return { kind: 'item', org, id: object.slug }
    case 'document': return { kind: 'doc', org, id: object.id }
    case 'node': return { kind: 'agent', org, id: object.id }
    case 'mail': return { kind: 'mail', org, id: object.id, box: object.box, ...(object.node ? { node: object.node } : {}) }
    case 'ask': case 'batch': case 'credit_request': case 'audience_request':
    case 'watchdog': case 'task': case 'build': case 'org': case 'session': return null
  }
}
function ObjectLabel({ event, org, world, onOpen }: { event: Event | PublicEvent; org: string } & ContentProps) {
  const object = event.object
  if (!object) return null
  const ref = eventReference(event, org)
  if (ref) {
    const resolved = resolveRef(ref, world ?? { org, handles: new Set() })
    // Keep the recorded title when no current authoritative index can name it.
    if ('title' in object && resolved.outcome === 'ready') resolved.label = object.title
    return <RefChip r={resolved} onOpen={onOpen} />
  }
  return <span className="event-object">{'name' in object ? object.name
    : 'description' in object ? object.description : 'short' in object ? object.short
      : 'id' in object ? object.id : 'node' in object ? object.node : org}</span>
}
export interface EventCardProps extends ContentProps {
  row: unknown; profile: EventProfile; org: string; preview?: boolean
  actor?: (id: string) => ReactNode
  part?: "header" | "body"
  headerMeta?: ReactNode
  embedded?: boolean
}
/** The owning message wrapper receives the family treatment; content never adds a panel. */
export function eventSurface(row: unknown, profile: EventProfile) {
  const decoded = decodeEventRow(row, profile)
  return decoded.kind === 'known'
    ? { className: 'event-surface event-card event-' + projectEvent(decoded.event).family,
        'data-event-variant': decoded.event.variant }
    : { className: '', 'data-event-variant': undefined }
}
/** A single presentation path for mailbox, pending/live and settled transcript rows.
 *  Envelope time, delivery badges, attachments and existing actions stay with callers. */
export function EventCard({ row, profile, org, preview = false, actor, part, headerMeta, embedded = false, ...content }: EventCardProps) {
  const decoded = decodeEventRow(row, profile)
  if (decoded.kind !== 'known') {
    if (part === 'header') return null
    const text = <Text text={decoded.fallback} {...content} />
    return <div className="event-fallback">
      {headerMeta && <header className="event-head">{headerMeta}</header>}
      {decoded.kind === 'unsupported' && <span className="event-unsupported">Unsupported message format</span>}
      {preview ? <ReceivedMailBody>{text}</ReceivedMailBody> : text}
    </div>
  }
  const view = projectEvent(decoded.event)
  const event = decoded.event
  // A self-report's subject is its sender. Keep the qualified agent link
  // once, while retaining both identities for reports about someone else.
  const selfStatus = view.family === 'status' && event.actor.kind === 'agent'
    && event.object?.kind === 'node' && event.object.id === event.actor.id
    && (!('org' in event.object) || event.object.org === org)
  const body = view.fields.filter(f => f.placement === 'body')
  const header = view.fields.filter(f => f.placement === 'header')
  const context = view.fields.filter(f => f.placement === 'context')
  const objectValue = event.object ? humanValue(event.object, fieldType(event.variant, 'object'), profile) : null
  const objectDetails = objectValue?.kind === 'record'
    ? { ...objectValue, fields: objectValue.fields.filter(f => f.key !== 'kind') } : null
  const bodyContent = <div className="event-body"><Fields fields={body} {...content} profile={profile} org={org} actor={actor} /></div>
  const heading = <>
      <span className="event-family" aria-label={FAMILY_MARK[view.family]} title={FAMILY_MARK[view.family]}>{FAMILY_ICON[view.family]}</span>
      <strong>{view.title}</strong>
      <span className="event-actor" data-actor-kind={event.actor.kind}>
        {selfStatus ? <ObjectLabel event={event} org={org} world={content.world} onOpen={content.onOpen} />
          : event.actor.kind === 'agent' && actor ? actor(event.actor.id)
          : event.actor.kind === 'system' ? 'System' : event.actor.kind === 'user' ? 'User' : event.actor.id}
      </span>
      {!selfStatus && <ObjectLabel event={event} org={org} world={content.world} onOpen={content.onOpen} />}
      {header.map(f => <div className="event-head-field" key={f.key} data-event-field={f.key}>
        <span className="dim">{f.label}: </span><Value value={humanValue(f.value, f.type, profile)} {...content} profile={profile} org={org} actor={actor} />
      </div>)}
    </>
  if (part === 'header') return heading
  const contents = <>
    {body.length > 0 && (preview
      ? <ReceivedMailBody>{bodyContent}</ReceivedMailBody> : bodyContent)}
    {(context.length > 0 || Boolean(objectDetails?.fields.length)) && <details className="event-context">
      <summary>Context</summary>
      {objectDetails && <div className="event-object-details"><Value value={objectDetails} {...content} profile={profile} org={org} actor={actor} /></div>}
      <Fields fields={context} {...content} profile={profile} org={org} actor={actor} />
    </details>}
  </>
  if (part === 'body') return contents
  return <section {...eventSurface(row, profile)} className={embedded ? "event-member event-" + view.family : eventSurface(row, profile).className}>
    <header className="event-head">{heading}{headerMeta}</header>
    {contents}
  </section>
}

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Event, Family } from '../generated/events'
import { decodeEventRow, isNoticeRow, record } from './decode'
import { fieldType, humanValue } from './value'
import type { HumanValue } from './value'
import type { EventProfile } from './decode'
import { projectEvent } from './project'
import type { EventField, KnownEvent } from './project'
import { ReplySelectionText } from '../canvas/replyselection'
import { RefMdBody } from '../canvas/refmd'
import { ReceivedMailBody } from '../canvas/mailpreview'
import { mailFoldKeys } from '../canvas/foldstate'
import type { MailFoldable } from '../canvas/foldstate'
import { RefChip, resolveRef } from '../canvas/reflinks'
import type { RefWorld, ResolvedRef } from '../canvas/reflinks'
import type { TypedRef } from '../canvas/workrefs'
import { md } from '../canvas/shared'
import { WatchdogLink } from '../canvas/watchdoglink'
import { AnsweredAsk, AnsweredCard, ResolvedSections, batchAskQuestions, resolvedSectionKinds } from './answered'
import { StructuredJson } from '../canvas/structuredjson'
import { EXTERNAL_NOTE, EXTERNAL_TAG, appEventParts, fireActionParts, fireLineParts } from './firelines'
import type { FirePart } from './firelines'
import { IdleDocketCards } from './idledocket'
import { HubContactChip, isHubAddress } from '../canvas/agentmentions'

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
  return <ReplySelectionText text={text}><RefMdBody className="event-prose md" html={md(text, imgBase)} world={world} onOpen={onOpen} /></ReplySelectionText>
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
    case 'event': return <EventCard {...props} embedded row={{ev:value.event}}/>
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
function FireParts({ parts, ...props }: ContentProps & { parts: FirePart[] }) {
  return <>{parts.map((p, i) => p.kind === 'json'
    ? <StructuredJson key={i} value={p.value} raw={p.raw} />
    : p.kind === 'literal' ? <div key={i} className="event-prose" style={{whiteSpace:'pre-wrap'}}>{p.text}</div>
    : <Text key={i} text={p.text} {...props} />)}</>
}
type DogFire = Extract<KnownEvent, { variant: 'monitor.watchdog_fired' }>
/** A watchdog fire's body: its lines and fire-action results, with JSON in
 *  them drawn as in tool calls (events/firelines.ts); text stays text. An
 *  mqtt or websocket fire's source is the header's tag, not a body line. */
function FireBody({ event, fields, ...props }: ValueProps & { event: DogFire; fields: EventField[] }) {
  const content = { world: props.world, onOpen: props.onOpen, imgBase: props.imgBase }
  const lines = useMemo(() => event.lines.map(line => event.prefix === 'APP EVENT'
    ? appEventParts(line) : fireLineParts(line, event.source)), [event.lines, event.source, event.prefix])
  const actions = useMemo(() => event.fire_actions ? fireActionParts(event.fire_actions) : [], [event.fire_actions])
  const labelled = fields.filter(f => f.key !== 'source').length > 1
  return <>{fields.map(f => {
    const label = labelled && <span className="event-field-label">{f.label}</span>
    switch (f.key) {
      case 'source': return null
      case 'lines': return <div className="event-field" key={f.key} data-event-field={f.key}>{label}
        <ul className="event-values">{lines.map((parts, i) => <li key={i}><FireParts parts={parts} {...content} /></li>)}</ul></div>
      case 'fire_actions': return <div className="event-field" key={f.key} data-event-field={f.key}>{label}
        <FireParts parts={actions} {...content} /></div>
      default: return <div className="event-field" key={f.key} data-event-field={f.key}>{label}
        <Value value={humanValue(f.value, f.type, props.profile)} {...props} /></div>
    }
  })}</>
}
function WatchdogObjectLabel({ object }: { object: Extract<NonNullable<Event['object']>, { kind: 'watchdog' }> }) {
  return <WatchdogLink id={object.id} owner={object.owner} name={object.name} org={object.org} countdown />
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
function ObjectLabel({ event, org, world, onOpen }: { event: Event; org: string } & ContentProps) {
  const object = event.object
  if (!object) return null
  if (object.kind === 'watchdog') return <WatchdogObjectLabel object={object} />
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
  hideKind?: boolean
  embedded?: boolean
  foldKey?: string | readonly string[]
}
/** The owning message wrapper receives the family treatment; content never adds a panel. */
export function eventSurface(row: unknown, profile: EventProfile) {
  const decoded = decodeEventRow(row, profile)
  const notice = isNoticeRow(row) ? ' event-notice' : ''
  return decoded.kind === 'known'
    ? { className: 'event-surface event-card event-' + projectEvent(decoded.event).family + notice,
        'data-event-variant': decoded.event.variant }
    : { className: notice.trim(), 'data-event-variant': undefined }
}
/** A single presentation path for mailbox, pending/live and settled transcript rows.
 *  Envelope time, delivery badges, attachments and existing actions stay with callers. */
export function EventCard({ row, profile, org, preview = false, actor, part, headerMeta, hideKind = false, embedded = false, foldKey, ...content }: EventCardProps) {
  const keys = foldKey ?? (row && typeof row === 'object' ? mailFoldKeys(row as MailFoldable) : undefined)
  const decoded = decodeEventRow(row, profile)
  if (decoded.kind !== 'known') {
    if (part === 'header') return null
    const text = <Text text={decoded.fallback} {...content} />
    return <div className={'event-fallback' + (!part && isNoticeRow(row) ? ' event-notice' : '')}>
      {headerMeta && <header className="event-head">{headerMeta}</header>}
      {decoded.kind === 'unsupported' && <span className="event-unsupported">Unsupported message format</span>}
      {preview ? <ReceivedMailBody foldKey={keys}>{text}</ReceivedMailBody> : text}
    </div>
  }
  const view = projectEvent(decoded.event)
  const event = decoded.event
  // A self-report's subject is its sender. Keep the qualified agent link
  // once, while retaining both identities for reports about someone else.
  const selfStatus = view.family === 'status' && event.actor.kind === 'agent'
    && event.object?.kind === 'node' && event.object.id === event.actor.id
    && (!('org' in event.object) || event.object.org === org)
  // A watchdog's own fire names the dog once, by its name: a new dog's name
  // is its id (D67), and an older dog's random id stays out of the header.
  const selfDog = event.actor.kind === 'watchdog' && event.object?.kind === 'watchdog'
    && event.object.id === event.actor.id
  // Answered questions draw as a shrunken question card instead of a field dump.
  const answeredAsk = event.variant === 'answer.ask'
  const resolvedBatch = event.variant === 'answer.batch'
  const askQuestions = event.variant === 'answer.batch' ? batchAskQuestions(event) : []
  // a watchdog fire draws its whole body itself (FireBody)
  const dogFire = event.variant === 'monitor.watchdog_fired' ? event : null
  const fireFields = dogFire ? view.fields.filter(f => f.placement === 'body') : []
  // the idle-docket reminder draws its items as ticket cards (IdleDocketCards)
  const idleDocket = event.variant === 'reminder.idle_docket' ? event : null
  const body = view.fields.filter(f => f.placement === 'body' && !dogFire && !(idleDocket && f.key === 'items')
    && !(answeredAsk && ['questions', 'text'].includes(f.key)))
    .map(f => f.key === 'sections' && Array.isArray(f.value)
      ? { ...f, value: f.value.filter(sec => !(record(sec) && typeof sec.kind === 'string' && resolvedSectionKinds.includes(sec.kind))) } : f)
    .filter(f => !(f.key === 'sections' && Array.isArray(f.value) && f.value.length === 0))
  // The mini card says answered/dismissed and how many questions itself.
  const header = view.fields.filter(f => f.placement === 'header'
    && !(answeredAsk && (f.key === 'single' || (f.key === 'dismissed' && f.value === false))))
  const context = view.fields.filter(f => f.placement === 'context')
  const objectValue = event.object ? humanValue(event.object, fieldType(event.variant, 'object'), profile) : null
  const objectDetails = objectValue?.kind === 'record'
    ? { ...objectValue, fields: objectValue.fields.filter(f => f.key !== 'kind') } : null
  const bodyContent = <div className="event-body">
    {event.variant === 'answer.ask' && <AnsweredAsk event={event} {...content} />}
    {askQuestions.length > 0 && <AnsweredCard questions={askQuestions} dismissed={false} {...content} />}
    {event.variant === 'answer.batch' && <ResolvedSections event={event} {...content} />}
    {dogFire && <FireBody event={dogFire} fields={fireFields} {...content} profile={profile} org={org} actor={actor} />}
    {idleDocket && <IdleDocketCards event={idleDocket} org={org} world={content.world} onOpen={content.onOpen} />}
    <Fields fields={body} {...content} profile={profile} org={org} actor={actor} /></div>
  const heading = <>
      {!hideKind && <><span className="event-family" aria-label={FAMILY_MARK[view.family]} title={FAMILY_MARK[view.family]}>{FAMILY_ICON[view.family]}</span>
      <strong>{view.title}</strong></>}
      <span className="event-actor" data-actor-kind={event.actor.kind}>
        {selfStatus || selfDog ? <ObjectLabel event={event} org={org} world={content.world} onOpen={content.onOpen} />
          : event.actor.kind === 'agent' && actor ? actor(event.actor.id)
          // an outside party on the hub is the one Hub contact link on every
          // surface, whatever the surface's agent renderer would draw (USER
          // 2026-10-29 m14ad537c5eb8: header addresses are links too)
          : event.actor.kind === 'external' && isHubAddress(event.actor.id) ? <HubContactChip address={event.actor.id} />
          : event.actor.kind === 'system' ? 'System' : event.actor.kind === 'user' ? 'User' : event.actor.id}
      </span>
      {!selfStatus && !selfDog && <ObjectLabel event={event} org={org} world={content.world} onOpen={content.onOpen} />}
      {header.map(f => <div className="event-head-field" key={f.key} data-event-field={f.key}>
        <span className="dim">{f.label}: </span><Value value={humanValue(f.value, f.type, profile)} {...content} profile={profile} org={org} actor={actor} />
      </div>)}
      {/* not a span: the transcript header's "·" separator (styles.css
          .turn-mail-head > span) would draw inside its border */}
      {dogFire?.source && <small className="event-external" data-event-field="source"
        title={EXTERNAL_NOTE[dogFire.source]}>{EXTERNAL_TAG}</small>}
    </>
  if (part === 'header') return heading
  const contents = <>
    {(body.length > 0 || fireFields.length > 0 || idleDocket || answeredAsk || resolvedBatch) && (preview && !answeredAsk && !resolvedBatch
      ? <ReceivedMailBody foldKey={keys}>{bodyContent}</ReceivedMailBody> : bodyContent)}
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

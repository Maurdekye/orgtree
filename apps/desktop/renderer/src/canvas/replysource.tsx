import type { ReactNode } from 'react'
import type { ReplyContext } from '../eventReply'
import type { ChatMessage, ChatTransient, PendingMail, ToolChip } from '../types'
import type { LiveRow } from './shared'
import type { EventProfile } from '../events/decode'
import type { RefRoutes } from './reflinks'
import { isSegments, MailMessage, SegmentAttachments, SegmentList } from '../events/segments'
import { mailRowCopyText, messageCopyText, segmentsCopyText, toolCallCopyText, toolResultCopyText } from './copytext'
import type { CopyableMailRow } from './copytext'
import { fileBase } from '../api'
import { DotIcon, MailIcon, PsychologyIcon, SparkIcon } from '../icons'
import { fmtFull } from '../timefmt'
import { md } from './shared'
import { RefMdBody } from './refmd'

export type ReplySource =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'mail'; mail: PendingMail }
  | { kind: 'tool-call' | 'tool-result'; tool: ToolChip; at?: string | null }
  | { kind: 'thought'; text: string; sealed?: boolean; secs?: number; at?: string | null }
  | { kind: 'live'; row: LiveRow }
  | { kind: 'transient'; row: ChatTransient }

/** Index data only: rich trees are built for the few referenced sources. The
 * immutable event_id is the key; native/assistant ids identify newer revisions
 * for navigation, but cannot replace the particular source being quoted. */
export function indexReplySources({ messages = [], pending = [], live = [], transient = [],
  draft, draftId, thinking, thinkingId }: {
  messages?: ChatMessage[]; pending?: PendingMail[]; live?: LiveRow[]; transient?: ChatTransient[]
  draft?: string; draftId?: string | null; thinking?: string; thinkingId?: string | null
}): Map<string, ReplySource> {
  const sources = new Map<string, ReplySource>()
  const put = (id: string | null | undefined, source: ReplySource) => {
    if (id && !sources.has(id)) sources.set(id, source)
  }
  for (const message of messages) {
    put(message.event_id, { kind: 'message', message })
    put(message.thinking_event_id, { kind: 'thought', text: message.thinking ?? '',
      sealed: message.thinking_sealed, secs: message.think_secs, at: message.ts })
    for (const tool of message.tools ?? []) if (typeof tool !== 'string') {
      put(tool.event_id, { kind: 'tool-call', tool, at: message.ts })
      put(tool.result_event_id, { kind: 'tool-result', tool, at: message.ts })
    }
    if (isSegments(message.segments, 'operator')) {
      for (const seg of message.segments) {
        if (seg.kind !== 'mail') continue
        for (const row of seg.rows) {
          if (!row.id) continue
          const asMail: PendingMail = {
            ...(row as unknown as PendingMail),
            id: row.id,
            from: row.from,
            kind: row.kind,
            body: row.body,
            at: row.at ?? message.ts ?? '',
          }
          put('mail:' + row.id, { kind: 'mail', mail: asMail })
        }
      }
    }
  }
  for (const mail of pending) {
    put(mail.event_id, { kind: 'mail', mail })
    if (mail.id) put('mail:' + mail.id, { kind: 'mail', mail })
  }
  for (const row of live) {
    put(row.event_id, { kind: 'live', row })
    if (row.kind === 'steered' && isSegments(row.segments, 'operator')) {
      for (const seg of row.segments) {
        if (seg.kind !== 'mail') continue
        for (const m of seg.rows) {
          if (!m.id) continue
          const asMail: PendingMail = {
            ...(m as unknown as PendingMail),
            id: m.id,
            from: m.from,
            kind: m.kind,
            body: m.body,
            at: m.at ?? row.at ?? '',
          }
          put('mail:' + m.id, { kind: 'mail', mail: asMail })
        }
      }
    }
  }
  // Direct stream state is more recent than a poll with that same snapshot.
  if (draftId) put(draftId, { kind: 'transient', row: {
    event_id: draftId, role: 'assistant', kind: 'draft', text: draft ?? '' } })
  if (thinkingId) put(thinkingId, { kind: 'thought', text: thinking ?? '', sealed: !thinking })
  for (const row of transient) put(row.event_id, { kind: 'transient', row })
  return sources
}

/** Extract the full copyable body of a resolved reply source. */
export function replySourceCopyText(source: ReplySource | undefined, profile: EventProfile = 'operator'): string {
  if (!source) return ''
  switch (source.kind) {
    case 'message': return messageCopyText(source.message, profile)
    case 'mail': return mailRowCopyText(source.mail as CopyableMailRow, profile)
    case 'thought': return source.sealed ? '' : (source.text ?? '')
    case 'tool-call': return toolCallCopyText(source.tool)
    case 'tool-result': return toolResultCopyText(source.tool)
    case 'live': {
      const r = source.row
      if (r.kind === 'steered' && isSegments(r.segments, profile)) {
        return segmentsCopyText(r.segments, profile)
      }
      if (r.plan) {
        const steps = r.plan.map(s => `${s.status.replaceAll('_', ' ')}: ${s.step}`).join('\n')
        return r.explanation ? `${r.explanation}\n\n${steps}` : steps
      }
      if (r.todos) {
        return r.todos.map(t => `${t.status.replaceAll('_', ' ')}: ${t.content}`).join('\n')
      }
      return r.text ?? ''
    }
    case 'transient': return source.row.text ?? ''
  }
}

/** Extract the underlying mail row when a reply source represents mail. */
export function replySourceMailRow(source: ReplySource | undefined, mailId?: string): CopyableMailRow | null {
  if (!source) return null
  if (source.kind === 'mail') return source.mail as CopyableMailRow
  const matchFromSegments = (segments: unknown): CopyableMailRow | null => {
    if (!isSegments(segments, 'operator')) return null
    const rows = segments.flatMap(s => s.kind === 'mail' ? s.rows : [])
    if (!rows.length) return null
    if (mailId) {
      const found = rows.find(r => r.id === mailId)
      if (found) return found as CopyableMailRow
    }
    return rows.length === 1 ? (rows[0] as CopyableMailRow) : null
  }
  if (source.kind === 'message') return matchFromSegments(source.message.segments)
  if (source.kind === 'live' && source.row.kind === 'steered') return matchFromSegments(source.row.segments)
  return null
}

/** Resolve the sender of the referenced message or mail for the "Sender…" submenu. */
export function replySourceSender(source: ReplySource | undefined, reply: ReplyContext): string | undefined {
  if (reply.sender && reply.sender !== 'system' && reply.sender !== 'SYSTEM' && reply.sender !== '@system') {
    return reply.sender
  }
  const mailId = reply.mailId || (reply.eventId.startsWith('mail:') ? reply.eventId.slice(5) : undefined)
  const mailRow = replySourceMailRow(source, mailId)
  if (mailRow?.from && mailRow.from !== 'system' && mailRow.from !== 'SYSTEM' && mailRow.from !== '@system') {
    return mailRow.from
  }
  if (source?.kind === 'message') {
    if (source.message.role === 'assistant') return reply.agent || undefined
    if (source.message.role === 'user') return '@user'
  }
  if (source?.kind === 'live' && source.row.kind === 'text' && !source.row.cmd_output) {
    return reply.agent || undefined
  }
  return undefined
}

/** Shares the transcript's validated event rendering and human-context filter.
 * It has no message anchors, nested reply annotations, or delivery actions. */
export function ReplySourceContent({ source, slug, nid, profile, refs, actor }: {
  source: ReplySource; slug: string; nid: string; profile: EventProfile
  refs?: RefRoutes; actor?: (id: string) => ReactNode
}) {
  const props = { slug, nid, profile, world: refs?.world, onOpen: refs?.onOpen, actor, annotation: true }
  const prose = (text: string) => text
    ? <RefMdBody className="md" html={md(text, fileBase(slug, nid))} world={refs?.world} onOpen={refs?.onOpen} />
    : <span className="dim">(event without visible text)</span>
  const header = (label: string, at?: string | null, icon: ReactNode = <DotIcon fontSize="inherit" />) =>
    <div className="reply-source-meta">{icon}<strong>{label}</strong>
      {at && <time dateTime={at}>{fmtFull(at)}</time>}</div>
  const thought = (text: string, sealed?: boolean, secs?: number, at?: string | null) => <>
    {header('Thinking', at, <PsychologyIcon fontSize="inherit" />)}
    {secs != null && <span className="dim">{secs}s</span>}
    {text ? prose(text) : <span className="dim">{sealed ? 'Thinking text unavailable' : '(no thinking text recorded)'}</span>}
  </>
  const plan = (steps: { step: string; status: string }[], explanation?: string | null) => <>
    {explanation && prose(explanation)}
    <ol className="reply-source-plan">{steps.map((step, i) => <li key={i}>
      <span className="dim">{step.status.replaceAll('_', ' ')}: </span>{step.step}</li>)}</ol>
  </>
  const truncated = (cut?: boolean) => cut && <div className="trunc-note">Source shown truncated</div>
  switch (source.kind) {
    case 'message': {
      const m = source.message
      return <>
        {header(m.codexPlan ? 'Plan' : m.role === 'assistant' ? 'Assistant message'
          : m.role === 'user' ? 'User turn' : m.role === 'system' ? 'System event' : 'Event', m.ts,
          m.role === 'assistant' ? <SparkIcon fontSize="inherit" /> : <MailIcon fontSize="inherit" />)}
        {m.role === 'user' && isSegments(m.segments, profile)
          ? <SegmentList {...props} segments={m.segments} />
          : m.codexPlan ? plan(m.codexPlan.steps, m.codexPlan.explanation)
            : m.role === 'system' ? <>{prose(m.cmd_out || m.text)}{m.summary && <details><summary>Summary</summary>{prose(m.summary)}</details>}</>
              : prose(m.text)}
        {truncated(m.truncated)}
        {m.steered && m.receipt && <div className="trunc-note">{m.receipt}</div>}
      </>
    }
    case 'mail': return <MailMessage {...props} row={source.mail} />
    case 'thought': return thought(source.text, source.sealed, source.secs, source.at)
    case 'tool-call': return <>
      {header('Tool call', source.at)}<strong className="mono">{source.tool.name}</strong>
      {source.tool.arg && <pre>{source.tool.arg}</pre>}
    </>
    case 'tool-result': {
      const t = source.tool
      return <>
        {header('Tool result', source.at)}<strong className="mono">{t.name}</strong>
        {t.error && <div className="desk-error">{t.error}</div>}
        {t.diff ? <><span className="dim"> +{t.diff.plus} / −{t.diff.minus}</span>
          <pre className="diffpre">{t.diff.lines.map((line, i) => <div key={i}
            className={line.startsWith('@@') ? 'dhunk' : line.startsWith('+') ? 'dplus' : line.startsWith('-') ? 'dminus' : undefined}>{line || '\u00a0'}</div>)}</pre>
          {truncated(t.diff.truncated)}</> : t.result && <pre>{t.result}</pre>}
        {truncated(t.truncated)}
        {t.file && <><SegmentAttachments {...props} values={[t.file]} />{t.file.note && prose(t.file.note)}</>}
        {t.presentation && <div>Document: <strong>{t.presentation.title}</strong></div>}
        {(t.images ?? 0) > 0 && t.id && Array.from({ length: t.images! }, (_, i) =>
          <img key={i} className="toolimg" alt="tool result" src={`/api/orgs/${slug}/nodes/${nid}/toolimg/${t.id}?idx=${i}`} />)}
      </>
    }
    case 'live': {
      const r = source.row
      if (r.kind === 'thought') return thought(r.text, !r.text, r.secs, r.at)
      return <>
        {header(r.plan ? 'Plan' : r.todos ? 'Checklist' : r.kind === 'steered' ? 'User turn'
          : r.kind === 'tool' ? 'Tool call' : r.kind === 'text' && !r.cmd_output ? 'Assistant message' : 'Event', r.at)}
        {r.kind === 'steered' && isSegments(r.segments, profile) ? <SegmentList {...props} segments={r.segments} />
          : r.plan ? plan(r.plan, r.explanation)
            : r.todos ? plan(r.todos.map(t => ({ step: t.content, status: t.status })))
              : r.kind === 'tool' ? <pre>{r.text}</pre> : prose(r.text)}
        {truncated(r.truncated)}
      </>
    }
    case 'transient': {
      const r = source.row
      if (['thinking', 'thinking_start', 'thought'].includes(r.kind)) return thought(r.text, !r.text)
      return <>{header(r.role === 'assistant' ? 'Assistant message' : r.kind === 'error' ? 'Error' : 'Event')}{prose(r.text)}</>
    }
  }
}

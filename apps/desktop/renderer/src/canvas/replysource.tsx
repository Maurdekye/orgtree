import type { ReactNode } from 'react'
import type { ChatMessage, ChatTransient, PendingMail, ToolChip } from '../types'
import type { LiveRow } from './shared'
import type { EventProfile } from '../events/decode'
import type { RefRoutes } from './reflinks'
import { isSegments, MailMessage, SegmentAttachments, SegmentList } from '../events/segments'
import { BASE, fileBase } from '../api'
import { DotIcon, MailIcon, PsychologyIcon, SparkIcon } from '../icons'
import { fmtFull } from '../timefmt'
import { md } from './shared'
import { RefMdBody } from './refmd'

type ReplySource =
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
  }
  for (const mail of pending) put(mail.event_id, { kind: 'mail', mail })
  for (const row of live) put(row.event_id, { kind: 'live', row })
  // Direct stream state is more recent than a poll with that same snapshot.
  if (draftId) put(draftId, { kind: 'transient', row: {
    event_id: draftId, role: 'assistant', kind: 'draft', text: draft ?? '' } })
  if (thinkingId) put(thinkingId, { kind: 'thought', text: thinking ?? '', sealed: !thinking })
  for (const row of transient) put(row.event_id, { kind: 'transient', row })
  return sources
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
          <img key={i} className="toolimg" alt="tool result" src={`${BASE}/api/orgs/${slug}/nodes/${nid}/toolimg/${t.id}?idx=${i}`} />)}
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

import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import type { Segment } from '../generated/events'
import { HUMAN_HIDDEN_VARIANTS } from '../generated/events'
import type { ChatMessage } from '../types'
import { decodeEventRow, record } from './decode'
import { isSegments } from './wire'
import { projectEvent } from './project'
import { isSystemNotice } from '../canvas/shared'

export interface SystemEntry { key: string; system: boolean; label: string; restart?: boolean }
const hidden = new Set<string>(HUMAN_HIDDEN_VARIANTS)
const prompts = new Set(['ordinary.question', 'ask.routed', 'access.scope_requested',
  'access.audience_requested', 'docket.review_seat_requested'])

/** Same passive SYSTEM-only rule as the inbox. Notice-segment rows omit
 * envelope sender/delivery; only their validated event supplies authorship.
 * Unknown notice rows have no proven sender and remain visible. */
export function systemEntry(row: unknown, passiveContainer = false): Omit<SystemEntry, 'key'> {
  if (!record(row)) return { system: false, label: '' }
  const decoded = decodeEventRow(row, 'operator')
  const event = decoded.kind === 'known' ? decoded.event : null
  const waiting = !!(row._ask || row._wait || row.ask || row.approval)
    || row.kind === 'question' || (event && prompts.has(event.variant))
  const tools = Array.isArray(row.tools) && row.tools.length > 0
  const from = typeof row.from === 'string' ? row.from
    : event?.engine_authored ? '@system' : ''
  return {
    system: !waiting && !tools && !row.cmd_out && event?.engine_authored !== false
      && isSystemNotice({ id: '', from, kind: typeof row.kind === 'string' ? row.kind : 'message', ev: event,
        notice: typeof row.notice === 'boolean' ? row.notice : passiveContainer ? true : undefined,
        body: '', at: '' }),
    label: event ? projectEvent(event).title : 'System notice',
    restart: event?.variant === 'context.drive_restart_interrupted' || event?.variant === 'runtime.restart_notice',
  }
}

export interface SegmentEntry extends SystemEntry { segment: Segment }
/** Flatten presentation only, retaining row order and each original wire row. */
export function segmentEntries(segments: Segment[]): SegmentEntry[] {
  return segments.flatMap((segment, i): SegmentEntry[] => {
    if (segment.kind === 'mail' || segment.kind === 'notices') return segment.rows.map((row, j) => ({
      key: `${i}/${'id' in row && row.id ? row.id : j}`,
      ...systemEntry(row, segment.kind === 'notices'),
      segment: { ...segment, rows: [row] } as Segment,
    }))
    if (segment.kind === 'text') return [{ key: String(i), system: false, label: '', segment }]
    const row = 'event' in segment ? { ev: segment.event, text: segment.text } : { text: segment.text }
    const decoded = decodeEventRow(row, 'operator')
    if (decoded.kind === 'known' && hidden.has(decoded.event.variant)) return []
    return [{ key: String(i), ...systemEntry(row), segment }]
  })
}

export interface TranscriptEntry extends SystemEntry { message: ChatMessage; sourceIndex: number; first: boolean }
export function transcriptEntries(messages: ChatMessage[]): TranscriptEntry[] {
  return messages.flatMap((message, sourceIndex): TranscriptEntry[] => {
    const key = String(message.assistant_id ?? message.native_event_id ?? message.row_id
      ?? message.event_id ?? message.seq ?? sourceIndex)
    if (message.role === 'user' && isSegments(message.segments, 'operator')) {
      const parts = segmentEntries(message.segments)
      if (!parts.length && (message.truncated || (message.steered && message.receipt)))
        return [{ key, sourceIndex, first: true, message, system: false, label: '' }]
      return parts.map((part, i) => ({ ...part, key: `${key}/${part.key}`, sourceIndex, first: i === 0,
        message: { ...message, segments: [part.segment],
          truncated: i === parts.length - 1 && message.truncated,
          steered: i === parts.length - 1 && message.steered },
      }))
    }
    return [{ key, sourceIndex, first: true, message,
      ...(message.role === 'system' ? systemEntry(message) : { system: false, label: '' }) }]
  })
}

export function systemRuns<T extends SystemEntry>(entries: T[]): T[][] {
  const runs: T[][] = []
  for (const entry of entries) {
    const last = runs[runs.length - 1]
    if (entry.system && last?.[0].system) last.push(entry)
    else runs.push([entry])
  }
  return runs
}

function SystemRun({ entries, children, onToggle }: {
  entries: SystemEntry[]; children: ReactNode; onToggle?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = entries.length > 1
  const kinds = [...new Set(entries.map(e => e.label))].join(' · ')
  // Keep the wrapper even for one entry: crossing the threshold cannot
  // remount cards, discard a nested fold, or lose a reply anchor.
  return <details className={'transcript-system-run' + (entries.some(e => e.restart) ? ' has-restart' : '')}
    open={!collapsible || expanded} onToggle={e => {
      if (e.target !== e.currentTarget) return
      if (collapsible) setExpanded(e.currentTarget.open)
      onToggle?.()
    }}>
    <summary hidden={!collapsible} className="mailrow sysnotice notepile notice"
      aria-label={`${entries.length} system notices: ${kinds}`}>
      <span className="noticekind">{entries.length} system notices</span>{' '}
      <span className="system-run-kinds" title={kinds}>{kinds}</span>
    </summary>
    <div className="system-run-rows">{children}</div>
  </details>
}

export function SystemRuns<T extends SystemEntry>({ entries, render, onToggle }: {
  entries: T[]; render: (entry: T) => ReactNode; onToggle?: () => void
}) {
  return <>{systemRuns(entries).map(run => run[0].system
    ? <SystemRun key={run[0].key} entries={run} onToggle={onToggle}>
      {run.map(entry => <Fragment key={entry.key}>{render(entry)}</Fragment>)}
    </SystemRun>
    : <Fragment key={run[0].key}>{render(run[0])}</Fragment>)}</>
}

export function revealSystemRuns(element: HTMLElement): void {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches('details.transcript-system-run')) (parent as HTMLDetailsElement).open = true
  }
}

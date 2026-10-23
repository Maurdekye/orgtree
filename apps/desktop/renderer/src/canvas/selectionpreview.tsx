import { useState } from 'react'
import { readReplySource } from '../api'
import type { SelectionDraft, SourceIdentity, SelectionSnapshot } from '../replySelection'
import { ReplyPreviewFrame } from './replypreview'
import { ReplyIcon } from '../icons'

export function SelectionReplyPreview({ target, snapshot, onRemove, onLocate }: {
  target: SourceIdentity; snapshot: SelectionSnapshot; onRemove?: () => void; onLocate?: () => void
}) {
  const [state, setState] = useState('Captured excerpt')
  const [checking, setChecking] = useState(false)
  const org = typeof target === 'string' ? '' : 'source_event_ref' in target ? target.source_event_ref.org : target.org
  const check = () => {
    if (!org || checking) return
    setChecking(true)
    const { projection: _projection, unit: _unit, expected_sha256: _hash, start: _start, end: _end, ...part } = snapshot.selector
    void readReplySource(org, target, part, { selection: snapshot }).then(current => {
      const status = current.location?.state
      setState(status === 'exact' ? 'Source unchanged' : status === 'relocated' ? 'Passage relocated'
        : status === 'changed' ? 'Source changed' : 'Source unavailable')
      if (status === 'exact' || status === 'relocated') onLocate?.()
    }).catch(() => setState('Source unavailable')).finally(() => setChecking(false))
  }
  return <ReplyPreviewFrame label={onRemove ? 'Replying to selection' : 'Selection reply'} onRemove={onRemove}
    action={<><ReplyIcon fontSize="inherit" /><span>Selection · {snapshot.selector.part}</span></>}
    onActivate={org ? check : undefined} actionTitle={org ? 'Check the current source and open it when the passage is verified' : undefined}>
    <blockquote className="selection-excerpt" style={{ whiteSpace: 'pre-wrap' }}>{snapshot.excerpt}</blockquote>
    {(snapshot.prefix || snapshot.suffix) && <details className="selection-context"><summary>Nearby context</summary>
      <div style={{ whiteSpace: 'pre-wrap' }}>{snapshot.prefix}<mark>{snapshot.excerpt}</mark>{snapshot.suffix}</div>
    </details>}
    <span className="dim" role="status">{checking ? 'Checking source…' : state}</span>
  </ReplyPreviewFrame>
}

export function SelectionDrafts({ selections, onRemove, onClear }: { selections: SelectionDraft[]; onRemove: (index: number) => void; onClear: () => void }) {
  return selections.length ? <div className="selection-drafts">
    {selections.map((selection, index) => <SelectionReplyPreview key={JSON.stringify([selection.target,selection.selection])}
      target={selection.target} snapshot={selection.snapshot} onRemove={() => onRemove(index)} />)}
    <button type="button" onClick={onClear}>Cancel all selections</button>
  </div> : null
}

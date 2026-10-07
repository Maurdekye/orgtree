import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ReplyContext } from '../eventReply'
import { ObjectMenuBoundary } from './contextmenu'
import { ReplyIcon } from '../icons'

/** The loaded conversation resolves exact reply snapshots, never text or a
 * newer revision of the same assistant message. Other surfaces keep quotes. */
const ReplySources = createContext<((reply: ReplyContext) => ReactNode) | null>(null)
export const ReplySourceProvider = ReplySources.Provider

/** The same annotation frame for transcript references and stored mail snapshots. */
export function ReplyPreviewFrame({ label, action, onRemove, children, unavailable }: {
  label: string; action: ReactNode; onRemove?: () => void; children: ReactNode; unavailable?: string
}) {
  return <aside className={'reply-preview' + (onRemove ? ' reply-preview-composing' : '')} aria-label={label}>
    <div className="reply-preview-head">
      {action}
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    {children}
    {unavailable && <span className="dim">{unavailable}</span>}
  </aside>
}

export function ReplyPreview({ reply, available, onLocate, onRemove }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
}) {
  // Composer, pending and sent replies share one annotation layout. Only
  // the composer supplies onRemove; read-only previews retain navigation.
  const resolve = useContext(ReplySources)
  const source = resolve?.(reply)
  return <ReplyPreviewFrame label="Replying to chat event" onRemove={onRemove}
    unavailable={!available ? (source ? 'Original event is not visible in this conversation.'
      : 'Original event unavailable here; quoted context is retained.') : undefined}
    action={
      <button className="reply-preview-jump" type="button" onClick={onLocate} disabled={!available}
        aria-label="jump to message"
        title={available ? 'Show the original event' : 'Original event is not in this loaded conversation'}>
        <ReplyIcon className="reply-preview-jump-icon" aria-hidden="true" focusable="false" fontSize="inherit" />
        <span>jump to message</span>
      </button>}>
    {source ? <ObjectMenuBoundary className="reply-preview-content" role="region" aria-label="Referenced event" tabIndex={0}
      onContextMenu={e => e.stopPropagation()}>{source}</ObjectMenuBoundary>
      : <blockquote>{reply.quote || '(event without visible text)'}</blockquote>}
  </ReplyPreviewFrame>
}

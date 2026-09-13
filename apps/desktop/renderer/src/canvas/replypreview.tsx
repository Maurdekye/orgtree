import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ReplyContext } from '../eventReply'
import { ObjectMenuBoundary } from './contextmenu'
import { ReplyIcon } from '../icons'

/** The loaded conversation resolves exact reply snapshots, never text or a
 * newer revision of the same assistant message. Other surfaces keep quotes. */
const ReplySources = createContext<((reply: ReplyContext) => ReactNode) | null>(null)
export const ReplySourceProvider = ReplySources.Provider

export function ReplyPreview({ reply, available, onLocate, onRemove }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
}) {
  // Composer, pending and sent replies share one annotation layout. Only
  // the composer supplies onRemove; read-only previews retain navigation.
  const composing = Boolean(onRemove)
  const resolve = useContext(ReplySources)
  const source = resolve?.(reply)
  return <aside className={'reply-preview' + (composing ? ' reply-preview-composing' : '')}
    aria-label="Replying to chat event">
    <div className="reply-preview-head">
      <button className="reply-preview-jump" type="button" onClick={onLocate} disabled={!available}
        aria-label="jump to message"
        title={available ? 'Show the original event' : 'Original event is not in this loaded conversation'}>
        <ReplyIcon className="reply-preview-jump-icon" aria-hidden="true" focusable="false" fontSize="inherit" />
        <span>jump to message</span>
      </button>
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    {source ? <ObjectMenuBoundary className="reply-preview-content" role="region" aria-label="Referenced event" tabIndex={0}
      onContextMenu={e => e.stopPropagation()}>{source}</ObjectMenuBoundary>
      : <blockquote>{reply.quote || '(event without visible text)'}</blockquote>}
    {!available && <span className="dim">{source ? 'Original event is not visible in this conversation.'
      : 'Original event unavailable here; quoted context is retained.'}</span>}
  </aside>
}

import type { ReplyContext } from '../eventReply'

export function ReplyPreview({ reply, available, onLocate, onRemove }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
}) {
  // Composer, pending and sent replies share one annotation layout. Only
  // the composer supplies onRemove; read-only previews retain navigation.
  const composing = Boolean(onRemove)
  return <aside className={'reply-preview' + (composing ? ' reply-preview-composing' : '')}
    aria-label="Replying to chat event">
    <div className="reply-preview-head">
      <button type="button" onClick={onLocate} disabled={!available}
        title={available ? 'Show the original event' : 'Original event is not in this loaded conversation'}>
        Reply to {reply.agent} · generation {reply.generation}
      </button>
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    <blockquote>{reply.quote || '(event without visible text)'}</blockquote>
    {!available && <span className="dim">Original event unavailable here; quoted context is retained.</span>}
  </aside>
}
